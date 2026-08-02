import { saveSettings, type Script, type Settings } from '../store/db';
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

/* ---- Column mode (Erika's second-voice design, architect-accepted:
   the voice-stepped column). The active line is pinned at a fixed
   reading anchor; on each voice-driven advance the whole column takes
   ONE discrete ease-out step to bring the next phrase to the anchor,
   then is fully stationary. Holds, ad-libs and idle: zero drift,
   ever. Constant-velocity scrolling stays banned — text is never in
   motion while being read. -------------------------------------- */
/** One step's glide (tunable 150–250). */
const COLUMN_STEP_MS = 200;
/** Catch-up/far-skip: one LONGER step, never a cascade. */
const columnStepMs = (lines: number): number =>
  Math.min(250, COLUMN_STEP_MS + 25 * Math.max(0, lines - 1));
/** Gradient by distance from the active line (tunable). */
const COLUMN_TIERS: Record<number, number> = {
  [0]: 1, [1]: 0.65, [2]: 0.4, [3]: 0.2, [-1]: 0.45, [-2]: 0.25,
};
const COLUMN_FLOOR = 0.12;
const columnTier = (dist: number): number => COLUMN_TIERS[dist] ?? COLUMN_FLOOR;
/** Visible window, in lines — edges masked to black beyond it. */
const COLUMN_WINDOW = 7;
/** Reading anchor as a fraction of viewport height: rig glass =
    center / lens axis; direct reading sits slightly above center. */
const ANCHOR_RIG = 0.5;
const ANCHOR_DIRECT = 0.42;

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
      <div id="vp-colvp" hidden><div id="vp-col"></div></div>
      <div id="vp-done" hidden>— end of script —</div>
    </div>
    <div id="vp-status"></div>
    <div id="vp-diag" hidden>
      <div id="vp-diag-body"></div>
      <button id="vp-copylog" title="Copy session log to clipboard">⧉ Copy log</button>
      <label id="vp-ptserver" title="Dev flag (ship-gate fallback spike): pt-BR recognition via Apple servers. Applies on the NEXT session open.">
        <input type="checkbox" id="vp-ptserver-cb"> PT server (spike)
      </label>
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
  const isColumn = displayMode === 'column';
  const SLOTS = displayMode === 'ladder' ? 3 : 2;
  const NEXT_NEXT_DIM = Math.max(0.15, settings.previewOpacity - 0.25);
  const slotEls = [$('vp-slot0'), $('vp-slot1'), $('vp-slot2')];
  slotEls[2].hidden = SLOTS < 3;
  const colViewport = $('vp-colvp');
  const colEl = $('vp-col');
  colViewport.hidden = !isColumn;
  if (isColumn) $('vp-block').hidden = true;
  /** instant reposition, crossfade only (setting OR the OS ask) */
  const reduceMotion =
    settings.reduceMotion === true ||
    (typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches);
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
    if (isColumn) {
      colEl.style.fontSize = px;
      colLayout();
    }
  };
  // (invoked after the column machinery below is set up)

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

  /* ---- column machinery ------------------------------------------- */
  /** px height of one line (every phrase is exactly one nowrap line —
      the width-fit cap guarantees it) */
  let colLineH = 0;
  let colAnchorY = 0;
  const colAnchorFrac =
    settings.mirrorH || settings.mirrorV ? ANCHOR_RIG : ANCHOR_DIRECT;
  const colLines: HTMLElement[] = [];
  if (isColumn) {
    for (const ph of phrases) {
      const line = document.createElement('div');
      line.className = 'vp-colline';
      renderPhrase(line, ph);
      colEl.appendChild(line);
      colLines.push(line);
    }
  }

  /** measure + re-anchor + re-mask (resize / font change); instant */
  const colLayout = () => {
    if (!isColumn || colLines.length === 0) return;
    colLineH = colLines[0].offsetHeight || 1;
    colAnchorY = Math.round(window.innerHeight * colAnchorFrac);
    const half = (COLUMN_WINDOW / 2) * colLineH;
    const mask = `linear-gradient(to bottom, transparent ${colAnchorY - half - colLineH}px, black ${colAnchorY - half}px, black ${colAnchorY + half}px, transparent ${colAnchorY + half + colLineH}px)`;
    colViewport.style.maskImage = mask;
    colViewport.style.webkitMaskImage = mask;
    colPosition(false);
  };

  /** translate so the active line's CENTER sits exactly at the anchor */
  const colTranslateFor = (active: number): number =>
    Math.round(colAnchorY - colLineH / 2 - active * colLineH);

  let colShownIndex = 0;
  let colStepTimer: ReturnType<typeof setTimeout> | null = null;

  /** Reposition the column for phraseIndex. Animated = the ONE
      discrete step per voice-driven advance (collapse and far-skips
      arrive here as a single longer step — the controller already
      collapsed them); everything else is instant. Tiers crossfade
      alongside the step. */
  const colPosition = (animate: boolean) => {
    const from = colShownIndex;
    const to = phraseIndex;
    const y = colTranslateFor(to);
    const lines = Math.abs(to - from);
    const glide = animate && !reduceMotion && lines > 0;
    const dur = glide ? columnStepMs(lines) : 0;
    colEl.style.transition = glide
      ? `transform ${dur}ms cubic-bezier(0, 0, 0.2, 1)`
      : 'none';
    colEl.style.transform = `translateY(${y}px)`;
    for (let i = 0; i < colLines.length; i++) {
      const line = colLines[i];
      const tier = columnTier(i - to);
      line.style.transition = animate ? `opacity ${SWAP_FADE_MS}ms ease` : 'none';
      line.style.opacity = String(tier);
      line.style.fontWeight = i === to ? '700' : '600';
    }
    if (glide) {
      const distancePx = Math.abs(colTranslateFor(from) - y);
      controller.recorder.motion('step-start', from, to, distancePx, dur);
      if (colStepTimer) clearTimeout(colStepTimer);
      colStepTimer = setTimeout(() => {
        colStepTimer = null;
        controller.recorder.motion('step-end', from, to, distancePx, dur);
      }, dur);
    }
    colShownIndex = to;
  };

  applySize();
  window.addEventListener('resize', applySize);
  // the view is constructed DETACHED (show() appends it afterwards),
  // so line heights measure 0 here — re-measure and re-anchor on the
  // first attached frame, before the reader can notice
  if (isColumn) setTimeout(colLayout, 0);

  /** column render truth: the ±3 window's tiers, and post-settle the
      ACTIVE line's px offset from the anchor (dy) — position is now
      asserted, not assumed */
  const colWindow = (active: number): number[] => {
    const out: number[] = [];
    for (let i = Math.max(0, active - 3); i <= Math.min(phrases.length - 1, active + 3); i++) out.push(i);
    return out;
  };
  const colLogRender = () => {
    const seq = ++renderSeq;
    const active = phraseIndex;
    controller.recorder.render(
      'target', active,
      colWindow(active).map((i) => ({ p: i, tier: columnTier(i - active) })),
    );
    setTimeout(() => {
      if (seq !== renderSeq) return;
      controller.recorder.render(
        'settled', active,
        colWindow(active).map((i) => {
          const line = colLines[i];
          const entry: { p: number; tier: number; text?: string; dy?: number } = {
            p: i,
            tier: Math.round((parseFloat(getComputedStyle(line).opacity) || 0) * 100) / 100,
            text: (line.textContent ?? '').slice(0, 24),
          };
          if (i === active) {
            const r = line.getBoundingClientRect();
            entry.dy = Math.round((r.top + r.height / 2 - colAnchorY) * 10) / 10;
          }
          return entry;
        }),
      );
    }, Math.max(columnStepMs(9), SWAP_FADE_MS) + 150);
  };

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
    const tier = () => (target === null ? '0' : String(brightnessFor(target - phraseIndex)));
    const to = tier();
    const put = () => {
      slotSwapTimers[k] = null;
      renderPhrase(el, target === null ? null : phrases[target]);
      // tier recomputed at fire time: a put scheduled before an advance
      // must land at the slot's CURRENT role — the captured value left
      // the active line at a faded tier (B.3.6 finding)
      fadeTo(el, '0', tier());
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

  /** Render truth on tape (B.3.6): every render logs its intended
      slot assignments+tiers, and ~600ms later (puts + refill + fades
      done) the ACTUAL DOM text+opacity — unless a newer render
      superseded it. The harness asserts the active phrase's slot sits
      at the 100% tier with the right text. */
  let renderSeq = 0;
  const logRender = () => {
    const seq = ++renderSeq;
    const active = phraseIndex;
    controller.recorder.render(
      'target', active,
      slotShows.slice(0, SLOTS).map((p) => ({
        p, tier: p < 0 ? 0 : brightnessFor(p - active),
      })),
    );
    setTimeout(() => {
      if (seq !== renderSeq) return;
      controller.recorder.render(
        'settled', active,
        slotEls.slice(0, SLOTS).map((el, k) => ({
          p: slotShows[k],
          tier: Math.round((parseFloat(getComputedStyle(el).opacity) || 0) * 100) / 100,
          text: (el.textContent ?? '').slice(0, 24),
        })),
      );
    }, REFILL_DELAY_MS + SWAP_FADE_MS + 100);
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
    brightness: isColumn
      ? { active: 1, next: 0.65, nextNext: 0.4 }
      : {
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
      if (isColumn) {
        colViewport.hidden = finished;
        if (finished) {
          paintStatus();
          return;
        }
        // ONE discrete step to the fixed anchor per voice-driven
        // advance (the controller already collapsed gulps to a single
        // final target — a catch-up is one longer step, never a
        // cascade); everything else repositions instantly. Holds and
        // ad-libs never reach here: zero drift.
        colPosition(swapped);
        paintStatus();
        colLogRender();
        return;
      }
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
          // a pending two-phase put on the vacated slot would pop its
          // new content back up mid-vacate and the refill would then
          // double-pump it (B.3.6 flash audit) — cancel it; the refill
          // re-syncs this slot from scratch
          const orphan = slotSwapTimers[vacated];
          if (orphan) {
            clearTimeout(orphan);
            slotSwapTimers[vacated] = null;
          }
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
      logRender();
    },
    onFlow: (s) => {
      flowState = s;
      armBtn.textContent = controller.running ? '⏸ Pause' : '🎙 Start';
      paintStatus();
      paintDiag(diag.snapshot());
    },
    onMic: (s, detail) => paintStatus(s, detail),
  }, {
    mode: settings.swapTimingByLang[script.lang] ?? 'lead',
    header,
    allowServer: script.lang === 'pt-BR' && settings.ptServerAssisted === true,
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

  {
    const cb = el.querySelector('#vp-ptserver-cb') as HTMLInputElement;
    cb.checked = settings.ptServerAssisted === true;
    cb.onchange = () => {
      settings.ptServerAssisted = cb.checked;
      void saveSettings(settings);
      cb.blur(); // Space must stay arm/pause, never re-toggle the flag
    };
  }
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
