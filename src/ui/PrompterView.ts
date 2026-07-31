import type { Script, Settings } from '../store/db';
import { segmentScript, SEGMENTER_VERSION } from '../core/segmenter';
import type { SessionHeader } from '../core/recorder';
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

/** Swap crossfade: brightness eases over this long, both directions.
    Tunable 100–250ms. Light moves, text doesn't — position never
    animates on the prompter screen (design law). */
const SWAP_FADE_MS = 150;
/** Vacated-slot refill: content changes only after the crossfade has
    completed plus a beat — never inside the swap the reader is riding
    (B.3.3 addendum c: the ~150ms-post-swap refill read as a flicker). */
const REFILL_DELAY_MS = SWAP_FADE_MS + 200;

/**
 * The rig display. Fixed slots, stationary text, brightness-only
 * emphasis — the line being read brightens IN PLACE. Karaoke: two
 * slots, roles alternate. Ladder: three slots read strictly downward,
 * wrapping back to the top (book-style return sweep). Swaps never
 * scroll and never animate position. Status strip and diagnostics
 * overlay stay un-mirrored.
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
        <div class="vp-slot" id="vp-slot0" aria-live="off"></div>
        <div class="vp-slot" id="vp-slot1"></div>
        <div class="vp-slot" id="vp-slot2"></div>
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
  const blockEl = $('vp-block');
  const doneEl = $('vp-done');
  const statusEl = $('vp-status');
  const diagEl = $('vp-diag');
  const armBtn = $('vp-arm');

  // Display pattern: karaoke (2 slots, alternating roles) is the
  // default; ladder (3 slots, strictly downward with a wrap to the
  // top) is the A/B alternative. First phrase starts in the TOP slot
  // in both modes (index 0 → slot 0).
  const displayMode = settings.displayMode ?? 'karaoke';
  const SLOTS = displayMode === 'ladder' ? 3 : 2;
  const NEXT_NEXT_DIM = Math.max(0.15, settings.previewOpacity - 0.25);
  const slotEls = [$('vp-slot0'), $('vp-slot1'), $('vp-slot2')];
  slotEls[2].hidden = SLOTS < 3;
  /** brightness by distance from the active phrase */
  const brightnessFor = (dist: number): number =>
    dist <= 0 ? 1 : dist === 1 ? settings.previewOpacity : NEXT_NEXT_DIM;

  // Rig display mode: mirror + distance-derived size. Every slot is
  // the SAME size — one continuous script, emphasis by brightness
  // only — and the size is capped so the widest phrase of THIS script
  // fits on one line (never wrap mid-phrase).
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
    for (const s of slotEls) s.style.fontSize = px;
  };
  applySize();
  window.addEventListener('resize', applySize);

  /** Ease an element's brightness from → to over SWAP_FADE_MS. */
  const fadeTo = (elm: HTMLElement, from: string, to: string) => {
    elm.style.transition = 'none';
    elm.style.opacity = from;
    void elm.offsetWidth; // commit the start value before easing
    elm.style.transition = `opacity ${SWAP_FADE_MS}ms ease`;
    elm.style.opacity = to;
  };
  /** Ease from wherever the element actually is — hardcoded from-
      values pop when a fade lands mid-flight (verify finding). */
  const fadeCurrent = (elm: HTMLElement, to: string) => {
    fadeTo(elm, getComputedStyle(elm).opacity, to);
  };
  const setOpacity = (elm: HTMLElement, to: string) => {
    elm.style.transition = 'none';
    elm.style.opacity = to;
  };

  let flowState: FlowState = 'idle';
  let phraseIndex = 0;

  /** which phrase each slot displays (-1 = dark/empty) */
  const slotShows = [-1, -1, -1];
  let refillTimer: ReturnType<typeof setTimeout> | null = null;

  /** The phrase slot k should show while `active` is current: one of
      active..active+SLOTS-1 by index-modulo, or null past the end. */
  const targetFor = (k: number, active: number): number | null => {
    for (let d = 0; d < SLOTS; d++) {
      const p = active + d;
      if (p >= phrases.length) break;
      if (p % SLOTS === k) return p;
    }
    return null;
  };

  /** Two-phase content replacement mid-fade timers, one per slot —
      visible text always fades OUT before its slot's content changes
      (crossfade both directions, never a hard cut). */
  const slotSwapTimers: Array<ReturnType<typeof setTimeout> | null> = [null, null, null];

  const setSlot = (k: number, target: number | null, animate: boolean) => {
    const timer = slotSwapTimers[k];
    if (timer) {
      clearTimeout(timer);
      slotSwapTimers[k] = null;
    }
    const el = slotEls[k];
    const to = target === null ? '0' : String(brightnessFor(target - phraseIndex));
    const put = () => {
      slotSwapTimers[k] = null;
      renderPhrase(el, target === null ? null : phrases[target]);
      fadeTo(el, '0', to);
    };
    slotShows[k] = target ?? -1;
    if (!animate) {
      renderPhrase(el, target === null ? null : phrases[target]);
      setOpacity(el, to);
      return;
    }
    const cur = parseFloat(getComputedStyle(el).opacity) || 0;
    if (cur <= 0.05) {
      put();
      return;
    }
    fadeTo(el, String(cur), '0');
    slotSwapTimers[k] = setTimeout(put, SWAP_FADE_MS);
  };

  /** Bring every slot to its target content AND brightness — content
      via setSlot, and role brightness re-applied even when the content
      already matches (a far-skip must never leave the live line dim —
      verify finding). Idempotent, computed from the live index. */
  const syncSlots = (animate: boolean) => {
    for (let k = 0; k < SLOTS; k++) {
      const target = targetFor(k, phraseIndex);
      if (slotShows[k] === target) {
        if (slotSwapTimers[k] === null) {
          const to = target === null ? '0' : String(brightnessFor(target - phraseIndex));
          if (animate) fadeCurrent(slotEls[k], to);
          else setOpacity(slotEls[k], to);
        }
        continue;
      }
      setSlot(k, target, animate);
    }
  };

  const scheduleRefill = () => {
    if (refillTimer) clearTimeout(refillTimer);
    refillTimer = setTimeout(() => {
      refillTimer = null;
      syncSlots(true);
    }, REFILL_DELAY_MS);
  };

  /** A pending refill must land BEFORE the next swap is processed —
      otherwise clumped advances (250ms dwell < 350ms refill) find the
      entering slot empty and hard-cut (verify finding). */
  const flushRefill = () => {
    if (refillTimer) {
      clearTimeout(refillTimer);
      refillTimer = null;
      syncSlots(true);
    }
  };

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
  // Render facts for the session header — the tape proves what was on
  // screen (display pattern, brightness, the computed font px, and
  // which segmenter cut the phrase list).
  const header: SessionHeader = {
    displayMode,
    crossfadeMs: SWAP_FADE_MS,
    brightness: {
      active: 1,
      next: settings.previewOpacity,
      ...(SLOTS === 3 ? { nextNext: NEXT_NEXT_DIM } : {}),
    },
    fontPx: fitFontPx(),
    distanceFt: settings.distanceFt,
    sizeMult: settings.sizeMult,
    segmenterVersion: SEGMENTER_VERSION,
    phraseCount: phrases.length,
    meanWordsPerPhrase:
      Math.round(
        (phrases.reduce((n, p) => n + p.words.length, 0) /
          Math.max(1, phrases.length)) * 10,
      ) / 10,
  };
  const controller = new PrompterController(script, phrases, speech, {
    onPhrase: (cur, _nxt, i) => {
      const prev = phraseIndex;
      const swapped = i !== prev;
      phraseIndex = i;
      const finished = cur === null;
      doneEl.hidden = !finished;
      blockEl.hidden = finished;
      if (finished) {
        if (refillTimer) clearTimeout(refillTimer);
        refillTimer = null;
        paintStatus();
        return;
      }
      // Brightness only — no positional animation, ever (design law:
      // light moves, text doesn't).
      if (!swapped && slotShows[i % SLOTS] !== i) {
        // initial paint (or a repaint): steady state, no fades
        syncSlots(false);
      } else if (swapped) {
        // a pending refill lands first, so clumped advances always
        // find their entering slot previewing (no hard cuts)
        flushRefill();
        if (i === prev + 1 && slotShows[i % SLOTS] === i) {
          // the entering line brightens IN PLACE — its text was
          // already previewing in its slot; the deeper preview steps
          // up one level; the vacated slot fades dark and refills
          // only after the crossfade + a beat (never mid-swap)
          fadeCurrent(slotEls[i % SLOTS], '1');
          if (SLOTS === 3 && slotShows[(i + 1) % SLOTS] === i + 1) {
            fadeCurrent(slotEls[(i + 1) % SLOTS], String(settings.previewOpacity));
          }
          const vacated = prev % SLOTS;
          fadeCurrent(slotEls[vacated], '0');
          slotShows[vacated] = -1; // stale content, refill pending
          scheduleRefill();
        } else {
          // manual nav, restart, or a far-skip landing — full re-sync
          // (two-phase content swaps, brightness re-applied)
          syncSlots(true);
        }
      }
      paintStatus();
    },
    onFlow: (s) => {
      flowState = s;
      armBtn.textContent = controller.running ? '⏸ Pause' : '🎙 Start';
      paintStatus();
      paintDiag(diag.snapshot());
    },
    onMic: (s, detail) => paintStatus(s, detail),
  }, { mode: settings.swapTimingByLang[script.lang] ?? 'lead', header });

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
      if (refillTimer) clearTimeout(refillTimer);
      for (const t of slotSwapTimers) if (t) clearTimeout(t);
      unsubDiag();
      controller.dispose();
      releaseWakeLock();
    },
  };
}
