import type { Phrase } from '../core/segmenter';
import { PhraseMatcher, type MatchEvent } from '../core/matcher';
import { Flow, type FlowState } from '../core/flow';
import type { SpeechSource, SpeechStatus } from '../core/speech/SpeechSource';
import { diag } from '../core/diag';
import { FlightRecorder } from '../core/recorder';
import { saveSessionLog } from '../store/db';
import type { Lang } from '../core/text';

/** Silence/ad-lib window before "following" degrades to "holding". */
const HOLD_AFTER_MS = 2500;
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

  constructor(
    script: { title: string; lang: Lang; body: string },
    phrases: Phrase[],
    speech: SpeechSource,
    ev: ControllerEvents,
  ) {
    this.phrases = phrases;
    this.matcher = new PhraseMatcher(phrases);
    this.speech = speech;
    this.locale = script.lang;
    this.ev = ev;

    this.recorder.start(script);
    this.saveTimer = setInterval(() => this.persistLog(), AUTOSAVE_MS);

    this.flow.onChange = (s) => {
      this.recorder.state(s);
      if (s === 'holding') this.scheduleHeal();
      else this.cancelHeal();
      this.ev.onFlow(s);
    };

    speech.onStatus = (s, detail) => {
      this.micStatus = s;
      this.recorder.mic(s, detail);
      // grace window opens when a restart completes
      if (s === 'restarting') this.wasRestarting = true;
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
    speech.onWords = (words, isFinal) => this.consume(words, isFinal);
  }

  /** Feed recognized (or simulated) words through the matcher. */
  consume(words: string[], isFinal = true): void {
    if (this.flow.state === 'idle' || this.flow.state === 'finished') return;
    for (const w of words) this.recorder.token(w, isFinal);

    const t0 = performance.now();
    const from = this.matcher.current;
    // Snapshot BEFORE the feed: a decision's curPct must describe the
    // phrase the rule fired FROM, not the fresh phrase after the move
    // (the post-move snapshot misread as "zero-evidence advances" on
    // the first rig tape).
    const pre = this.matcher.progressSnapshot();
    const res = this.matcher.feed(words, {
      grace: performance.now() < this.graceUntil,
    });

    if (res.events.length > 0) {
      for (const e of res.events) {
        this.recorder.decision({
          action: e.type, rule: e.rule, from, to: e.to,
          curPct: pre.pct, ahead: pre.ahead, evidence: e.evidence,
        });
        diag.event(`${e.type} (${e.rule}, ev ${e.evidence}) → phrase ${e.to + 1}`);
      }
      this.healed = false;
    } else if (res.matchedAny) {
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

    if (res.events.length > 0) {
      this.pushSteps(res.events, res.finished);
      // measure event-receipt → first painted swap (double rAF = after paint)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => diag.advanceLatency(performance.now() - t0)),
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

  /* --- lifecycle ----------------------------------------------------- */

  /** Space: arm (mic on, waiting for the current phrase). */
  arm(): void {
    if (this.flow.state === 'finished') this.restart();
    this.flow.to('armed');
    this.speech.start(this.locale);
    this.bumpHoldTimer();
  }

  /** Space again: back to idle, mic off. Never loses position. */
  stopMic(toIdle = true): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.cancelHeal();
    this.speech.stop();
    if (toIdle && this.flow.state !== 'finished') this.flow.to('idle');
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
    if (this.flow.state === 'finished') this.flow.to('idle');
    this.healed = false;
    this.renderAt(this.matcher.current);
  }

  prev(): void {
    this.clearSteps();
    this.matcher.goTo(this.matcher.current - 1);
    if (this.flow.state === 'finished') this.flow.to('idle');
    this.healed = false;
    this.renderAt(this.matcher.current);
  }

  restart(): void {
    this.clearSteps();
    this.matcher.goTo(0);
    if (this.flow.state === 'finished') this.flow.to('idle');
    this.healed = false;
    this.renderAt(this.matcher.current);
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
