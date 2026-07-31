import {
  type Script, type Settings,
  loadScripts, saveScripts, saveSettings,
} from '../store/db';
import type { Lang } from '../core/text';
import { segmentScript } from '../core/segmenter';
import { stripMarkup } from '../core/markup';
import { fontPxForDistance } from './typography';

export interface SetupViewHandle {
  el: HTMLElement;
  dispose(): void;
}

export interface SetupCallbacks {
  onPrompt: (script: Script) => void;
  onCalibrate: (lang: Lang) => void;
}

const CHECKLIST = [
  'iPad brightness at maximum',
  'Auto-Lock off (Settings › Display & Brightness)',
  'Rig hood zipped, glass clean, camera centered',
  'Verify mirroring with the calibration “R”',
  'Do a mic check from your standing mark',
];

export function createSetupView(
  scripts: Script[],
  settings: Settings,
  cb: SetupCallbacks,
): SetupViewHandle {
  const el = document.createElement('div');
  el.id = 'setup-view';
  let editing: Script | null = null;

  const persistScripts = async () => {
    await saveScripts(scripts);
  };
  const persistSettings = async () => {
    await saveSettings(settings);
  };

  function render(): void {
    if (editing) return renderEditor(editing);
    renderList();
  }

  function renderList(): void {
    el.innerHTML = `
      <header class="su-header">
        <h1>Voice Prompter</h1>
        <div>
          <button id="su-import" class="ghost">Import .txt</button>
          <button id="su-calibrate" class="ghost">🎙 Calibration</button>
          <button id="su-new" class="primary">＋ New Script</button>
        </div>
      </header>
      <main class="su-main">
        <section id="su-list"></section>
        <aside class="su-side">
          <div class="su-card" id="su-settings"></div>
          <div class="su-card">
            <h3>Rig checklist</h3>
            <ul class="su-check">${CHECKLIST.map((c) => `<li>${c}</li>`).join('')}</ul>
          </div>
        </aside>
      </main>
      <input type="file" id="su-file" hidden accept=".txt,.md,text/plain">`;

    const list = el.querySelector<HTMLElement>('#su-list')!;
    if (scripts.length === 0) {
      list.innerHTML = `<div class="su-empty">No scripts yet. Tap <b>＋ New Script</b> — use “/” in the text to force a phrase break.</div>`;
    }
    for (const s of [...scripts].sort((a, b) => b.updated - a.updated)) {
      const phrases = segmentScript(s.body, s.lang);
      const words = stripMarkup(s.body).trim().split(/\s+/).filter(Boolean).length;
      const card = document.createElement('div');
      card.className = 'su-card su-script';
      card.innerHTML = `
        <h2></h2>
        <div class="su-meta">${s.lang === 'pt-BR' ? '🇧🇷 pt-BR' : '🇺🇸 en-US'} · ${words} words · ${phrases.length} phrases</div>
        <div class="su-preview"></div>
        <div class="su-actions">
          <button class="primary act-prompt">▶ Prompt</button>
          <button class="ghost act-edit">Edit</button>
          <button class="act-delete">Delete</button>
        </div>`;
      card.querySelector('h2')!.textContent = s.title || 'Untitled';
      card.querySelector('.su-preview')!.textContent = stripMarkup(s.body).slice(0, 160);
      (card.querySelector('.act-prompt') as HTMLButtonElement).onclick = () => cb.onPrompt(s);
      (card.querySelector('.act-edit') as HTMLButtonElement).onclick = () => {
        editing = s;
        render();
      };
      (card.querySelector('.act-delete') as HTMLButtonElement).onclick = () => {
        if (confirm(`Delete “${s.title || 'Untitled'}”?`)) {
          scripts.splice(scripts.indexOf(s), 1);
          void persistScripts();
          render();
        }
      };
      list.appendChild(card);
    }

    renderSettingsCard();

    (el.querySelector('#su-new') as HTMLButtonElement).onclick = () => {
      const s: Script = {
        id: crypto.randomUUID(),
        title: '',
        body: '',
        lang: 'en-US',
        updated: Date.now(),
      };
      scripts.push(s);
      editing = s;
      void persistScripts();
      render();
    };
    (el.querySelector('#su-calibrate') as HTMLButtonElement).onclick = () => {
      const lastLang = scripts[0]?.lang ?? 'en-US';
      cb.onCalibrate(lastLang);
    };
    const file = el.querySelector('#su-file') as HTMLInputElement;
    (el.querySelector('#su-import') as HTMLButtonElement).onclick = () => file.click();
    file.onchange = () => {
      const f = file.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        scripts.push({
          id: crypto.randomUUID(),
          title: f.name.replace(/\.(txt|md)$/i, ''),
          body: String(reader.result),
          lang: 'en-US',
          updated: Date.now(),
        });
        void persistScripts();
        render();
      };
      reader.readAsText(f);
      file.value = '';
    };
  }

  function renderSettingsCard(): void {
    const card = el.querySelector<HTMLElement>('#su-settings');
    if (!card) return;
    const fontPx = fontPxForDistance(settings.distanceFt, settings.sizeMult);
    card.innerHTML = `
      <h3>Display</h3>
      <label class="su-row"><span>Standing distance <b>${settings.distanceFt} ft</b></span>
        <input type="range" id="set-dist" min="3" max="10" step="0.5" value="${settings.distanceFt}"></label>
      <label class="su-row"><span>Text size <b>×${settings.sizeMult.toFixed(1)} → ${fontPx}px</b></span>
        <input type="range" id="set-mult" min="1" max="2" step="0.1" value="${settings.sizeMult}"></label>
      <label class="su-row su-toggle"><span>Mirror horizontally (rig glass)</span>
        <input type="checkbox" id="set-mh" ${settings.mirrorH ? 'checked' : ''}></label>
      <label class="su-row su-toggle"><span>Mirror vertically</span>
        <input type="checkbox" id="set-mv" ${settings.mirrorV ? 'checked' : ''}></label>
      <label class="su-row su-toggle"><span>Diagnostics overlay</span>
        <input type="checkbox" id="set-diag" ${settings.diagOverlay ? 'checked' : ''}></label>
      <label class="su-row"><span>Swap timing</span>
        <select id="set-swap">
          <option value="lead" ${settings.swapTiming === 'lead' ? 'selected' : ''}>Lead (early swap)</option>
          <option value="confirm" ${settings.swapTiming === 'confirm' ? 'selected' : ''}>Confirm (on completion)</option>
          <option value="flow" ${settings.swapTiming === 'flow' ? 'selected' : ''}>Flow (predicts from your pace — experimental)</option>
        </select></label>
      <label class="su-row"><span>Preview brightness <b>${Math.round(settings.previewOpacity * 100)}%</b></span>
        <input type="range" id="set-preview" min="30" max="80" step="5" value="${Math.round(settings.previewOpacity * 100)}"></label>
      <label class="su-row"><span>Speech engine</span>
        <select id="set-engine">
          <option value="web" ${settings.engine === 'web' ? 'selected' : ''}>Web (Safari)</option>
          <option value="native" ${settings.engine === 'native' ? 'selected' : ''}>Native (iPad app)</option>
        </select></label>
      <div class="su-engine-hint" id="engine-hint">${
        settings.engine === 'native'
          ? 'Native recognition runs entirely on this iPad — audio never leaves the device. Requires the installed app. First use of a language downloads its speech model (needs internet once).'
          : 'Web recognition may route audio through Apple’s servers.'
      }</div>`;
    (card.querySelector('#set-dist') as HTMLInputElement).oninput = (e) => {
      settings.distanceFt = parseFloat((e.target as HTMLInputElement).value);
      void persistSettings();
      renderSettingsCard();
    };
    (card.querySelector('#set-mult') as HTMLInputElement).oninput = (e) => {
      settings.sizeMult = parseFloat((e.target as HTMLInputElement).value);
      void persistSettings();
      renderSettingsCard();
    };
    (card.querySelector('#set-mh') as HTMLInputElement).onchange = (e) => {
      settings.mirrorH = (e.target as HTMLInputElement).checked;
      void persistSettings();
    };
    (card.querySelector('#set-mv') as HTMLInputElement).onchange = (e) => {
      settings.mirrorV = (e.target as HTMLInputElement).checked;
      void persistSettings();
    };
    (card.querySelector('#set-diag') as HTMLInputElement).onchange = (e) => {
      settings.diagOverlay = (e.target as HTMLInputElement).checked;
      void persistSettings();
    };
    (card.querySelector('#set-swap') as HTMLSelectElement).onchange = (e) => {
      settings.swapTiming = (e.target as HTMLSelectElement).value as 'lead' | 'confirm' | 'flow';
      void persistSettings();
    };
    (card.querySelector('#set-preview') as HTMLInputElement).oninput = (e) => {
      settings.previewOpacity = parseInt((e.target as HTMLInputElement).value, 10) / 100;
      void persistSettings();
      renderSettingsCard();
    };
    (card.querySelector('#set-engine') as HTMLSelectElement).onchange = (e) => {
      settings.engine = (e.target as HTMLSelectElement).value as 'web' | 'native';
      void persistSettings();
      renderSettingsCard();
    };
  }

  function renderEditor(s: Script): void {
    el.innerHTML = `
      <header class="su-header">
        <button id="ed-back" class="ghost">‹ Scripts</button>
        <input id="ed-title" placeholder="Untitled script" autocomplete="off">
        <select id="ed-lang">
          <option value="en-US">English (en-US)</option>
          <option value="pt-BR">Português (pt-BR)</option>
        </select>
        <button id="ed-prompt" class="primary">▶ Prompt</button>
      </header>
      <div id="ed-tools">
        <span class="ed-hint">“/” forces a phrase break · color selected text:</span>
        ${['yellow', 'orange', 'red', 'green', 'blue', 'purple']
          .map((c) => `<button class="ed-color" data-c="${c}"></button>`)
          .join('')}
        <button id="ed-clear">Clear color</button>
        <span id="ed-count" class="ed-hint"></span>
      </div>
      <textarea id="ed-aliases" rows="2" spellcheck="false"
        title="Aliases are a manual patch: the recognizer's mangling varies run to run, so a list can trail reality. The durable fix is the native engine's vocabulary priming."
        placeholder="Aliases (what the recognizer says → script word), one per line — e.g.  prompter: peter, pro, pt.  Manual patch only: mangling varies per run; native vocabulary priming is the durable fix."></textarea>
      <textarea id="ed-body" placeholder="Paste or type the script… Use / to force a phrase break." spellcheck="false"></textarea>`;

    const title = el.querySelector('#ed-title') as HTMLInputElement;
    const langSel = el.querySelector('#ed-lang') as HTMLSelectElement;
    const body = el.querySelector('#ed-body') as HTMLTextAreaElement;
    const aliases = el.querySelector('#ed-aliases') as HTMLTextAreaElement;
    const count = el.querySelector('#ed-count') as HTMLElement;
    title.value = s.title;
    langSel.value = s.lang;
    body.value = s.body;
    aliases.value = s.aliases ?? '';

    const INK: Record<string, string> = {
      yellow: '#ffd60a', orange: '#ff9f0a', red: '#ff453a',
      green: '#30d158', blue: '#64d2ff', purple: '#bf5af2',
    };
    el.querySelectorAll<HTMLButtonElement>('.ed-color').forEach((btn) => {
      btn.style.background = INK[btn.dataset.c!];
      btn.addEventListener('pointerdown', (e) => e.preventDefault());
      btn.onclick = () => {
        const st = body.selectionStart, en = body.selectionEnd;
        const sel = body.value.slice(st, en);
        const ins = `{${btn.dataset.c}:${sel}}`;
        body.value = body.value.slice(0, st) + ins + body.value.slice(en);
        const caret = sel ? st + ins.length : st + btn.dataset.c!.length + 2;
        body.setSelectionRange(caret, caret);
        body.focus();
        save();
      };
    });
    const clearBtn = el.querySelector('#ed-clear') as HTMLButtonElement;
    clearBtn.addEventListener('pointerdown', (e) => e.preventDefault());
    clearBtn.onclick = () => {
      const st = body.selectionStart, en = body.selectionEnd;
      if (st === en) return;
      const cleaned = stripMarkup(body.value.slice(st, en));
      body.value = body.value.slice(0, st) + cleaned + body.value.slice(en);
      body.setSelectionRange(st, st + cleaned.length);
      body.focus();
      save();
    };

    const save = () => {
      s.title = title.value.trim();
      s.lang = langSel.value as Lang;
      s.body = body.value;
      s.aliases = aliases.value;
      s.updated = Date.now();
      const phrases = segmentScript(s.body, s.lang);
      count.textContent = `${phrases.length} phrases`;
      void persistScripts();
    };
    title.addEventListener('input', save);
    langSel.addEventListener('change', save);
    body.addEventListener('input', save);
    aliases.addEventListener('input', save);
    save();

    (el.querySelector('#ed-back') as HTMLButtonElement).onclick = () => {
      save();
      if (!s.title && !s.body.trim()) scripts.splice(scripts.indexOf(s), 1);
      void persistScripts();
      editing = null;
      render();
    };
    (el.querySelector('#ed-prompt') as HTMLButtonElement).onclick = () => {
      save();
      cb.onPrompt(s);
    };
    if (!s.title) title.focus();
  }

  render();
  return {
    el,
    dispose() {
      /* nothing persistent to tear down */
    },
  };
}

/** Re-fetch scripts (used when returning from the prompter). */
export { loadScripts };
