/* ================================================================
   Teleprompter — iPad web app with Bluetooth (HID keyboard) remote
   ================================================================ */
'use strict';

/* ---------------- Storage ---------------- */
const LS_SCRIPTS = 'tp_scripts';
const LS_SETTINGS = 'tp_settings';
const LS_KEYMAP = 'tp_keymap';

const DEFAULT_SETTINGS = {
  fontSize: 56,        // px
  lineHeight: 1.6,
  margin: 8,           // % each side
  color: '#ffffff',
  caps: false,
  mirrorH: false,
  mirrorV: false,
  guide: true,
  countdown: true,
  highlight: true,
  speed: 70,           // px per second
};

// Default map covers common BT page-turner pedals, clickers and keyboards.
const DEFAULT_KEYMAP = {
  'Space': 'playPause',
  'Enter': 'playPause',
  'ArrowDown': 'faster',
  'PageDown': 'faster',
  'ArrowUp': 'slower',
  'PageUp': 'slower',
  'ArrowLeft': 'back',
  'ArrowRight': 'forward',
  'Home': 'restart',
  'Escape': 'exit',
};

const ACTIONS = [
  { id: 'playPause', label: 'Play / Pause' },
  { id: 'faster',    label: 'Faster' },
  { id: 'slower',    label: 'Slower' },
  { id: 'back',      label: 'Jump back' },
  { id: 'forward',   label: 'Jump forward' },
  { id: 'restart',   label: 'Restart' },
  { id: 'fontUp',    label: 'Font bigger' },
  { id: 'fontDown',  label: 'Font smaller' },
  { id: 'exit',      label: 'Exit prompter' },
];

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return structuredClone(fallback);
    return { ...structuredClone(fallback), ...JSON.parse(raw) };
  } catch { return structuredClone(fallback); }
}
function loadScripts() {
  try { return JSON.parse(localStorage.getItem(LS_SCRIPTS)) || []; }
  catch { return []; }
}
function saveScripts() { localStorage.setItem(LS_SCRIPTS, JSON.stringify(scripts)); }
function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }
function saveKeymap() { localStorage.setItem(LS_KEYMAP, JSON.stringify(keymap)); }

let scripts = loadScripts();
let settings = loadJSON(LS_SETTINGS, DEFAULT_SETTINGS);
let keymap = (() => {
  try {
    const raw = localStorage.getItem(LS_KEYMAP);
    return raw ? JSON.parse(raw) : { ...DEFAULT_KEYMAP };
  } catch { return { ...DEFAULT_KEYMAP }; }
})();

/* Seed a sample script on first run */
if (scripts.length === 0 && !localStorage.getItem('tp_seeded')) {
  scripts.push({
    id: 'sample',
    title: 'Welcome — read me first',
    body:
`Welcome to your teleprompter.

Tap anywhere on the screen to start and stop scrolling. The orange arrow on the left marks your reading line.

To use a Bluetooth remote, pedal, or clicker, pair it with the iPad in Settings, then Bluetooth. It will show up as a keyboard.

Out of the box: space or enter plays and pauses. Down arrow or page down speeds up. Up arrow or page up slows down. Left and right arrows jump back and forward.

If your remote sends different keys, open Settings, press a button on the remote, and map it to any action.

Notice how the current line is highlighted as the text scrolls, so you never lose your place. You can turn this off in Settings.

In Settings you can also change font size, speed, margins, and colors, and turn on mirror mode to flip the whole image for beam-splitter teleprompter glass.

Add this page to your Home Screen for a full-screen experience. Happy reading.`,
    updated: Date.now(),
  });
  localStorage.setItem('tp_seeded', '1');
  saveScripts();
}

/* ---------------- Elements ---------------- */
const $ = (id) => document.getElementById(id);
const views = { library: $('view-library'), editor: $('view-editor'), prompter: $('view-prompter') };
const els = {
  list: $('script-list'), fileInput: $('file-input'),
  editorTitle: $('editor-title'), editorBody: $('editor-body'),
  flipWrap: $('flip-wrap'), stage: $('stage'), content: $('content'),
  guide: $('guide'), progressFill: $('progress-fill'),
  promptTitle: $('prompter-title'), timeLeft: $('time-left'),
  playPauseBtn: $('btn-playpause'), speedValue: $('speed-value'),
  countdown: $('countdown'),
  modal: $('settings-modal'), lastKey: $('last-key'), keymapList: $('keymap-list'),
};

/* ---------------- View routing ---------------- */
let currentView = 'library';
function showView(name) {
  for (const [k, v] of Object.entries(views)) v.hidden = k !== name;
  currentView = name;
}

/* ---------------- Library ---------------- */
function fmtWords(body) {
  const w = body.trim() ? body.trim().split(/\s+/).length : 0;
  const mins = Math.max(1, Math.round(w / 150));
  return `${w} words · ~${mins} min read`;
}
function renderLibrary() {
  els.list.innerHTML = '';
  if (scripts.length === 0) {
    els.list.innerHTML = `<div class="empty-state">No scripts yet.<br>Tap <b>＋ New Script</b> to create one, or import a .txt file.</div>`;
    return;
  }
  const sorted = [...scripts].sort((a, b) => b.updated - a.updated);
  for (const s of sorted) {
    const card = document.createElement('div');
    card.className = 'script-card';
    card.innerHTML = `
      <h2></h2>
      <div class="preview"></div>
      <div class="meta"></div>
      <div class="card-actions">
        <button class="play">▶ Prompt</button>
        <button class="edit">Edit</button>
        <button class="delete" title="Delete">Delete</button>
      </div>`;
    card.querySelector('h2').textContent = s.title || 'Untitled';
    card.querySelector('.preview').textContent = s.body.slice(0, 220);
    card.querySelector('.meta').textContent = fmtWords(s.body);
    card.querySelector('.play').onclick = () => openPrompter(s.id);
    card.querySelector('.edit').onclick = () => openEditor(s.id);
    card.querySelector('.delete').onclick = () => {
      if (confirm(`Delete “${s.title || 'Untitled'}”?`)) {
        scripts = scripts.filter(x => x.id !== s.id);
        saveScripts(); renderLibrary();
      }
    };
    els.list.appendChild(card);
  }
}

function newId() {
  return (crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
}

$('btn-new').onclick = () => {
  const s = { id: newId(), title: '', body: '', updated: Date.now() };
  scripts.push(s); saveScripts();
  openEditor(s.id);
};
$('btn-import').onclick = () => els.fileInput.click();
els.fileInput.onchange = () => {
  const file = els.fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const s = {
      id: newId(),
      title: file.name.replace(/\.(txt|md)$/i, ''),
      body: String(reader.result),
      updated: Date.now(),
    };
    scripts.push(s); saveScripts(); renderLibrary();
  };
  reader.readAsText(file);
  els.fileInput.value = '';
};
$('btn-settings').onclick = () => openSettings();

/* ---------------- Editor ---------------- */
let editingId = null;
function openEditor(id) {
  const s = scripts.find(x => x.id === id);
  if (!s) return;
  editingId = id;
  els.editorTitle.value = s.title;
  els.editorBody.value = s.body;
  showView('editor');
  if (!s.title) els.editorTitle.focus();
}
function saveEditor() {
  const s = scripts.find(x => x.id === editingId);
  if (!s) return;
  s.title = els.editorTitle.value.trim();
  s.body = els.editorBody.value;
  s.updated = Date.now();
  saveScripts();
}
els.editorTitle.addEventListener('input', saveEditor);
els.editorBody.addEventListener('input', saveEditor);
$('btn-editor-back').onclick = () => {
  saveEditor();
  // Drop scripts that were never given content
  const s = scripts.find(x => x.id === editingId);
  if (s && !s.title && !s.body.trim()) scripts = scripts.filter(x => x.id !== editingId);
  saveScripts();
  editingId = null;
  renderLibrary(); showView('library');
};
$('btn-editor-play').onclick = () => { saveEditor(); openPrompter(editingId); };

/* ---------------- Prompter engine ---------------- */
const prompter = {
  scriptId: null,
  pos: 0,          // px scrolled
  maxPos: 1,
  playing: false,
  lastT: null,
  countdownTimer: null,
  hideTimer: null,
};

function guideY() { return window.innerHeight * 0.35; }

/* --- Line highlighting --------------------------------------------
   The script body is split into word <span>s so visual lines can be
   measured after layout. Each line gets a trigger: the scroll position
   at which it crosses the reading guide. A highlight bar sits behind
   the current line and steps down line by line, in sync with the
   scroll. */
let wordSpans = [];
let lineData = [];   // { trigger, top, height } per visual line
let hlLine = -1;
let lineHlBar = null;

function buildContent(body) {
  els.content.innerHTML = '';
  wordSpans = [];
  lineData = [];
  hlLine = -1;
  const frag = document.createDocumentFragment();
  for (const part of body.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      frag.appendChild(document.createTextNode(part));
    } else {
      const sp = document.createElement('span');
      sp.className = 'w';
      sp.textContent = part;
      frag.appendChild(sp);
      wordSpans.push(sp);
    }
  }
  lineHlBar = document.createElement('div');
  lineHlBar.id = 'line-hl';
  frag.appendChild(lineHlBar);
  els.content.appendChild(frag);
}

function computeLineData() {
  lineData = [];
  hlLine = -1;
  if (lineHlBar) lineHlBar.style.display = 'none';
  if (!settings.highlight || wordSpans.length === 0) return;
  const gy = guideY();
  const lineAdvance = settings.fontSize * settings.lineHeight;
  const tops = wordSpans.map(sp => sp.offsetTop);
  let i = 0;
  while (i < wordSpans.length) {
    let j = i;
    while (j < wordSpans.length && tops[j] === tops[i]) j++;
    // Gap to the next line can span blank lines; the bar covers one line box.
    const nextTop = j < wordSpans.length ? tops[j] : tops[i] + lineAdvance;
    const height = Math.max(1, Math.min(nextTop - tops[i], lineAdvance));
    const spanH = wordSpans[i].offsetHeight;
    lineData.push({
      trigger: tops[i] - gy,
      top: tops[i] - Math.max(0, (height - spanH) / 2),
      height,
    });
    i = j;
  }
}

function updateHighlight() {
  if (lineData.length === 0) return;
  // Binary search: last line whose trigger position has been passed
  let lo = 0, hi = lineData.length - 1, idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineData[mid].trigger <= prompter.pos) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx !== hlLine) {
    hlLine = idx;
    const line = lineData[idx];
    lineHlBar.style.display = 'block';
    lineHlBar.style.top = line.top + 'px';
    lineHlBar.style.height = line.height + 'px';
  }
}

function layoutContent() {
  const c = els.content;
  c.style.fontSize = settings.fontSize + 'px';
  c.style.lineHeight = settings.lineHeight;
  c.style.color = settings.color;
  c.style.paddingLeft = settings.margin + '%';
  c.style.paddingRight = settings.margin + '%';
  c.style.paddingTop = guideY() + 'px';
  c.style.paddingBottom = (window.innerHeight - guideY()) + 'px';
  c.classList.toggle('caps', settings.caps);
  els.flipWrap.classList.toggle('mirror-h', settings.mirrorH);
  els.flipWrap.classList.toggle('mirror-v', settings.mirrorV);
  els.guide.style.display = settings.guide ? '' : 'none';
  els.guide.style.top = guideY() + 'px';
  prompter.maxPos = Math.max(1, c.scrollHeight - window.innerHeight);
  prompter.pos = Math.min(prompter.pos, prompter.maxPos);
  computeLineData();
  applyTransform();
  updateSpeedLabel();
}

function applyTransform() {
  els.content.style.transform = `translateY(${-prompter.pos}px)`;
  const pct = (prompter.pos / prompter.maxPos) * 100;
  els.progressFill.style.width = pct.toFixed(2) + '%';
  updateHighlight();
}

function updateTimeLeft() {
  const remainPx = Math.max(0, prompter.maxPos - prompter.pos);
  const secs = Math.round(remainPx / Math.max(1, settings.speed));
  const m = Math.floor(secs / 60), s = secs % 60;
  els.timeLeft.textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function updateSpeedLabel() {
  els.speedValue.textContent = settings.speed;
  $('val-speed') && ($('val-speed').textContent = settings.speed);
}

let lastTimeUpdate = 0;
function frame(t) {
  if (prompter.playing) {
    if (prompter.lastT != null) {
      const dt = Math.min(0.1, (t - prompter.lastT) / 1000);
      prompter.pos += settings.speed * dt;
      if (prompter.pos >= prompter.maxPos) {
        prompter.pos = prompter.maxPos;
        setPlaying(false);
      }
      applyTransform();
    }
    prompter.lastT = t;
    if (t - lastTimeUpdate > 500) { updateTimeLeft(); lastTimeUpdate = t; }
  } else {
    prompter.lastT = null;
  }
  if (currentView === 'prompter') requestAnimationFrame(frame);
}

function setPlaying(on) {
  cancelCountdown();
  prompter.playing = on;
  els.playPauseBtn.textContent = on ? '⏸' : '▶';
  if (on) {
    scheduleBarsHide();
  } else {
    showBars();
    updateTimeLeft();
  }
}

function togglePlay() {
  if (prompter.playing) { setPlaying(false); return; }
  if (settings.countdown && !prompter.countdownTimer) {
    startCountdown();
  } else {
    setPlaying(true);
  }
}

function startCountdown() {
  let n = 3;
  els.countdown.hidden = false;
  els.countdown.textContent = n;
  prompter.countdownTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      cancelCountdown();
      setPlaying(true);
    } else {
      els.countdown.textContent = n;
    }
  }, 1000);
}
function cancelCountdown() {
  if (prompter.countdownTimer) {
    clearInterval(prompter.countdownTimer);
    prompter.countdownTimer = null;
  }
  els.countdown.hidden = true;
}

/* Bars auto-hide */
function showBars() {
  views.prompter.classList.remove('bars-hidden');
  scheduleBarsHide();
}
function scheduleBarsHide() {
  clearTimeout(prompter.hideTimer);
  if (prompter.playing) {
    prompter.hideTimer = setTimeout(() => {
      if (prompter.playing) views.prompter.classList.add('bars-hidden');
    }, 2500);
  }
}

/* Actions (used by both remote keys and on-screen buttons) */
const actionHandlers = {
  playPause: () => togglePlay(),
  faster: () => { settings.speed = Math.min(300, settings.speed + 5); saveSettings(); updateSpeedLabel(); updateTimeLeft(); },
  slower: () => { settings.speed = Math.max(10, settings.speed - 5); saveSettings(); updateSpeedLabel(); updateTimeLeft(); },
  back: () => { prompter.pos = Math.max(0, prompter.pos - window.innerHeight * 0.25); applyTransform(); updateTimeLeft(); },
  forward: () => { prompter.pos = Math.min(prompter.maxPos, prompter.pos + window.innerHeight * 0.25); applyTransform(); updateTimeLeft(); },
  restart: () => { prompter.pos = 0; applyTransform(); updateTimeLeft(); },
  fontUp: () => { settings.fontSize = Math.min(120, settings.fontSize + 4); saveSettings(); layoutContent(); },
  fontDown: () => { settings.fontSize = Math.max(24, settings.fontSize - 4); saveSettings(); layoutContent(); },
  exit: () => exitPrompter(),
};

function runAction(id) {
  const fn = actionHandlers[id];
  if (fn) fn();
}

/* ---------------- Prompter open/close ---------------- */
let wakeLock = null;
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not fatal */ }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentView === 'prompter') acquireWakeLock();
});

function openPrompter(id) {
  const s = scripts.find(x => x.id === id);
  if (!s) return;
  prompter.scriptId = id;
  prompter.pos = 0;
  prompter.playing = false;
  buildContent(s.body);
  els.promptTitle.textContent = s.title || 'Untitled';
  els.playPauseBtn.textContent = '▶';
  showView('prompter');
  layoutContent();
  updateTimeLeft();
  showBars();
  acquireWakeLock();
  requestAnimationFrame(frame);
}

function exitPrompter() {
  setPlaying(false);
  cancelCountdown();
  releaseWakeLock();
  renderLibrary();
  showView('library');
}

/* Prompter buttons */
$('btn-exit').onclick = () => exitPrompter();
$('btn-restart').onclick = () => runAction('restart');
$('btn-back').onclick = () => runAction('back');
$('btn-forward').onclick = () => runAction('forward');
$('btn-playpause').onclick = () => runAction('playPause');
$('btn-slower').onclick = () => runAction('slower');
$('btn-faster').onclick = () => runAction('faster');
$('btn-prompter-settings').onclick = () => { setPlaying(false); openSettings(); };
$('btn-fullscreen').onclick = () => {
  const d = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  } else {
    (d.requestFullscreen || d.webkitRequestFullscreen)?.call(d);
  }
};

/* Tap on the stage toggles play (but not taps on bars/buttons) */
els.stage.addEventListener('click', () => {
  if (!els.modal.hidden) return;
  togglePlay();
});
views.prompter.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.bar')) showBars();
});

window.addEventListener('resize', () => {
  if (currentView === 'prompter') layoutContent();
});

/* ---------------- Settings ---------------- */
function openSettings() {
  syncSettingsUI();
  renderKeymap();
  els.lastKey.textContent = 'Press a button on your remote…';
  els.modal.hidden = false;
}
$('btn-settings-close').onclick = () => {
  els.modal.hidden = true;
  captureForAction = null;
  if (currentView === 'prompter') layoutContent();
};
els.modal.addEventListener('click', (e) => {
  if (e.target === els.modal) $('btn-settings-close').onclick();
});

function bindRange(id, key, valId, fmt) {
  const input = $(id);
  input.addEventListener('input', () => {
    settings[key] = parseFloat(input.value);
    saveSettings();
    $(valId).textContent = fmt(settings[key]);
    if (currentView === 'prompter') layoutContent();
    if (key === 'speed') { updateSpeedLabel(); updateTimeLeft(); }
  });
}
bindRange('set-font', 'fontSize', 'val-font', v => v + 'px');
bindRange('set-lineheight', 'lineHeight', 'val-lineheight', v => v.toFixed(1));
bindRange('set-margin', 'margin', 'val-margin', v => v + '%');
bindRange('set-speed', 'speed', 'val-speed', v => v);

function bindToggle(id, key) {
  $(id).addEventListener('change', (e) => {
    settings[key] = e.target.checked;
    saveSettings();
    if (currentView === 'prompter') layoutContent();
  });
}
bindToggle('set-caps', 'caps');
bindToggle('set-mirror-h', 'mirrorH');
bindToggle('set-mirror-v', 'mirrorV');
bindToggle('set-guide', 'guide');
bindToggle('set-highlight', 'highlight');
bindToggle('set-countdown', 'countdown');

document.querySelectorAll('.swatch').forEach(btn => {
  btn.addEventListener('click', () => {
    settings.color = btn.dataset.color;
    saveSettings();
    syncSettingsUI();
    if (currentView === 'prompter') layoutContent();
  });
});

function syncSettingsUI() {
  $('set-font').value = settings.fontSize;
  $('val-font').textContent = settings.fontSize + 'px';
  $('set-lineheight').value = settings.lineHeight;
  $('val-lineheight').textContent = settings.lineHeight.toFixed(1);
  $('set-margin').value = settings.margin;
  $('val-margin').textContent = settings.margin + '%';
  $('set-speed').value = settings.speed;
  $('val-speed').textContent = settings.speed;
  $('set-caps').checked = settings.caps;
  $('set-mirror-h').checked = settings.mirrorH;
  $('set-mirror-v').checked = settings.mirrorV;
  $('set-guide').checked = settings.guide;
  $('set-highlight').checked = settings.highlight;
  $('set-countdown').checked = settings.countdown;
  document.querySelectorAll('.swatch').forEach(b =>
    b.classList.toggle('active', b.dataset.color === settings.color));
}

/* ---------------- Keymap UI ---------------- */
let captureForAction = null;

function renderKeymap() {
  els.keymapList.innerHTML = '';
  for (const action of ACTIONS) {
    const row = document.createElement('div');
    row.className = 'keymap-row';
    const name = document.createElement('div');
    name.className = 'action-name';
    name.textContent = action.label;
    row.appendChild(name);

    for (const [code, act] of Object.entries(keymap)) {
      if (act !== action.id) continue;
      const chip = document.createElement('span');
      chip.className = 'key-chip';
      chip.textContent = code;
      const x = document.createElement('button');
      x.textContent = '✕';
      x.title = 'Remove';
      x.onclick = () => { delete keymap[code]; saveKeymap(); renderKeymap(); };
      chip.appendChild(x);
      row.appendChild(chip);
    }

    const add = document.createElement('button');
    add.className = 'add-key';
    add.textContent = captureForAction === action.id ? 'press a key…' : '＋ map key';
    if (captureForAction === action.id) add.classList.add('capturing');
    add.onclick = () => {
      captureForAction = captureForAction === action.id ? null : action.id;
      renderKeymap();
    };
    row.appendChild(add);
    els.keymapList.appendChild(row);
  }
}

/* ---------------- Global key handling (Bluetooth remotes) ---------------- */
window.addEventListener('keydown', (e) => {
  const code = e.code || e.key;

  // Settings modal open → show what the remote sends + capture mapping
  if (!els.modal.hidden) {
    e.preventDefault();
    els.lastKey.textContent = `Remote sent: ${code}`;
    if (captureForAction) {
      keymap[code] = captureForAction;
      saveKeymap();
      captureForAction = null;
      renderKeymap();
    }
    return;
  }

  // Don't hijack typing in the editor / library
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;

  if (currentView !== 'prompter') return;

  const action = keymap[code];
  if (!action) return;
  e.preventDefault();
  if (action === 'playPause' && e.repeat) return;
  runAction(action);
  showBars();
});

/* ---------------- PWA ---------------- */
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ---------------- Boot ---------------- */
renderLibrary();
showView('library');

/* Debug handle (harmless in production) */
window.__tp = { prompter, get settings() { return settings; }, get keymap() { return keymap; }, runAction };
