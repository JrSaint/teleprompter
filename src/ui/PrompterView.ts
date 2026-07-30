import type { Script, Settings } from '../store/db';
import { segmentScript } from '../core/segmenter';
import { PrompterController } from './controller';
import { WebSpeechSource } from '../core/speech/WebSpeechSource';
import { renderPhrase } from './render';
import { fontPxForDistance } from './typography';
import { holdWakeLock, releaseWakeLock } from './wakelock';
import { diag, median, type DiagSnapshot } from '../core/diag';
import type { FlowState } from '../core/flow';

export interface PrompterViewHandle {
  el: HTMLElement;
  controller: PrompterController;
  dispose(): void;
}

/**
 * The rig display. One phrase large and centered, the next dimmed
 * below as preview. Swaps are instant — no scrolling, no animation.
 * Status strip and diagnostics overlay stay un-mirrored.
 */
export function createPrompterView(
  script: Script,
  settings: Settings,
  onExit: () => void,
): PrompterViewHandle {
  const phrases = segmentScript(script.body, script.lang);
  const el = document.createElement('div');
  el.id = 'prompter-view';
  el.innerHTML = `
    <div id="vp-flip">
      <div id="vp-current" aria-live="off"></div>
      <div id="vp-next"></div>
      <div id="vp-done" hidden>— end of script —</div>
    </div>
    <div id="vp-status"></div>
    <div id="vp-diag" hidden>
      <div id="vp-diag-body"></div>
      <button id="vp-copylog" title="Copy session log to clipboard">⧉ Copy log</button>
    </div>
    <div id="vp-bar">
      <button id="vp-exit" title="Exit (Esc)">✕</button>
      <button id="vp-prev" title="Previous phrase (←)">‹</button>
      <button id="vp-arm" title="Start / pause (Space)">🎙 Start</button>
      <button id="vp-next-btn" title="Next phrase (→)">›</button>
      <button id="vp-restart" title="Restart (R)">⟲</button>
      <button id="vp-diag-btn" title="Diagnostics (D)">◔</button>
    </div>`;

  const $ = (id: string) => el.querySelector<HTMLElement>('#' + id)!;
  const flip = $('vp-flip');
  const curEl = $('vp-current');
  const nextEl = $('vp-next');
  const doneEl = $('vp-done');
  const statusEl = $('vp-status');
  const diagEl = $('vp-diag');
  const armBtn = $('vp-arm');

  // Rig display mode: mirror + distance-derived size
  flip.classList.toggle('mirror-h', settings.mirrorH);
  flip.classList.toggle('mirror-v', settings.mirrorV);
  const fontPx = fontPxForDistance(settings.distanceFt, settings.sizeMult);
  curEl.style.fontSize = fontPx + 'px';
  nextEl.style.fontSize = Math.round(fontPx * 0.55) + 'px';

  let flowState: FlowState = 'idle';
  let phraseIndex = 0;

  const diagBody = $('vp-diag-body');

  const paintStatus = (mic = controller.mic, detail = '') => {
    const pos = `${Math.min(phraseIndex + 1, phrases.length)}/${phrases.length}`;
    const heal = controller.healed ? '~  ·  ' : '';
    statusEl.textContent = `${heal}${flowState}  ·  mic: ${mic}${detail ? ` (${detail})` : ''}  ·  ${pos}`;
  };

  const paintDiag = (d: DiagSnapshot) => {
    if (diagEl.hidden) return;
    const gaps = d.restartGaps.slice(-5).map((g) => `${g}`).join(', ') || '—';
    const lat = d.advanceLatencies;
    const last = lat.length ? lat[lat.length - 1] : null;
    diagBody.innerHTML = '';
    const lines = [
      `restarts: ${d.restartCount}`,
      `gaps ms: ${gaps}`,
      `advance ms: last ${last ?? '—'} · med ${lat.length ? median(lat) : '—'} (n=${lat.length})`,
      `state: ${flowState}`,
    ];
    for (const line of lines) {
      const div = document.createElement('div');
      div.textContent = line;
      diagBody.appendChild(div);
    }
  };

  const speech = new WebSpeechSource();
  const controller = new PrompterController(script, phrases, speech, {
    onPhrase: (cur, nxt, i) => {
      phraseIndex = i;
      const finished = cur === null;
      doneEl.hidden = !finished;
      curEl.hidden = finished;
      nextEl.hidden = finished;
      renderPhrase(curEl, cur);
      renderPhrase(nextEl, nxt);
      paintStatus();
    },
    onFlow: (s) => {
      flowState = s;
      armBtn.textContent = controller.running ? '⏸ Pause' : '🎙 Start';
      paintStatus();
      paintDiag(diag.snapshot());
    },
    onMic: (s, detail) => paintStatus(s, detail),
  });

  const unsubDiag = diag.subscribe(paintDiag);
  diagEl.hidden = !settings.diagOverlay;

  // Controls: fixed keys per spec (BT clickers present as keyboards)
  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    switch (e.code) {
      case 'Space':
      case 'Enter':
        e.preventDefault();
        if (!e.repeat) toggleArm();
        break;
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault();
        controller.next();
        break;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        controller.prev();
        break;
      case 'KeyR':
        e.preventDefault();
        controller.restart();
        break;
      case 'KeyD':
        e.preventDefault();
        toggleDiag();
        break;
      case 'Escape':
        e.preventDefault();
        onExit();
        break;
    }
  };
  window.addEventListener('keydown', onKey);

  const toggleArm = () => {
    if (controller.running) controller.stopMic();
    else controller.arm();
  };
  const toggleDiag = () => {
    diagEl.hidden = !diagEl.hidden;
    paintDiag(diag.snapshot());
  };

  $('vp-copylog').onclick = async () => {
    const log = controller.recorder.current();
    if (!log) return;
    const btn = $('vp-copylog');
    try {
      await navigator.clipboard.writeText(JSON.stringify(log));
      btn.textContent = '✓ Copied';
    } catch {
      btn.textContent = '✕ Copy failed';
    }
    setTimeout(() => (btn.textContent = '⧉ Copy log'), 1500);
  };

  $('vp-exit').onclick = onExit;
  $('vp-prev').onclick = () => controller.prev();
  $('vp-next-btn').onclick = () => controller.next();
  $('vp-restart').onclick = () => controller.restart();
  $('vp-diag-btn').onclick = toggleDiag;
  armBtn.onclick = toggleArm;

  holdWakeLock();
  controller.begin();
  paintStatus();

  return {
    el,
    controller,
    dispose() {
      window.removeEventListener('keydown', onKey);
      unsubDiag();
      controller.dispose();
      releaseWakeLock();
    },
  };
}
