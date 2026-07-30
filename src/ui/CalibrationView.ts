import type { Settings } from '../store/db';
import type { Lang } from '../core/text';
import { WebSpeechSource } from '../core/speech/WebSpeechSource';
import { holdWakeLock, releaseWakeLock } from './wakelock';

export interface CalibrationViewHandle {
  el: HTMLElement;
  dispose(): void;
}

/**
 * Mic check from the speaker's mark: start listening and stream every
 * recognized word to the screen so recognition can be verified with the
 * rig hood zipped. The large "R" proves mirror orientation through the
 * glass — if it reads correctly, the flip settings are right.
 */
export function createCalibrationView(
  settings: Settings,
  lang: Lang,
  onExit: () => void,
): CalibrationViewHandle {
  const el = document.createElement('div');
  el.id = 'calibration-view';
  el.innerHTML = `
    <div id="cal-flip">
      <div id="cal-r">R</div>
      <div id="cal-words"></div>
    </div>
    <div id="cal-bar">
      <button id="cal-exit">✕ Close</button>
      <button id="cal-start" class="primary">🎙 Start mic check</button>
      <span id="cal-status">idle</span>
      <span id="cal-lang">${lang}</span>
    </div>`;

  const $ = (id: string) => el.querySelector<HTMLElement>('#' + id)!;
  const flipEl = $('cal-flip');
  flipEl.classList.toggle('mirror-h', settings.mirrorH);
  flipEl.classList.toggle('mirror-v', settings.mirrorV);

  const wordsEl = $('cal-words');
  const statusEl = $('cal-status');
  const startBtn = $('cal-start');

  const speech = new WebSpeechSource();
  let running = false;
  let shown: string[] = [];

  speech.onWords = (words) => {
    shown.push(...words);
    shown = shown.slice(-14);
    wordsEl.textContent = shown.join(' ');
  };
  speech.onStatus = (s, detail) => {
    statusEl.textContent = detail ? `${s} (${detail})` : s;
  };

  const toggle = () => {
    if (running) {
      speech.stop();
      startBtn.textContent = '🎙 Start mic check';
    } else {
      shown = [];
      wordsEl.textContent = '';
      speech.start(lang);
      startBtn.textContent = '⏸ Stop';
    }
    running = !running;
  };

  startBtn.onclick = toggle;
  $('cal-exit').onclick = onExit;
  holdWakeLock();

  return {
    el,
    dispose() {
      speech.stop();
      releaseWakeLock();
    },
  };
}
