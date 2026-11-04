(() => {
  "use strict";

  const PROGRESS_KEY = "buscaminas-progreso-v1";

  /** Dificultades del modo libre (tableros rectangulares, apaisados). */
  const DIFFICULTIES = {
    facil: { label: "Fácil", rows: 8, cols: 12, mines: 12 },
    medio: { label: "Medio", rows: 12, cols: 20, mines: 45 },
    dificil: { label: "Difícil", rows: 16, cols: 30, mines: 99 },
  };

  /**
   * Niveles de la campaña. Los tableros son rectangulares (más anchos que
   * altos) para aprovechar el ancho de la pantalla y evitar el scroll vertical.
   */
  const LEVELS = [
    { rows: 7, cols: 10, mines: 9, par: 15 },
    { rows: 8, cols: 12, mines: 14, par: 25 },
    { rows: 9, cols: 14, mines: 20, par: 40 },
    { rows: 9, cols: 16, mines: 26, par: 55 },
    { rows: 10, cols: 18, mines: 33, par: 75 },
    { rows: 11, cols: 20, mines: 42, par: 95 },
    { rows: 11, cols: 22, mines: 50, par: 120 },
    { rows: 12, cols: 24, mines: 60, par: 150 },
    { rows: 13, cols: 26, mines: 72, par: 185 },
    { rows: 14, cols: 30, mines: 90, par: 230 },
  ];

  /**
   * Devuelve las estrellas (1-3) obtenidas en un nivel según el tiempo.
   * `par` es el tiempo objetivo para 3 estrellas; a partir de ahí se pierden
   * estrellas de forma escalonada. Completar el nivel siempre da al menos 1.
   */
  function starsFor(levelNo, seconds) {
    const par = LEVELS[levelNo - 1].par;
    if (seconds <= par) return 3;
    if (seconds <= par * 2) return 2;
    return 1;
  }

  /**
   * Puntos de un nivel: una base por estrella, más un bono por rapidez que se
   * reduce conforme te alejas del tiempo objetivo (nunca negativo).
   */
  function scoreFor(levelNo, seconds, stars) {
    const par = LEVELS[levelNo - 1].par;
    const base = stars * 500;
    const speedBonus = Math.max(0, Math.round((par * 2 - seconds) * 5));
    return base + speedBonus;
  }

  const $ = (id) => document.getElementById(id);
  const ui = {
    board: $("board"),
    boardWrap: document.querySelector(".board-wrap"),
    minesLeft: $("mines-left"),
    timer: $("timer"),
    face: $("face"),
    info: $("info"),
    message: $("message"),
    tabs: document.querySelectorAll(".segmented__btn"),
    levelPanel: $("level-panel"),
    levelList: $("level-list"),
    totalStars: $("total-stars"),
    totalScore: $("total-score"),
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
    const fallback = { unlocked: 1, best: {}, stars: {}, score: {} };
    try {
      const data = JSON.parse(localStorage.getItem(PROGRESS_KEY));
      if (data && Number.isInteger(data.unlocked) && data.best && typeof data.best === "object") {
        // Compatibilidad con progresos guardados antes de añadir estrellas/puntos.
        data.stars = data.stars && typeof data.stars === "object" ? data.stars : {};
        data.score = data.score && typeof data.score === "object" ? data.score : {};
        return data;
      }
    } catch {
      /* datos corruptos: se usa el valor por defecto */
    }
    return fallback;
  }

  /** Suma de puntos de todos los niveles (se queda el mejor de cada uno). */
  function totalScore() {
    return Object.values(state.progress.score).reduce((a, b) => a + b, 0);
  }

  /** Suma de estrellas obtenidas (mejor marca de cada nivel). */
  function totalStars() {
    return Object.values(state.progress.stars).reduce((a, b) => a + b, 0);
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
      justOpened: new Uint8Array(total), // casillas abiertas en el último turno
      origin: -1, // casilla desde la que se propagó la cascada (para animar)
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
    for (let k = 0; k < g.mines && k < pool.length; k++) {
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
    if (g.origin < 0) g.origin = start; // origen de la cascada para animar
    const stack = [start];
    g.revealed[start] = 1;
    g.justOpened[start] = 1;
    g.revealedSafe++;
    while (stack.length) {
      const i = stack.pop();
      if (g.count[i] !== 0) continue;
      for (const n of neighbors(g, i)) {
        if (g.revealed[n] || g.flagged[n]) continue;
        g.revealed[n] = 1;
        g.justOpened[n] = 1;
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
    clearInterval(state.timerId);
    state.timerId = setInterval(renderHud, 250);
  }

  function stopTimer(g) {
    clearInterval(state.timerId);
    state.timerId = null;
    if (g && g.startTime) g.elapsed = elapsedSeconds(g);
  }

  /* ---------- Flujo de partida ---------- */

  /** Ejecuta una acción del jugador sólo si la partida sigue en curso. */
  function play(action) {
    const g = state.game;
    if (!g || g.state !== "playing") return;
    g.justOpened.fill(0); // reinicia el marcado de animación de este turno
    g.origin = -1;
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
    stopTimer(state.game);
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
    ui.tabs.forEach((t) => {
      const on = t.dataset.mode === mode;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", String(on));
    });
    ui.levelPanel.hidden = mode !== "niveles";
    ui.freePanel.hidden = mode !== "libre";
    if (mode === "niveles") startLevel(state.level);
    else startFree();
  }

  /**
   * Registra la victoria: mejor tiempo, desbloqueo del siguiente nivel y, para
   * los niveles de campaña, las estrellas y los puntos obtenidos (guardando
   * siempre la mejor marca). Devuelve los datos de esta partida para el overlay.
   */
  function recordWin(g) {
    const p = state.progress;
    if (p.best[g.bestKey] === undefined || g.elapsed < p.best[g.bestKey]) {
      p.best[g.bestKey] = g.elapsed;
    }

    let stars = 0;
    let score = 0;
    let newRecord = false;
    if (g.levelNo) {
      stars = starsFor(g.levelNo, g.elapsed);
      score = scoreFor(g.levelNo, g.elapsed, stars);
      const prevStars = p.stars[g.bestKey] || 0;
      const prevScore = p.score[g.bestKey] || 0;
      if (stars > prevStars) { p.stars[g.bestKey] = stars; newRecord = true; }
      if (score > prevScore) { p.score[g.bestKey] = score; newRecord = true; }

      if (g.levelNo < LEVELS.length && p.unlocked <= g.levelNo) {
        p.unlocked = g.levelNo + 1;
      }
    }

    saveProgress();
    return { stars, score, newRecord };
  }

  /** HTML de las estrellas (llenas/vacías) con animación escalonada. */
  function starsHtml(stars) {
    let out = '<div class="stars" aria-label="' + stars + ' de 3 estrellas">';
    for (let i = 1; i <= 3; i++) {
      const filled = i <= stars;
      out += `<span class="star ${filled ? "star--on" : "star--off"}" style="--d:${i * 0.15}s">★</span>`;
    }
    out += "</div>";
    return out;
  }

  function showResult(g) {
    if (g.state === "won") {
      const result = recordWin(g);
      renderLevelPicker();
      renderHud();

      if (g.levelNo) {
        const detail =
          starsHtml(result.stars) +
          `<p class="result__line">Tiempo: <strong>${g.elapsed} s</strong></p>` +
          `<p class="result__line">Puntos: <strong>${result.score}</strong>` +
          (result.newRecord ? ' <span class="result__badge">¡Récord!</span>' : "") +
          `</p>`;
        if (g.levelNo < LEVELS.length) {
          showOverlay("Nivel superado", detail, "Siguiente nivel", () => startLevel(g.levelNo + 1), { html: true });
        } else {
          showOverlay("Campaña completada", detail, "Jugar otra vez", restartCurrent, { html: true });
        }
      } else {
        showOverlay("Tablero despejado", `Tiempo: ${g.elapsed} s`, "Nueva partida", startFree);
      }
    } else if (g.levelNo === 1) {
      // Pista didáctica la primera vez que se juega (nivel 1).
      const tip = `
        <span class="tip__lead">Aprende a jugar:</span>
        <ul class="tip">
          <li>Cada número dice <strong>cuántas minas</strong> tocan esa casilla.</li>
          <li>Un <strong>1</strong> con una sola casilla oculta al lado: ahí está la mina.</li>
          <li>Marca las minas con una bandera <strong>⚑</strong> (clic derecho o tecla F).</li>
          <li>Si todas las minas de un número ya están marcadas, haz clic en el número para abrir el resto.</li>
          <li>El <strong>primer clic nunca es una mina</strong>, así que empieza por el centro.</li>
        </ul>`;
      showOverlay("¡Mina!", tip, "Reintentar", restartCurrent, { html: true });
    } else {
      showOverlay("Has pisado una mina", "Inténtalo de nuevo.", "Reintentar", restartCurrent);
    }
  }

  /* ---------- Renderizado ---------- */

  function buildBoard() {
    const g = state.game;
    ui.board.innerHTML = "";
    ui.board.style.gridTemplateColumns = `repeat(${g.cols}, var(--cell-size))`;
    ui.board.style.gridTemplateRows = `repeat(${g.rows}, var(--cell-size))`;
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

  /**
   * Calcula el tamaño de celda para que el tablero completo quepa en la
   * ventana sin necesidad de scroll, limitándose tanto por el ancho
   * disponible como por el alto que dejan libre el resto de secciones.
   */
  function applyCellSize() {
    const g = state.game;
    const GAP = 3; // separación entre celdas (coincide con el CSS)
    const MIN = 26; // tamaño mínimo legible de celda
    const MAX = 40; // tamaño máximo cómodo

    // Ancho real disponible: el ancho interior del contenedor del tablero,
    // medido del DOM para no depender de constantes frágiles.
    const widthAvail = ui.boardWrap.clientWidth - 2;

    // Alto disponible: lo que queda de la ventana tras descontar el espacio
    // aproximado que ocupan cabecera, paneles, marcador y controles.
    const heightAvail = Math.max(200, window.innerHeight - 360);

    const byWidth = Math.floor((widthAvail - (g.cols - 1) * GAP) / g.cols);
    const byHeight = Math.floor((heightAvail - (g.rows - 1) * GAP) / g.rows);

    // Tamaño ideal para que quepa sin scroll, pero nunca por debajo del
    // mínimo legible: preferimos celdas cómodas y, si no caben, permitimos
    // scroll sólo en ese caso extremo.
    const size = Math.min(MAX, Math.max(MIN, Math.min(byWidth, byHeight)));
    ui.board.style.setProperty("--cell-size", `${size}px`);

    // Activa el desplazamiento del contenedor únicamente cuando el tablero,
    // al tamaño mínimo legible, no cabe en el ancho disponible.
    const boardWidth = g.cols * size + (g.cols - 1) * GAP;
    ui.boardWrap.classList.toggle("is-scrollable", boardWidth > widthAvail);
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
      if (g.justOpened[i]) cls += " cell--reveal";
      if (g.mine[i]) {
        cls += i === g.hitIndex ? " cell--hit" : " cell--mine";
        text = "✱";
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
        text = "⚑";
        desc = "bandera";
      }
    }

    cell.className = cls;
    cell.textContent = text;
    cell.setAttribute("aria-label", `Fila ${row}, columna ${col}: ${desc}`);

    // Retardo de la animación de cascada: cuanto más lejos del origen del
    // clic, más tarde aparece la casilla, creando un efecto de onda.
    if (g.justOpened[i] && g.origin >= 0) {
      const or = Math.floor(g.origin / g.cols);
      const oc = g.origin % g.cols;
      const dist = Math.max(Math.abs(row - 1 - or), Math.abs(col - 1 - oc));
      cell.style.setProperty("--reveal-delay", `${Math.min(dist * 28, 320)}ms`);
    } else {
      cell.style.removeProperty("--reveal-delay");
    }
  }

  function messageFor(g) {
    if (g.state === "won") return "¡Has despejado el tablero!";
    if (g.state === "lost") return "Has pisado una mina.";
    return "";
  }

  function renderHud() {
    const g = state.game;
    if (!g) return;
    if (g.state === "playing" && g.startTime) g.elapsed = elapsedSeconds(g);

    ui.minesLeft.textContent = String(Math.max(0, g.mines - countFlags(g))).padStart(3, "0");
    ui.timer.textContent = String(Math.min(g.elapsed, 999)).padStart(3, "0");
    ui.face.textContent = g.state === "won" ? "B-)" : g.state === "lost" ? "x_x" : "·‿·";
    ui.face.classList.toggle("face--won", g.state === "won");
    ui.face.classList.toggle("face--lost", g.state === "lost");
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
    ui.flagToggle.textContent = state.flagMode
      ? "⚑ Modo bandera: activo"
      : "⚑ Modo bandera: inactivo";
  }

  function renderLevelPicker() {
    const maxStars = LEVELS.length * 3;
    ui.totalStars.textContent = `★ ${totalStars()}/${maxStars}`;
    ui.totalScore.textContent = `${totalScore()} pts`;

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
      title.textContent = locked ? `Nivel ${n} (bloqueado)` : `Nivel ${n}`;

      const info = document.createElement("small");
      info.textContent = `${cfg.cols}×${cfg.rows} · ${cfg.mines} minas`;

      btn.append(title, info);

      const earned = state.progress.stars[`nivel-${n}`] || 0;
      if (!locked) {
        const starRow = document.createElement("small");
        starRow.className = "level__stars";
        starRow.setAttribute("aria-label", `${earned} de 3 estrellas`);
        starRow.textContent = "★".repeat(earned) + "☆".repeat(3 - earned);
        btn.appendChild(starRow);
      }

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

  /**
   * Muestra la ventana de resultado. Si `opts.html` es true, `text` se
   * interpreta como HTML (contenido fijo definido en el propio código, nunca
   * entrada del usuario), lo que permite pistas con varias líneas.
   */
  function showOverlay(title, text, label, action, opts = {}) {
    ui.overlayTitle.textContent = title;
    if (opts.html) {
      ui.overlayText.innerHTML = text;
    } else {
      ui.overlayText.textContent = text;
    }
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
    if (!confirm("¿Reiniciar el progreso, estrellas y puntuación?")) return;
    state.progress = { unlocked: 1, best: {}, stars: {}, score: {} };
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
