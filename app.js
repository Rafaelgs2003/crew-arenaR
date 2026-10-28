(() => {
  "use strict";

  const STORAGE_KEY = "lista-tareas-v1";

  const form = document.getElementById("task-form");
  const input = document.getElementById("task-input");
  const list = document.getElementById("task-list");
  const counter = document.getElementById("counter");
  const emptyMessage = document.getElementById("empty-message");
  const clearDoneBtn = document.getElementById("clear-done");

  /** @type {{id: string, text: string, done: boolean}[]} */
  let tasks = load();
  let filter = "all";

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return Array.isArray(data)
        ? data.filter((t) => t && typeof t.text === "string")
        : [];
    } catch {
      return [];
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  }

  function createId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function visibleTasks() {
    if (filter === "pending") return tasks.filter((t) => !t.done);
    if (filter === "done") return tasks.filter((t) => t.done);
    return tasks;
  }

  function render() {
    list.innerHTML = "";

    for (const task of visibleTasks()) {
      const li = document.createElement("li");
      li.className = "task" + (task.done ? " task--done" : "");
      li.dataset.id = task.id;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = task.done;
      checkbox.setAttribute("aria-label", "Marcar como completada");

      const text = document.createElement("span");
      text.className = "task__text";
      text.textContent = task.text;

      const del = document.createElement("button");
      del.type = "button";
      del.className = "task__delete";
      del.textContent = "✕";
      del.setAttribute("aria-label", "Eliminar tarea");

      li.append(checkbox, text, del);
      list.appendChild(li);
    }

    const pending = tasks.filter((t) => !t.done).length;
    counter.textContent = `${pending} ${pending === 1 ? "pendiente" : "pendientes"}`;
    emptyMessage.hidden = visibleTasks().length > 0;
    clearDoneBtn.hidden = !tasks.some((t) => t.done);
  }

  function addTask(text) {
    const clean = text.trim();
    if (!clean) return;
    tasks.push({ id: createId(), text: clean, done: false });
    save();
    render();
  }

  function toggleTask(id) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    task.done = !task.done;
    save();
    render();
  }

  function removeTask(id) {
    const el = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    const finish = () => {
      tasks = tasks.filter((t) => t.id !== id);
      save();
      render();
    };
    if (el && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("task--removing");
      el.addEventListener("transitionend", finish, { once: true });
      setTimeout(finish, 450); // respaldo si no se dispara transitionend
    } else {
      finish();
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    addTask(input.value);
    input.value = "";
    input.focus();
  });

  list.addEventListener("change", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === "checkbox") {
      toggleTask(e.target.closest(".task").dataset.id);
    }
  });

  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".task__delete");
    if (btn) removeTask(btn.closest(".task").dataset.id);
  });

  document.querySelectorAll('input[name="filter"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      filter = radio.value;
      render();
    });
  });

  clearDoneBtn.addEventListener("click", () => {
    tasks = tasks.filter((t) => !t.done);
    save();
    render();
  });

  render();
})();
