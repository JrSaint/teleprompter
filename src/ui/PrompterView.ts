import type { Script, Settings } from '../store/db';
import { segmentScript } from '../core/segmenter';
import { PrompterController } from './controller';
import { WebSpeechSource } from '../core/speech/WebSpeechSource';
import { NativeSpeechSource } from '../core/speech/NativeSpeechSource';
import { renderPhrase } from './render';
import { fontPxForDistance } from './typography';
import { holdWakeLock, releaseWakeLock } from './wakelock';
import { diag, median, p90, type DiagSnapshot } from '../core/diag';
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
      <div id="vp-block">
        <div id="vp-current" aria-live="off"></div>
        <div id="vp-next"></div>
      </div>
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

  // Rig display mode: mirror + distance-derived size. Current and
  // next are the SAME size — one continuous script, emphasis by
  // brightness only — and the size is capped so the widest phrase of
  // THIS script fits on one line (never wrap mid-phrase).
  flip.classList.toggle('mirror-h', settings.mirrorH);
  flip.classList.toggle('mirror-v', settings.mirrorV);
  const baseFontPx = fontPxForDistance(settings.distanceFt, settings.sizeMult);
  const fitFontPx = (): number => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return baseFontPx;
    ctx.font = '700 100px -apple-system, system-ui, sans-serif';
    const widest = Math.max(1, ...phrases.map((p) => ctx.measureText(p.text).width));
    const avail = window.innerWidth * 0.88; // block padding is 6vw/side
    return Math.min(baseFontPx, Math.floor((avail / widest) * 100));
  };
  const applySize = () => {
    const px = fitFontPx() + 'px';
    curEl.style.fontSize = px;
    nextEl.style.fontSize = px;
  };
  applySize();
  window.addEventListener('resize', applySize);
  nextEl.style.opacity = String(settings.previewOpacity);

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
    if (d.speechToSwap.length > 0) {
      const s2s = d.speechToSwap;
      lines.splice(3, 0,
        `speech→swap ms: last ${s2s[s2s.length - 1]} · med ${median(s2s)} · p90 ${p90(s2s)} (n=${s2s.length})`);
    }
    if (d.emissionLag.length > 0) {
      lines.push(`emission ms: med ${median(d.emissionLag)} · p90 ${p90(d.emissionLag)} (n=${d.emissionLag.length})`);
    }
    if (d.vadLag.length > 0) {
      lines.push(`voice→token ms (rough): med ${median(d.vadLag)} · p90 ${p90(d.vadLag)} (n=${d.vadLag.length})`);
    }
    if (d.level >= 0) {
      const bars = Math.round(Math.min(100, d.level) / 10);
      lines.push(`mic level: ${'▮'.repeat(bars)}${'▯'.repeat(10 - bars)} ${d.level}`);
    }
    if (d.env) lines.push(`env: ${d.env.slice(0, 120)}`);
    for (const line of lines) {
      const div = document.createElement('div');
      div.textContent = line;
      diagBody.appendChild(div);
    }
  };

  // Engine per setting; NativeSpeechSource reports 'unavailable' when
  // chosen outside the installed app, which the status strip shows.
  const speech =
    settings.engine === 'native' ? new NativeSpeechSource() : new WebSpeechSource();
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
  }, { mode: settings.swapTiming });

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
      window.removeEventListener('resize', applySize);
      unsubDiag();
      controller.dispose();
      releaseWakeLock();
    },
  };
}
