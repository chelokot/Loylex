(() => {
  const STORAGE_KEY = 'anime-todo.v1';
  const MAX_LENGTH = 200;

  const form = document.getElementById('new-task');
  const input = document.getElementById('task-input');
  const list = document.getElementById('tasks');
  const empty = document.getElementById('empty');
  const count = document.getElementById('count');
  const clearDoneButton = document.getElementById('clear-done');
  const filterButtons = [...document.querySelectorAll('.filter')];
  const musicButton = document.getElementById('music');

  let tasks = loadTasks();
  let filter = 'all';
  let lastAddedId = null;

  function loadTasks() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter(isValidTask) : [];
    } catch {
      return [];
    }
  }

  function isValidTask(task) {
    return Boolean(task) && typeof task.id === 'string' && typeof task.text === 'string' && typeof task.done === 'boolean';
  }

  function saveTasks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch {
      // Storage can be full or disabled; the list keeps working for this visit.
    }
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function visibleTasks() {
    if (filter === 'active') return tasks.filter((task) => !task.done);
    if (filter === 'done') return tasks.filter((task) => task.done);
    return tasks;
  }

  function changed() {
    saveTasks();
    render();
  }

  function addTask(text) {
    const clean = text.trim().slice(0, MAX_LENGTH);
    if (!clean) return false;
    lastAddedId = newId();
    tasks = [{ id: lastAddedId, text: clean, done: false }, ...tasks];
    changed();
    return true;
  }

  function toggleTask(id) {
    tasks = tasks.map((task) => (task.id === id ? { ...task, done: !task.done } : task));
    changed();
  }

  function removeTask(id) {
    tasks = tasks.filter((task) => task.id !== id);
    changed();
  }

  function clearDone() {
    tasks = tasks.filter((task) => !task.done);
    changed();
  }

  function renderTask(task) {
    const item = document.createElement('li');
    item.className = 'task' + (task.done ? ' is-done' : '') + (task.id === lastAddedId ? ' is-new' : '');

    const label = document.createElement('label');
    label.className = 'task-main';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'check';
    check.checked = task.done;
    check.dataset.key = `toggle:${task.id}`;
    check.addEventListener('change', () => toggleTask(task.id));

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = task.text; // textContent keeps user input as plain text.

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.dataset.key = `remove:${task.id}`;
    remove.setAttribute('aria-label', 'Удалить задачу');
    remove.textContent = '×';
    remove.addEventListener('click', () => removeTask(task.id));

    label.append(check, text);
    item.append(label, remove);
    return item;
  }

  function render() {
    // Rebuilding the list would drop keyboard focus, so restore it on the same control.
    const focusedKey = document.activeElement?.dataset?.key;
    const shown = visibleTasks();
    list.replaceChildren(...shown.map(renderTask));
    lastAddedId = null;
    if (focusedKey) list.querySelector(`[data-key="${focusedKey}"]`)?.focus();

    const left = tasks.filter((task) => !task.done).length;
    count.textContent = `Осталось: ${left}`;

    if (tasks.length === 0) {
      empty.textContent = 'Пока пусто. Самое время что-нибудь добавить ✦';
      empty.hidden = false;
    } else if (shown.length === 0) {
      empty.textContent = 'В этом фильтре задач нет.';
      empty.hidden = false;
    } else {
      empty.hidden = true;
    }

    clearDoneButton.hidden = !tasks.some((task) => task.done);

    for (const button of filterButtons) {
      const active = button.dataset.filter === filter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (addTask(input.value)) input.value = '';
    input.focus();
  });

  for (const button of filterButtons) {
    button.addEventListener('click', () => {
      filter = button.dataset.filter;
      render();
    });
  }

  clearDoneButton.addEventListener('click', clearDone);

  // Light parallax: layers move a few pixels against the pointer, unless the user prefers reduced motion.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const depthLayers = [...document.querySelectorAll('[data-depth]')];
  const pointer = { x: 0, y: 0 };
  let frame = 0;

  window.addEventListener('pointermove', (event) => {
    if (reducedMotion.matches) return;
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
    if (!frame) frame = requestAnimationFrame(moveLayers);
  }, { passive: true });

  function moveLayers() {
    frame = 0;
    for (const layer of depthLayers) {
      const depth = Number(layer.dataset.depth) || 1;
      const x = (-pointer.x * depth * 14).toFixed(1);
      const y = (-pointer.y * depth * 10).toFixed(1);
      layer.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
  }

  // Original chiptune loop built with Web Audio: no sampled or licensed tracks.
  const MELODY = [523.25, 659.25, 783.99, 659.25, 880, 783.99, 659.25, 587.33];
  const BASS = [130.81, 98, 110, 87.31];
  const STEP = 0.25; // seconds per eighth note (120 BPM)
  let player = null;

  function playTone(ctx, target, frequency, when, duration, type, volume) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(volume, when + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    osc.connect(gain).connect(target);
    osc.start(when);
    osc.stop(when + duration + 0.05);
  }

  function startMusic() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);

    let step = 0;
    let nextTime = ctx.currentTime + 0.1;

    // Schedule notes slightly ahead of time so the loop stays steady even if the timer jitters.
    const schedule = () => {
      while (nextTime < ctx.currentTime + 0.3) {
        if (step % MELODY.length === 0) {
          const bar = step / MELODY.length;
          playTone(ctx, master, BASS[bar % BASS.length], nextTime, STEP * MELODY.length, 'sine', 0.25);
        }
        playTone(ctx, master, MELODY[step % MELODY.length], nextTime, STEP * 0.9, 'triangle', 0.12);
        nextTime += STEP;
        step += 1;
      }
    };

    schedule();
    return { ctx, timer: setInterval(schedule, 100) };
  }

  function stopMusic() {
    clearInterval(player.timer);
    player.ctx.close();
    player = null;
  }

  musicButton.addEventListener('click', () => {
    if (player) {
      stopMusic();
    } else {
      player = startMusic();
    }
    const playing = Boolean(player);
    musicButton.setAttribute('aria-pressed', String(playing));
    musicButton.textContent = playing ? '♪ Музыка: вкл' : '♪ Музыка: выкл';
  });

  if (!(window.AudioContext || window.webkitAudioContext)) {
    musicButton.hidden = true;
  }

  render();
})();
