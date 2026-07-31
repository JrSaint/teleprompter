import type { Phrase } from '../core/segmenter';
import { PhraseMatcher, type MatchEvent } from '../core/matcher';
import { Flow, type FlowState } from '../core/flow';
import type { SpeechSource, SpeechStatus } from '../core/speech/SpeechSource';
import { diag, median, p90 } from '../core/diag';
import { FlightRecorder, type SessionEvent } from '../core/recorder';
import { FlowModel, FLOW_HOLD_MS } from '../core/flowpredict';
import { saveSessionLog } from '../store/db';
import { parseAliases } from '../core/aliases';
import type { Lang } from '../core/text';

/** Silence/ad-lib window before "following" degrades to "holding".
    Single source of truth with replay's Flow holding reconstruction. */
const HOLD_AFTER_MS = FLOW_HOLD_MS;
/** Post-restart window where next-phrase evidence alone may advance. */
const GRACE_MS = 2000;
/** Stall self-heal: holding at least this long with next-phrase evidence. */
const HEAL_AFTER_MS = 4000;
/** Visible dwell per phrase when one result clump crosses several
    boundaries — step through them, never jump-cut. */
const STEP_DWELL_MS = 180;
/** Throttled autosave of the in-flight session log. */
const AUTOSAVE_MS = 5000;

export interface ControllerEvents {
  onPhrase: (current: Phrase | null, next: Phrase | null, index: number, total: number) => void;
  onFlow: (state: FlowState) => void;
  onMic: (status: SpeechStatus, detail?: string) => void;
}

/**
 * Wires speech → matcher → display. Owns the state machine and the
 * flight recorder. The display advances only because words were
 * recognized (or the stall self-heal stepped in, marked as such);
 * silence and ad-libbing hold, exactly per the locked design.
 */
export class PrompterController {
  readonly flow = new Flow();
  readonly recorder = new FlightRecorder();
  /** True after a self-heal until the next natural advance ("~"). */
  healed = false;

  private matcher: PhraseMatcher;
  private phrases: Phrase[];
  private vocabulary: string[] = [];
  private speech: SpeechSource;
  private ev: ControllerEvents;
  private locale: string;
  private micStatus: SpeechStatus = 'idle';

  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private healTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private graceUntil = 0;
  private wasRestarting = false;

  private stepQueue: Array<number | 'end'> = [];
  private stepTimer: ReturnType<typeof setTimeout> | null = null;

  /** Metric samples for the current listening stretch (ms) —
      summarized into the log when the mic stops. */
  private s2sSamples: number[] = [];
  private emissionSamples: number[] = [];
  private vadSamples: number[] = [];
  /** Pending voice-onset wallclock awaiting its first token arrival. */
  private pendingOnsetWall: number | null = null;
  /** Last token-batch arrival — onsets during active token flow are
      mid-speech artifacts, not silence breaks. */
  private lastTokenArrival = -Infinity;

  /** Flow mode: predictive swap machinery. */
  private flowEnabled = false;
  private flowModel = new FlowModel();
  private flowTimer: ReturnType<typeof setTimeout> | null = null;
  /** Highest phrase reached on real evidence — Flow may run at most
      one phrase beyond it (no predictive chains). */
  private evidencedAt = 0;

  constructor(
    script: { title: string; lang: Lang; body: string; aliases?: string },
    phrases: Phrase[],
    speech: SpeechSource,
    ev: ControllerEvents,
    opts: { mode?: 'lead' | 'confirm' | 'flow' } = {},
  ) {
    this.phrases = phrases;
    const mode = opts.mode ?? 'lead';
    this.flowEnabled = mode === 'flow';
    const aliasMap = parseAliases(script.aliases);
    this.matcher = new PhraseMatcher(phrases, {
      // Flow builds on lead's evidence rules; prediction sits on top
      leadMode: mode !== 'confirm',
      aliases: aliasMap,
    });
    // Vocabulary priming for engines that support it: the script's
    // words in DISPLAY form (case + diacritics intact — folded forms
    // weaken pt-BR biasing) plus alias targets.
    this.vocabulary = [
      ...new Set([
        ...phrases.flatMap((p) =>
          p.words
            .map((w) => w.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
            .filter((w) => w.length > 1),
        ),
        ...new Set(aliasMap.values()),
      ]),
    ].slice(0, 120);
    this.speech = speech;
    this.locale = script.lang;
    this.ev = ev;

    this.recorder.start(script, {
      swapTiming: mode,
      // index → text; decisions are index-only and unanalyzable
      // after the fact without the list the session actually used
      phrases: phrases.map((p) => p.text),
    });
    this.saveTimer = setInterval(() => this.persistLog(), AUTOSAVE_MS);

    this.flow.onChange = (s) => {
      this.recorder.state(s);
      if (s === 'holding') this.scheduleHeal();
      else this.cancelHeal();
      this.ev.onFlow(s);
    };

    speech.onStatus = (s, detail) => {
      // side-channel events from the native engine: environment report
      // and ~1Hz audio level — recorded and shown, never treated as a
      // mic-state change
      if (s === 'env') {
        this.recorder.mic('env', detail);
        diag.setEnv(detail ?? '');
        return;
      }
      if (s === 'level') {
        this.recorder.mic('level', detail);
        diag.setLevel(Number(detail));
        return;
      }
      if (s === 'voice-onset') {
        // buffer-resolution voice-activity onset (epoch ms) — the
        // emission-lag fallback: correlated with the next token
        // arrival when segment timestamps are zeroed. Onsets landing
        // while tokens are still flowing are mid-speech energy dips
        // resolving, not a silence break — discard them.
        this.recorder.mic('voice-onset', detail);
        const epoch = Number(detail);
        if (
          Number.isFinite(epoch) &&
          performance.now() - this.lastTokenArrival > 1200
        ) {
          this.pendingOnsetWall = epoch - performance.timeOrigin;
        }
        return;
      }
      this.micStatus = s;
      this.recorder.mic(s, detail);
      // grace window opens when a restart completes; a restart also
      // invalidates any onset awaiting correlation
      if (s === 'restarting') {
        this.wasRestarting = true;
        this.pendingOnsetWall = null;
      }
      else if (s === 'listening' && this.wasRestarting) {
        this.wasRestarting = false;
        this.graceUntil = performance.now() + GRACE_MS;
      }
      this.ev.onMic(s, detail);
      // Terminal mic failure: never sit in "armed" claiming to listen.
      if ((s === 'denied' || s === 'unavailable') && this.running) {
        this.stopMic();
      }
    };
    speech.onWords = (words, isFinal, meta) => this.consume(words, isFinal, meta);
  }

  /** Feed recognized (or simulated) words through the matcher. */
  consume(words: string[], isFinal = true, meta?: import('../core/speech/SpeechSource').WordsMeta): void {
    if (this.flow.state === 'idle' || this.flow.state === 'finished') return;
    const t0 = performance.now();
    words.forEach((w, i) => {
      const lag = meta?.emissionLagMs?.[i];
      this.recorder.token(w, isFinal, lag ?? undefined);
      // belt against clock-skew/revision artifacts the source missed
      if (lag !== null && lag !== undefined && lag >= 0 && lag < 5000) {
        this.emissionSamples.push(lag);
        diag.emissionLag(lag);
      }
    });
    // VAD fallback: correlate the latest quiet→voice onset with this
    // (first-after-onset) token arrival — a rough emission lag
    if (this.pendingOnsetWall !== null) {
      const lag = Math.round(t0 - this.pendingOnsetWall);
      this.pendingOnsetWall = null;
      if (lag > 0 && lag < 4000) {
        this.vadSamples.push(lag);
        diag.vadLag(lag);
      }
    }
    this.lastTokenArrival = t0;

    const from = this.matcher.current;
    // Snapshot BEFORE the feed: a decision's curPct must describe the
    // phrase the rule fired FROM, not the fresh phrase after the move
    // (the post-move snapshot misread as "zero-evidence advances" on
    // the first rig tape).
    const pre = this.matcher.progressSnapshot();
    const res = this.matcher.feed(words, {
      grace: performance.now() < this.graceUntil,
    });

    // Flow pace model: confirmed content words feed the rate; an
    // unmatched tail suspends prediction until evidence resumes.
    if (this.flowEnabled) {
      for (let i = 0; i < res.contentHits; i++) this.flowModel.noteContent(t0);
      if (res.matchedAny && res.lastWordMatched) this.flowModel.noteMatched();
      else if (words.length > 0 && !res.lastWordMatched) this.flowModel.noteUnmatched();
    }

    const recorded: Array<SessionEvent | null> = [];
    if (res.events.length > 0) {
      // multi-decision batches: each event's `from` is the previous
      // event's landing point, not the pre-batch position
      let prevAt = from;
      for (const e of res.events) {
        recorded.push(this.recorder.decision({
          action: e.type, rule: e.rule, from: prevAt, to: e.to,
          curPct: pre.pct, ahead: pre.ahead, evidence: e.evidence,
        }));
        diag.event(`${e.type} (${e.rule}, ev ${e.evidence}) → phrase ${e.to + 1}`);
        prevAt = e.to;
      }
      // rule-based moves are real evidence — Flow's chain rail resets
      this.evidencedAt = this.matcher.current;
      this.healed = false;
    } else {
      // every consumed batch logs its decision, matched or not — an
      // unmatched stretch (ad-lib after a hold) must not go dark in
      // the tape (B.3 finding: EN t=107781–109184 logged nothing)
      const snap = this.matcher.progressSnapshot();
      this.recorder.decision({
        action: 'hold', rule: 'none', from, to: from,
        curPct: snap.pct, ahead: snap.ahead, evidence: 0,
      });
    }

    if (res.matchedAny) {
      if (this.flow.state === 'armed' || this.flow.state === 'holding') {
        this.flow.to('following');
      }
      this.bumpHoldTimer();
    }
    this.scheduleFlowPredict();

    if (res.events.length > 0) {
      this.pushSteps(res.events, res.finished);
      // measure event-receipt → first painted swap (double rAF = after
      // paint), and — when the engine provides word audio timestamps —
      // the true speech-to-swap: triggering word's audio time vs paint.
      // SFSpeechRecognizer partial results can carry zero timestamps
      // until finalization — a 0 audio time would poison the metric
      const lastAudioEnd =
        meta?.audioEndMs?.length ? meta.audioEndMs[meta.audioEndMs.length - 1] : 0;
      const spokenWall =
        lastAudioEnd > 0 && meta?.audioAnchorMs !== undefined
          ? meta.audioAnchorMs + lastAudioEnd
          : null;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const paint = performance.now();
          diag.advanceLatency(paint - t0);
          if (spokenWall !== null) {
            const ms = Math.round(paint - spokenWall);
            diag.speechToSwap(ms);
            this.s2sSamples.push(ms);
            // patch the metric onto this batch's decision events —
            // the log is serialized later, so the reference sticks
            for (const r of recorded) {
              if (r?.kind === 'decision') r.speechToSwapMs = ms;
            }
          }
        }),
      );
    }

    if (res.finished) {
      this.flow.to('finished');
      this.stopMic(false);
    }
  }

  /* --- clump stepping: never jump-cut past a phrase ---------------- */
  private pushSteps(events: MatchEvent[], finished: boolean): void {
    for (const e of events) this.stepQueue.push(e.to);
    if (finished) this.stepQueue.push('end');
    if (!this.stepTimer) this.drainSteps();
  }

  private drainSteps(): void {
    const next = this.stepQueue.shift();
    if (next === undefined) {
      this.stepTimer = null;
      return;
    }
    this.renderAt(next);
    if (this.stepQueue.length === 0) {
      this.stepTimer = null;
      return;
    }
    this.stepTimer = setTimeout(() => this.drainSteps(), STEP_DWELL_MS);
  }

  private clearSteps(): void {
    this.stepQueue = [];
    if (this.stepTimer) clearTimeout(this.stepTimer);
    this.stepTimer = null;
  }

  private renderAt(i: number | 'end'): void {
    if (i === 'end') {
      this.ev.onPhrase(null, null, this.phrases.length - 1, this.phrases.length);
      return;
    }
    this.ev.onPhrase(
      this.phrases[i] ?? null,
      this.phrases[i + 1] ?? null,
      i,
      this.phrases.length,
    );
  }

  /* --- hold + stall self-heal -------------------------------------- */
  private bumpHoldTimer(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      if (this.flow.state === 'following') this.flow.to('holding');
    }, HOLD_AFTER_MS);
  }

  private scheduleHeal(): void {
    this.cancelHeal();
    this.healTimer = setTimeout(() => this.tryHeal(), HEAL_AFTER_MS);
  }

  private cancelHeal(): void {
    if (this.healTimer) clearTimeout(this.healTimer);
    this.healTimer = null;
  }

  private tryHeal(): void {
    if (
      this.flow.state !== 'holding' ||
      this.micStatus !== 'listening' ||
      // never compound forced advances: healing while the display sits
      // on a flow-PREDICTED (unevidenced) phrase would move it two
      // phrases past real evidence
      (this.flowEnabled && this.matcher.current !== this.evidencedAt) ||
      this.matcher.unambiguousEvidence(this.matcher.current + 1) < 1
    ) {
      // keep watching while the hold lasts
      if (this.flow.state === 'holding') this.scheduleHeal();
      return;
    }
    const from = this.matcher.current;
    const pre = this.matcher.progressSnapshot();
    const e = this.matcher.forceAdvance();
    if (!e) return;
    this.recorder.decision({
      action: 'heal', rule: 'self-heal', from, to: e.to,
      curPct: pre.pct, ahead: pre.ahead, evidence: e.evidence,
    });
    diag.event(`self-heal → phrase ${e.to + 1}`);
    this.healed = true;
    this.pushSteps([e], this.matcher.finished);
    if (this.matcher.finished) {
      this.flow.to('finished');
      this.stopMic(false);
    } else {
      this.scheduleHeal();
    }
  }

  /* --- Flow mode: predictive swap ---------------------------------- */

  /** (Re)arm the prediction timer after every consumed batch. All
      rails re-check at fire time — the timer is only a wake-up. */
  private scheduleFlowPredict(): void {
    if (this.flowTimer) clearTimeout(this.flowTimer);
    this.flowTimer = null;
    if (!this.flowEnabled || this.matcher.finished) return;
    // chain rail: predict only from the evidenced frontier
    if (this.matcher.current !== this.evidencedAt) return;
    const w = this.flowWindow();
    if (!w) return;
    const now = performance.now();
    if (now > w.deadline) return; // pause, not missed speech
    this.flowTimer = setTimeout(
      () => this.fireFlowPredict(),
      Math.max(0, w.fireAt - now),
    );
  }

  private flowWindow(): { fireAt: number; deadline: number; rateMs: number } | null {
    const cur = this.matcher.current;
    // banked lookahead credit alone must not seed a prediction — the
    // speaker has to have demonstrably entered the phrase
    if (!this.matcher.touched) return null;
    const total = this.phrases[cur]?.contentIdx.length ?? 0;
    const hits = this.matcher.contentMatchedCount(cur);
    if (total === 0) return null;
    return this.flowModel.window(total - hits, hits / total);
  }

  private fireFlowPredict(): void {
    this.flowTimer = null;
    if (
      !this.flowEnabled ||
      this.flow.state !== 'following' || // suppressed in holding/armed
      this.micStatus !== 'listening' ||
      this.matcher.finished ||
      this.matcher.current !== this.evidencedAt
    ) return;
    const w = this.flowWindow();
    const now = performance.now();
    if (!w || now < w.fireAt || now > w.deadline) return;
    const from = this.matcher.current;
    const pre = this.matcher.progressSnapshot();
    const remaining =
      (this.phrases[from]?.contentIdx.length ?? 0) -
      this.matcher.contentMatchedCount(from);
    const e = this.matcher.flowAdvance();
    if (!e) return;
    const elapsedMs = Math.round(now - (this.flowModel.lastContentT ?? now));
    this.recorder.decision({
      action: 'advance', rule: e.rule, from, to: e.to,
      curPct: pre.pct, ahead: pre.ahead, evidence: e.evidence,
      flow: { rateMs: Math.round(w.rateMs), elapsedMs, remaining },
    });
    diag.event(`flow-predict (rate ${Math.round(w.rateMs)}ms, ev ${e.evidence}) → phrase ${e.to + 1}`);
    this.pushSteps([e], this.matcher.finished);
    // no rescheduling here: the chain rail (current > evidencedAt)
    // blocks further predictions until real evidence advances
  }

  /* --- lifecycle ----------------------------------------------------- */

  /** Space: arm (mic on, waiting for the current phrase). */
  arm(): void {
    if (this.flow.state === 'finished') this.restart();
    this.flow.to('armed');
    this.speech.start(this.locale, this.vocabulary);
    this.bumpHoldTimer();
  }

  /** Space again: back to idle, mic off. Never loses position. */
  stopMic(toIdle = true): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.cancelHeal();
    this.speech.stop();
    if (toIdle && this.flow.state !== 'finished') this.flow.to('idle');
    if (this.flowTimer) clearTimeout(this.flowTimer);
    this.flowTimer = null;
    this.pendingOnsetWall = null; // an onset never outlives its stretch
    // one metric summary per listening stretch — THE numbers this
    // phase exists to produce. Emission lag prefers real segment
    // timestamps; the VAD-onset correlation is the rough fallback
    // when the engine zeroes them.
    if (this.s2sSamples.length + this.emissionSamples.length + this.vadSamples.length > 0) {
      const lag =
        this.emissionSamples.length > 0
          ? {
              count: this.emissionSamples.length,
              medianMs: median(this.emissionSamples),
              p90Ms: p90(this.emissionSamples),
              source: 'segments' as const,
            }
          : this.vadSamples.length > 0
            ? {
                count: this.vadSamples.length,
                medianMs: median(this.vadSamples),
                p90Ms: p90(this.vadSamples),
                source: 'vad-onset' as const,
              }
            : undefined;
      this.recorder.summary(
        {
          count: this.s2sSamples.length,
          medianMs: median(this.s2sSamples),
          p90Ms: p90(this.s2sSamples),
        },
        lag,
      );
      this.s2sSamples = [];
      this.emissionSamples = [];
      this.vadSamples = [];
    }
    this.persistLog();
  }

  get running(): boolean {
    return this.flow.state !== 'idle' && this.flow.state !== 'finished';
  }

  get mic(): SpeechStatus {
    return this.micStatus;
  }

  private persistLog(): void {
    const log = this.recorder.current();
    if (log && log.events.length > 0) void saveSessionLog(log);
  }

  /* Manual navigation — remote clicker / keyboard. Backward is allowed
     manually; the matcher itself never goes backward on its own. */
  next(): void {
    this.clearSteps();
    this.matcher.goTo(this.matcher.current + 1);
    this.resetFlowPredict();
    if (this.flow.state === 'finished') this.flow.to('idle');
    this.healed = false;
    this.renderAt(this.matcher.current);
  }

  prev(): void {
    this.clearSteps();
    this.matcher.goTo(this.matcher.current - 1);
    this.resetFlowPredict();
    if (this.flow.state === 'finished') this.flow.to('idle');
    this.healed = false;
    this.renderAt(this.matcher.current);
  }

  restart(): void {
    this.clearSteps();
    this.matcher.goTo(0);
    this.resetFlowPredict();
    if (this.flow.state === 'finished') this.flow.to('idle');
    this.healed = false;
    this.renderAt(this.matcher.current);
  }

  /** Manual navigation moved the frontier — prediction state resets. */
  private resetFlowPredict(): void {
    this.evidencedAt = this.matcher.current;
    this.flowModel.reset();
    if (this.flowTimer) clearTimeout(this.flowTimer);
    this.flowTimer = null;
  }

  /** Initial render. */
  begin(): void {
    this.renderAt(this.matcher.current);
  }

  dispose(): void {
    this.stopMic();
    this.clearSteps();
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = null;
    this.persistLog();
    this.recorder.end();
  }
}
