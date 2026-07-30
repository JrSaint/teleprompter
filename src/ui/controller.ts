import type { Phrase } from '../core/segmenter';
import { PhraseMatcher } from '../core/matcher';
import { Flow, type FlowState } from '../core/flow';
import type { SpeechSource, SpeechStatus } from '../core/speech/SpeechSource';
import { diag } from '../core/diag';

/** Silence/ad-lib window before "following" degrades to "holding". */
const HOLD_AFTER_MS = 2500;

export interface ControllerEvents {
  onPhrase: (current: Phrase | null, next: Phrase | null, index: number, total: number) => void;
  onFlow: (state: FlowState) => void;
  onMic: (status: SpeechStatus, detail?: string) => void;
}

/**
 * Wires speech → matcher → display. Owns the state machine. The
 * display advances only because words were recognized; silence and
 * ad-libbing hold the current phrase, exactly per the locked design.
 */
export class PrompterController {
  readonly flow = new Flow();
  private matcher: PhraseMatcher;
  private phrases: Phrase[];
  private speech: SpeechSource;
  private ev: ControllerEvents;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private micStatus: SpeechStatus = 'idle';
  private locale: string;

  constructor(
    phrases: Phrase[],
    speech: SpeechSource,
    locale: string,
    ev: ControllerEvents,
  ) {
    this.phrases = phrases;
    this.matcher = new PhraseMatcher(phrases);
    this.speech = speech;
    this.locale = locale;
    this.ev = ev;
    this.flow.onChange = (s) => this.ev.onFlow(s);

    speech.onStatus = (s, detail) => {
      this.micStatus = s;
      this.ev.onMic(s, detail);
      // Terminal mic failure: the state machine must not sit in "armed"
      // claiming to listen when nothing ever will. (Transient 'error'
      // keeps restarting and is not terminal.)
      if ((s === 'denied' || s === 'unavailable') && this.running) {
        this.stopMic();
      }
    };
    speech.onWords = (words) => this.consume(words);
  }

  /** Feed recognized (or simulated) words through the matcher. */
  consume(words: string[]): void {
    if (this.flow.state === 'idle' || this.flow.state === 'finished') return;
    const t0 = performance.now();
    const res = this.matcher.feed(words);

    if (res.matchedAny) {
      if (this.flow.state === 'armed' || this.flow.state === 'holding') {
        this.flow.to('following');
      }
      this.bumpHoldTimer();
    }

    if (res.events.length > 0) {
      for (const e of res.events) diag.event(`${e.type} → phrase ${e.to + 1}`);
      this.pushPhrase();
      // measure event-receipt → painted-swap latency (double rAF = after paint)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => diag.advanceLatency(performance.now() - t0)),
      );
    }

    if (res.finished) {
      this.flow.to('finished');
      this.stopMic(false);
    }
  }

  private bumpHoldTimer(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      if (this.flow.state === 'following') this.flow.to('holding');
    }, HOLD_AFTER_MS);
  }

  private pushPhrase(): void {
    const i = this.matcher.current;
    const done = this.flow.state === 'finished' || this.matcher.finished;
    this.ev.onPhrase(
      done ? null : this.phrases[i] ?? null,
      done ? null : this.phrases[i + 1] ?? null,
      i,
      this.phrases.length,
    );
  }

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
    this.speech.stop();
    if (toIdle && this.flow.state !== 'finished') this.flow.to('idle');
  }

  get running(): boolean {
    return this.flow.state !== 'idle' && this.flow.state !== 'finished';
  }

  get mic(): SpeechStatus {
    return this.micStatus;
  }

  /* Manual navigation — remote clicker / keyboard. Backward is allowed
     manually; the matcher itself never goes backward on its own. */
  next(): void {
    this.matcher.goTo(this.matcher.current + 1);
    if (this.flow.state === 'finished') this.flow.to('idle');
    this.pushPhrase();
  }

  prev(): void {
    this.matcher.goTo(this.matcher.current - 1);
    if (this.flow.state === 'finished') this.flow.to('idle');
    this.pushPhrase();
  }

  restart(): void {
    this.matcher.goTo(0);
    if (this.flow.state === 'finished') this.flow.to('idle');
    this.pushPhrase();
  }

  /** Initial render. */
  begin(): void {
    this.pushPhrase();
  }

  dispose(): void {
    this.stopMic();
  }
}
