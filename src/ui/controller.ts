import type { Phrase } from '../core/segmenter';
import { PhraseMatcher, type MatchEvent } from '../core/matcher';
import { Flow, type FlowState } from '../core/flow';
import type { SpeechSource, SpeechStatus } from '../core/speech/SpeechSource';
import { diag, median, p90 } from '../core/diag';
import { FlightRecorder, type SessionEvent, type SessionHeader } from '../core/recorder';
import { LagSampler, STALE_SAMPLE_MS, BATCH_MIN_TOKENS } from '../core/latency';
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
/** Render-quiet window: an advance arriving within this of the last
    render defers (and later arrivals collapse into it) — one settled
    transition instead of a double-pump. Widened 250→400ms in B.3.6:
    the flash audit found advance pairs at 250–400ms rendering as two
    back-to-back transitions, the second landing while the first's
    crossfade + refill were still settling. Display stepping only;
    decision logs are unchanged. */
const STEP_DWELL_MS = 400;
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
  /** performance.now() of the last MATCHED token — Glide's voice
      governor: the column only moves while this is fresh. */
  lastMatchedAt = 0;
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
  /** Onset↔token correlation with full accounting (core/latency.ts) —
      the metric must say why n is low, never silently read 0. */
  private vadSampler = new LagSampler();
  private s2sInvalid = 0;
  /** the next fresh non-batch feed carries a NEW phrase's first token */
  private awaitingPhraseFirst = false;
  /** Bumped when a stretch's summary is emitted: a paint-frame sample
      from a closed stretch is discarded, never leaked into the next
      (verify finding: the finished advance's rAF lands post-summary). */
  private stretchSeq = 0;

  private allowServer = false;

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
    opts: {
      mode?: 'lead' | 'confirm' | 'flow';
      header?: SessionHeader;
      /** pt-BR ship-gate fallback (spike-gated, no UI): recognition
          via Apple's servers instead of on-device. EN never sets it. */
      allowServer?: boolean;
    } = {},
  ) {
    this.phrases = phrases;
    const mode = opts.mode ?? 'lead';
    this.allowServer = opts.allowServer === true;
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
      // render facts (display mode, brightness, computed font px…) —
      // the tape must prove what was on screen, not assume it
      header: opts.header,
    });
    this.saveTimer = setInterval(() => this.persistLog(), AUTOSAVE_MS);

    this.flow.onChange = (s) => {
      this.recorder.state(s);
      if (s === 'holding') {
        this.scheduleHeal();
        // a hold means the silence was an ad-lib/pause — the pending
        // onset would pair with whatever token ends it: not latency
        this.vadSampler.hold();
      } else this.cancelHeal();
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
      if (s === 'rotating' || s === 'prewarmed') {
        // task lifecycle side-channel: recorded for the tapes (the
        // rotation hypothesis needs them), never a mic-state change
        this.recorder.mic(s, detail);
        return;
      }
      if (s === 'voice-onset') {
        // buffer-resolution voice-activity onset (epoch ms) — the
        // emission-lag fallback: correlated with the next fresh token
        // arrival when segment timestamps are zeroed. EVERY onset
        // opens (or refreshes) the pending sample — the old "only
        // after 1200ms of token silence" guard discarded 8 of the EN
        // tape's 10 onsets (B.3.3 finding 2).
        this.recorder.mic('voice-onset', detail);
        const epoch = Number(detail);
        if (Number.isFinite(epoch)) {
          this.vadSampler.onset(epoch - performance.timeOrigin);
        }
        return;
      }
      this.micStatus = s;
      this.recorder.mic(s, detail);
      // grace window opens when a restart completes; a restart also
      // invalidates any onset awaiting correlation
      if (s === 'restarting') {
        this.wasRestarting = true;
        this.vadSampler.restart();
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
      if (lag !== null && lag !== undefined && lag >= 0 && lag <= STALE_SAMPLE_MS) {
        this.emissionSamples.push(lag);
        diag.emissionLag(lag);
      }
    });
    // VAD fallback: correlate the latest quiet→voice onset with the
    // first FRESH token arrival — a rough emission lag. Tokens inside
    // a re-emission batch (≥4 sharing one arrival) never close a
    // sample, and a pair further apart than 3s is stale re-statement
    // age, not engine latency — counted and excluded, never reported.
    // A re-emission batch: the source says so directly (pureAppend
    // false), or — when the source can't tell — ≥4 tokens at one
    // arrival. A legitimate long pure append still closes samples.
    const isBatch =
      meta?.pureAppend !== undefined
        ? !meta.pureAppend
        : words.length >= BATCH_MIN_TOKENS;
    {
      const lag = this.vadSampler.tokens(t0, isBatch);
      if (lag !== null) diag.vadLag(lag);
      // phrase-boundary sampling: a new phrase's first fresh token may
      // pair with recent unconsumed VAD activity (fluent reading
      // yields few quiet→voice onsets — B.3.4 finding 2)
      if (this.awaitingPhraseFirst && !isBatch && words.length > 0) {
        this.awaitingPhraseFirst = false;
        const b = this.vadSampler.phraseFirstToken(t0);
        if (b !== null) diag.vadLag(b);
      }
    }

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
      this.awaitingPhraseFirst = true;
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

    if (res.matchedAny) this.lastMatchedAt = performance.now();
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
      // A re-emission batch's audio times are re-statement history —
      // an advance IT triggers must not sample speech-to-swap (the PT
      // tape's 11189ms "pair" spanned the red-line pause via a batch).
      const lastAudioEnd =
        meta?.audioEndMs?.length ? meta.audioEndMs[meta.audioEndMs.length - 1] : 0;
      const spokenWall =
        !isBatch && lastAudioEnd > 0 && meta?.audioAnchorMs !== undefined
          ? meta.audioAnchorMs + lastAudioEnd
          : null;
      const stretch = this.stretchSeq;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (stretch !== this.stretchSeq) return; // stretch closed
          const paint = performance.now();
          diag.advanceLatency(paint - t0);
          if (spokenWall !== null) {
            const ms = Math.round(paint - spokenWall);
            if (ms > 0 && ms <= STALE_SAMPLE_MS) {
              diag.speechToSwap(ms);
              this.s2sSamples.push(ms);
              // patch the metric onto this batch's decision events —
              // the log is serialized later, so the reference sticks
              for (const r of recorded) {
                if (r?.kind === 'decision') r.speechToSwapMs = ms;
              }
            } else {
              this.s2sInvalid++;
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

  /* --- catch-up collapse (B.3.5): a gulp of ≥2 advances renders as
     ONE transition to the final position — the A.2-era step-with-dwell
     rule predates ladder and Flow, and its intermediate hops were the
     founder's "flash". Anything queued but not yet rendered collapses
     too; skipped positions are logged as display-collapsed (decision
     logs are untouched). Single advances keep the ≥STEP_DWELL_MS
     spacing so back-to-back feeds still never lurch. --------------- */
  private lastStepAt = -Infinity;

  private pushSteps(events: MatchEvent[], finished: boolean): void {
    const targets: Array<number | 'end'> = events.map((e) => e.to);
    if (finished) targets.push('end');
    const skipped = [...this.stepQueue, ...targets.slice(0, -1)]
      .filter((x): x is number => x !== 'end');
    if (skipped.length > 0) {
      this.recorder.mic('display-collapsed', skipped.join(','));
    }
    this.stepQueue = [targets[targets.length - 1]];
    if (this.stepTimer) return; // the pending timer renders the new final
    const wait = this.lastStepAt + STEP_DWELL_MS - performance.now();
    if (wait > 0) {
      this.stepTimer = setTimeout(() => this.drainSteps(), wait);
    } else {
      this.drainSteps();
    }
  }

  private drainSteps(): void {
    const next = this.stepQueue.shift();
    if (next === undefined) {
      this.stepTimer = null;
      return;
    }
    this.lastStepAt = performance.now();
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

  /** Rolling ms-per-content-word (the Flow pace model, noted in every
      swap-timing mode) — Glide's base velocity source. */
  paceMsPerWord(): number | null {
    return this.flowModel.medianRate();
  }

  /** Unmatched-token suspension (the Flow rail) — Glide's predictive
      target freezes under exactly the same condition. */
  flowSuspended(): boolean {
    return this.flowModel.suspended;
  }

  /** One reason line per phrase+cause: why prediction is currently
      impossible — stall audits classify rail suppression from the
      tape instead of guessing (B.3.5 finding 2). */
  private lastRailLogKey = '';
  private logRail(reason: string): void {
    const key = `${this.matcher.current}:${reason}`;
    if (key === this.lastRailLogKey) return;
    this.lastRailLogKey = key;
    this.recorder.mic('flow-rail', `phrase ${this.matcher.current + 1}: ${reason}`);
  }

  private railReason(): string | null {
    if (this.matcher.current !== this.evidencedAt) return 'chain-rail';
    if (!this.matcher.touched) return 'untouched';
    const total = this.phrases[this.matcher.current]?.contentIdx.length ?? 0;
    if (total === 0) return 'no-content';
    if (this.flowModel.suspended) return 'suspended (unmatched token)';
    const hits = this.matcher.contentMatchedCount(this.matcher.current);
    if (hits / total < 0.5) return `below-arm (${hits}/${total} content)`;
    if (this.flowModel.medianRate() === null) return 'cold-model (warm-up)';
    return null;
  }

  /** (Re)arm the prediction timer after every consumed batch. All
      rails re-check at fire time — the timer is only a wake-up. */
  private scheduleFlowPredict(): void {
    if (this.flowTimer) clearTimeout(this.flowTimer);
    this.flowTimer = null;
    if (!this.flowEnabled || this.matcher.finished) return;
    const reason = this.railReason();
    if (reason) {
      this.logRail(reason);
      return;
    }
    const w = this.flowWindow();
    if (!w) return;
    const now = performance.now();
    if (now > w.deadline) {
      this.logRail('overdue (pause, defer to hold)');
      return;
    }
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
    if (!this.flowEnabled || this.matcher.finished) return;
    if (this.flow.state !== 'following') {
      this.logRail(`suppressed (${this.flow.state})`);
      return;
    }
    if (this.micStatus !== 'listening') {
      this.logRail(`suppressed (mic ${this.micStatus})`);
      return;
    }
    if (this.matcher.current !== this.evidencedAt) return;
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
    // every measured distribution starts fresh per session — stale
    // overlay stats masked two whole reads (B.3.4 finding 1)
    diag.resetSession();
    this.flow.to('armed');
    this.speech.start(this.locale, this.vocabulary, { allowServer: this.allowServer });
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
    this.vadSampler.restart(); // an onset never outlives its stretch
    // one metric summary per listening stretch — THE numbers this
    // phase exists to produce. Emission lag reports the RICHER source
    // (real segment timestamps vs the VAD-onset correlation), and a
    // low sample count explains itself instead of reading as silence.
    const seg = this.emissionSamples;
    const vad = this.vadSampler.samples;
    const boundary = this.vadSampler.boundarySamples;
    const lag =
      seg.length >= vad.length && seg.length > 0
        ? { count: seg.length, medianMs: median(seg), p90Ms: p90(seg), source: 'segments' as const }
        : vad.length > 0
          ? { count: vad.length, medianMs: median(vad), p90Ms: p90(vad), source: 'vad-onset' as const }
          : undefined;
    // invalidSamples documents ONLY stale onset↔token pairs; excluded
    // speech-to-swap pairs are a different metric and ride with it
    const invalidSamples = this.vadSampler.invalid;
    const voidedByHold = this.vadSampler.voidedByHold;
    const activity =
      this.s2sSamples.length + seg.length + vad.length +
      invalidSamples + voidedByHold;
    if (activity > 0) {
      const note =
        (lag?.count ?? 0) < 8
          ? `low n: ${voidedByHold} onsets voided by holds, ` +
            `${invalidSamples} stale pairs excluded, ` +
            `segment timestamps usable on ${seg.length} tokens`
          : undefined;
      this.recorder.summary(
        {
          count: this.s2sSamples.length,
          medianMs: median(this.s2sSamples),
          p90Ms: p90(this.s2sSamples),
          ...(this.s2sInvalid ? { invalid: this.s2sInvalid } : {}),
        },
        lag,
        { invalidSamples, voidedByHold, note },
        boundary.length > 0
          ? { count: boundary.length, medianMs: median(boundary), p90Ms: p90(boundary) }
          : undefined,
      );
      this.s2sSamples = [];
      this.emissionSamples = [];
      this.vadSampler.reset();
      this.s2sInvalid = 0;
    }
    this.awaitingPhraseFirst = false;
    this.stretchSeq++;
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
