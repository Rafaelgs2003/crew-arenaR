(() => {
  "use strict";

  const PROGRESS_KEY = "buscaminas-progreso-v1";

  /** Dificultades del modo libre. */
  const DIFFICULTIES = {
    facil: { label: "Fácil", rows: 9, cols: 9, mines: 10 },
    medio: { label: "Medio", rows: 16, cols: 16, mines: 40 },
    dificil: { label: "Difícil", rows: 16, cols: 30, mines: 99 },
  };

  /** Niveles de la campaña: el tablero y las minas crecen con cada nivel. */
  const LEVELS = [
    { rows: 8, cols: 8, mines: 8 },
    { rows: 8, cols: 8, mines: 10 },
    { rows: 9, cols: 9, mines: 12 },
    { rows: 10, cols: 10, mines: 15 },
    { rows: 10, cols: 10, mines: 18 },
    { rows: 12, cols: 12, mines: 22 },
    { rows: 12, cols: 12, mines: 26 },
    { rows: 14, cols: 14, mines: 32 },
    { rows: 15, cols: 15, mines: 38 },
    { rows: 16, cols: 16, mines: 45 },
  ];

  const $ = (id) => document.getElementById(id);
  const ui = {
    board: $("board"),
    minesLeft: $("mines-left"),
    timer: $("timer"),
    face: $("face"),
    info: $("info"),
    message: $("message"),
    tabs: document.querySelectorAll(".tab"),
    levelPanel: $("level-panel"),
    levelList: $("level-list"),
    resetProgress: $("reset-progress"),
    freePanel: $("free-panel"),
    difficulty: $("difficulty"),
    newFree: $("new-free"),
    flagToggle: $("flag-toggle"),
    restart: $("restart"),
    overlay: $("overlay"),
    overlayTitle: $("overlay-title"),
    overlayText: $("overlay-text"),
    overlayPrimary: $("overlay-primary"),
    overlayClose: $("overlay-close"),
  };

  const state = {
    mode: "niveles",
    level: 1,
    game: null,
    flagMode: false,
    timerId: null,
    overlayAction: null,
    progress: loadProgress(),
  };

  /* ---------- Progreso (localStorage) ---------- */

  function loadProgress() {
    const fallback = { unlocked: 1, best: {} };
    try {
      const data = JSON.parse(localStorage.getItem(PROGRESS_KEY));
      if (data && Number.isInteger(data.unlocked) && data.best && typeof data.best === "object") {
        return data;
      }
    } catch {
      /* datos corruptos: se usa el valor por defecto */
    }
    return fallback;
  }

  function saveProgress() {
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(state.progress));
    } catch {
      /* almacenamiento no disponible: el progreso sólo dura la sesión */
    }
  }

  /* ---------- Modelo del juego ---------- */

  function createGame({ rows, cols, mines }, { label, bestKey, levelNo }) {
    const total = rows * cols;
    return {
      rows,
      cols,
      total,
      mines,
      label,
      bestKey,
      levelNo,
      mine: new Uint8Array(total),
      count: new Uint8Array(total),
      revealed: new Uint8Array(total),
      flagged: new Uint8Array(total),
      minesPlaced: false,
      revealedSafe: 0,
      state: "playing", // "playing" | "won" | "lost"
      hitIndex: -1,
      startTime: 0,
      elapsed: 0,
      endShown: false,
    };
  }

  /** Índices de las casillas vecinas (hasta 8) de la casilla i. */
  function neighbors(g, i) {
    const r = Math.floor(i / g.cols);
    const c = i % g.cols;
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < g.rows && nc >= 0 && nc < g.cols) {
          out.push(nr * g.cols + nc);
        }
      }
    }
    return out;
  }

  /** Coloca las minas tras el primer clic, dejando libre esa casilla y sus vecinas. */
  function placeMines(g, safe) {
    const excluded = new Set([safe, ...neighbors(g, safe)]);
    const pool = [];
    for (let i = 0; i < g.total; i++) {
      if (!excluded.has(i)) pool.push(i);
    }
    // Selección aleatoria sin repetición (Fisher-Yates parcial).
    for (let k = 0; k < g.mines; k++) {
      const j = k + Math.floor(Math.random() * (pool.length - k));
      [pool[k], pool[j]] = [pool[j], pool[k]];
      g.mine[pool[k]] = 1;
    }
    for (let i = 0; i < g.total; i++) {
      if (!g.mine[i]) {
        g.count[i] = neighbors(g, i).reduce((acc, n) => acc + g.mine[n], 0);
      }
    }
  }

  function reveal(g, start) {
    if (g.revealed[start] || g.flagged[start]) return;

    if (!g.minesPlaced) {
      placeMines(g, start);
      g.minesPlaced = true;
      startTimer(g);
    }

    if (g.mine[start]) {
      lose(g, start);
      return;
    }

    // Descubre la casilla y propaga por las casillas con 0 minas alrededor.
    const stack = [start];
    g.revealed[start] = 1;
    g.revealedSafe++;
    while (stack.length) {
      const i = stack.pop();
      if (g.count[i] !== 0) continue;
      for (const n of neighbors(g, i)) {
        if (g.revealed[n] || g.flagged[n]) continue;
        g.revealed[n] = 1;
        g.revealedSafe++;
        stack.push(n);
      }
    }
  }

  function toggleFlag(g, i) {
    if (g.revealed[i]) return;
    g.flagged[i] = g.flagged[i] ? 0 : 1;
  }

  /** Clic sobre un número: si ya están marcadas todas sus minas, abre el resto de vecinas. */
  function chord(g, i) {
    if (!g.revealed[i] || g.count[i] === 0) return;
    const nb = neighbors(g, i);
    const marked = nb.reduce((acc, n) => acc + g.flagged[n], 0);
    if (marked !== g.count[i]) return;
    for (const n of nb) {
      if (g.state !== "playing") break;
      if (!g.flagged[n]) reveal(g, n);
    }
  }

  function lose(g, hit) {
    g.state = "lost";
    g.hitIndex = hit;
    stopTimer(g);
    for (let i = 0; i < g.total; i++) {
      if (g.mine[i]) {
        g.revealed[i] = 1;
        g.flagged[i] = 0;
      }
    }
  }

  function win(g) {
    g.state = "won";
    stopTimer(g);
    for (let i = 0; i < g.total; i++) {
      if (g.mine[i]) g.flagged[i] = 1;
    }
  }

  function countFlags(g) {
    let n = 0;
    for (let i = 0; i < g.total; i++) n += g.flagged[i];
    return n;
  }

  /* ---------- Temporizador ---------- */

  function elapsedSeconds(g) {
    return Math.floor((Date.now() - g.startTime) / 1000);
  }

  function startTimer(g) {
    g.startTime = Date.now();
    state.timerId = setInterval(renderHud, 250);
  }

  function stopTimer(g) {
    clearInterval(state.timerId);
    state.timerId = null;
    if (g.startTime) g.elapsed = elapsedSeconds(g);
  }

  /* ---------- Flujo de partida ---------- */

  /** Ejecuta una acción del jugador sólo si la partida sigue en curso. */
  function play(action) {
    const g = state.game;
    if (!g || g.state !== "playing") return;
    action(g);
    finishTurn(g);
  }

  function finishTurn(g) {
    if (g.state === "playing" && g.revealedSafe === g.total - g.mines) {
      win(g);
    }
    renderAll();
    if (g.state !== "playing" && !g.endShown) {
      g.endShown = true;
      showResult(g);
    }
  }

  function startGame(cfg, meta) {
    stopTimer(state.game ?? { startTime: 0 });
    state.game = createGame(cfg, meta);
    hideOverlay();
    buildBoard();
    applyCellSize();
    renderAll();
  }

  function startLevel(n) {
    state.mode = "niveles";
    state.level = n;
    startGame(LEVELS[n - 1], { label: `Nivel ${n}`, bestKey: `nivel-${n}`, levelNo: n });
    renderLevelPicker();
  }

  function startFree() {
    state.mode = "libre";
    const key = ui.difficulty.value;
    const d = DIFFICULTIES[key];
    startGame(d, { label: d.label, bestKey: `libre-${key}`, levelNo: null });
  }

  function restartCurrent() {
    if (state.mode === "niveles") startLevel(state.level);
    else startFree();
  }

  function setMode(mode) {
    if (mode === state.mode) return;
    ui.tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.mode === mode)));
    ui.levelPanel.hidden = mode !== "niveles";
    ui.freePanel.hidden = mode !== "libre";
    if (mode === "niveles") startLevel(state.level);
    else startFree();
  }

  function recordWin(g) {
    const best = state.progress.best;
    if (best[g.bestKey] === undefined || g.elapsed < best[g.bestKey]) {
      best[g.bestKey] = g.elapsed;
    }
    if (g.levelNo && g.levelNo < LEVELS.length && state.progress.unlocked <= g.levelNo) {
      state.progress.unlocked = g.levelNo + 1;
    }
    saveProgress();
  }

  function showResult(g) {
    if (g.state === "won") {
      recordWin(g);
      renderLevelPicker();
      const time = `Tiempo: ${g.elapsed} s`;
      if (g.levelNo && g.levelNo < LEVELS.length) {
        showOverlay("¡Nivel superado!", time, "Siguiente nivel", () => startLevel(g.levelNo + 1));
      } else if (g.levelNo) {
        showOverlay("¡Campaña completada!", time, "Jugar este nivel otra vez", restartCurrent);
      } else {
        showOverlay("¡Tablero despejado!", time, "Nueva partida", startFree);
      }
    } else {
      showOverlay("Has pisado una mina", "Inténtalo de nuevo.", "Reintentar", restartCurrent);
    }
  }

  /* ---------- Renderizado ---------- */

  function buildBoard() {
    const g = state.game;
    ui.board.innerHTML = "";
    ui.board.style.gridTemplateColumns = `repeat(${g.cols}, var(--cell))`;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < g.total; i++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.dataset.index = String(i);
      frag.appendChild(cell);
    }
    ui.board.appendChild(frag);
  }

  function applyCellSize() {
    const g = state.game;
    const available = Math.min(window.innerWidth, 900) - 64;
    const size = Math.max(20, Math.min(36, Math.floor(available / g.cols)));
    ui.board.style.setProperty("--cell", `${size}px`);
  }

  function renderCell(g, i) {
    const cell = ui.board.children[i];
    const row = Math.floor(i / g.cols) + 1;
    const col = (i % g.cols) + 1;
    let cls = "cell";
    let text = "";
    let desc = "oculta";

    if (g.revealed[i]) {
      cls += " cell--open";
      if (g.mine[i]) {
        cls += i === g.hitIndex ? " cell--hit" : " cell--mine";
        text = "💣";
        desc = "mina";
      } else if (g.count[i]) {
        cls += ` n${g.count[i]}`;
        text = String(g.count[i]);
        desc = `${g.count[i]} minas alrededor`;
      } else {
        desc = "vacía";
      }
    } else if (g.flagged[i]) {
      if (g.state === "lost" && !g.mine[i]) {
        cls += " cell--wrong";
        text = "✖";
        desc = "bandera incorrecta";
      } else {
        text = "🚩";
        desc = "bandera";
      }
    }

    cell.className = cls;
    cell.textContent = text;
    cell.setAttribute("aria-label", `Fila ${row}, columna ${col}: ${desc}`);
  }

  function messageFor(g) {
    if (g.state === "won") return "Has despejado el tablero.";
    if (g.state === "lost") return "Has pisado una mina.";
    return "Clic izquierdo para descubrir. Clic derecho o tecla F para marcar bandera.";
  }

  function renderHud() {
    const g = state.game;
    if (g.state === "playing" && g.startTime) g.elapsed = elapsedSeconds(g);

    ui.minesLeft.textContent = String(g.mines - countFlags(g)).padStart(3, "0");
    ui.timer.textContent = String(Math.min(g.elapsed, 999)).padStart(3, "0");
    ui.face.textContent = g.state === "won" ? "😎" : g.state === "lost" ? "😵" : "🙂";
    ui.message.textContent = messageFor(g);

    const best = state.progress.best[g.bestKey];
    let info = `${g.label} · ${g.cols}×${g.rows} · ${g.mines} minas`;
    if (best !== undefined) info += ` · Mejor: ${best} s`;
    ui.info.textContent = info;
  }

  function renderAll() {
    const g = state.game;
    for (let i = 0; i < g.total; i++) renderCell(g, i);
    renderHud();
    ui.flagToggle.setAttribute("aria-pressed", String(state.flagMode));
    ui.flagToggle.textContent = state.flagMode ? "Modo bandera: activo" : "Modo bandera: inactivo";
    ui.flagToggle.classList.toggle("is-active", state.flagMode);
  }

  function renderLevelPicker() {
    ui.levelList.innerHTML = "";
    LEVELS.forEach((cfg, idx) => {
      const n = idx + 1;
      const locked = n > state.progress.unlocked;
      const current = n === state.level && state.mode === "niveles";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "level" + (current ? " level--current" : "");
      btn.disabled = locked;
      if (current) btn.setAttribute("aria-current", "true");

      const title = document.createElement("strong");
      title.textContent = locked ? `🔒 Nivel ${n}` : `Nivel ${n}`;

      const info = document.createElement("small");
      info.textContent = `${cfg.cols}×${cfg.rows} · ${cfg.mines} minas`;

      btn.append(title, info);

      const best = state.progress.best[`nivel-${n}`];
      if (best !== undefined) {
        const bestEl = document.createElement("small");
        bestEl.textContent = `Mejor: ${best} s`;
        btn.appendChild(bestEl);
      }

      btn.addEventListener("click", () => startLevel(n));
      ui.levelList.appendChild(btn);
    });
  }

  /* ---------- Ventana de resultado ---------- */

  function showOverlay(title, text, label, action) {
    ui.overlayTitle.textContent = title;
    ui.overlayText.textContent = text;
    ui.overlayPrimary.textContent = label;
    state.overlayAction = action;
    ui.overlay.hidden = false;
    ui.overlayPrimary.focus();
  }

  function hideOverlay() {
    ui.overlay.hidden = true;
    state.overlayAction = null;
  }

  /* ---------- Eventos ---------- */

  ui.board.addEventListener("click", (e) => {
    const cell = e.target.closest(".cell");
    if (!cell) return;
    const i = Number(cell.dataset.index);
    if (state.flagMode || e.shiftKey || e.ctrlKey) {
      play((g) => toggleFlag(g, i));
    } else {
      play((g) => (g.revealed[i] ? chord(g, i) : reveal(g, i)));
    }
  });

  ui.board.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const cell = e.target.closest(".cell");
    if (!cell) return;
    const i = Number(cell.dataset.index);
    play((g) => toggleFlag(g, i));
  });

  ui.board.addEventListener("keydown", (e) => {
    if (e.key !== "f" && e.key !== "F") return;
    const cell = e.target.closest(".cell");
    if (!cell) return;
    e.preventDefault();
    const i = Number(cell.dataset.index);
    play((g) => toggleFlag(g, i));
  });

  ui.tabs.forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
  });

  ui.flagToggle.addEventListener("click", () => {
    state.flagMode = !state.flagMode;
    renderAll();
  });

  ui.face.addEventListener("click", restartCurrent);
  ui.restart.addEventListener("click", restartCurrent);
  ui.newFree.addEventListener("click", startFree);

  ui.resetProgress.addEventListener("click", () => {
    if (!confirm("¿Reiniciar el progreso de niveles y los mejores tiempos?")) return;
    state.progress = { unlocked: 1, best: {} };
    saveProgress();
    startLevel(1);
  });

  ui.overlayPrimary.addEventListener("click", () => {
    const action = state.overlayAction;
    hideOverlay();
    if (action) action();
  });
  ui.overlayClose.addEventListener("click", hideOverlay);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !ui.overlay.hidden) hideOverlay();
  });

  window.addEventListener("resize", () => {
    if (state.game) applyCellSize();
  });

  startLevel(state.level);
})();
