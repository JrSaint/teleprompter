import type { SpeechSource, SpeechStatus } from './SpeechSource';
import { diag } from '../diag';
import { normalizeWord } from '../text';

/**
 * Words newly appended to a session transcript. The comparison is
 * normalized so an interim revision that merely changes casing or
 * punctuation ("big" → "Big,") doesn't re-emit the whole tail.
 * Exported for unit tests.
 */
export function appendedWords(prev: string[], full: string[]): string[] {
  let i = 0;
  while (
    i < full.length &&
    i < prev.length &&
    normalizeWord(full[i]) === normalizeWord(prev[i])
  ) i++;
  return full.slice(i);
}

/* Minimal ambient typings for webkitSpeechRecognition (not in lib.dom). */
interface SRResultAlt { transcript: string }
interface SRResult { 0: SRResultAlt; isFinal: boolean; length: number }
interface SRResultList { length: number; [i: number]: SRResult }
interface SREvent { results: SRResultList; resultIndex: number }
interface SRErrorEvent { error: string; message?: string }
interface SR {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onresult: ((e: SREvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
declare global {
  interface Window {
    SpeechRecognition?: new () => SR;
    webkitSpeechRecognition?: new () => SR;
  }
}

/**
 * Web Speech API source. Safari kills continuous sessions unpredictably,
 * so this source auto-restarts on any unexpected end and reports every
 * restart gap to diagnostics — the numbers we use to judge whether the
 * web engine is usable or Phase B native speech is required.
 */
export class WebSpeechSource implements SpeechSource {
  onWords?: (words: string[], isFinal: boolean) => void;
  onStatus?: (status: SpeechStatus, detail?: string) => void;

  private rec: SR | null = null;
  private locale = 'en-US';
  private active = false;          // caller wants us running
  private emitted: string[] = [];  // words already emitted this session
  private endedAt = 0;             // performance.now() at unexpected end
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  start(locale: string): void {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) {
      this.onStatus?.('unavailable', 'SpeechRecognition API not present');
      return;
    }
    this.locale = locale;
    this.active = true;
    this.onStatus?.('starting');
    this.spawn(Ctor);
  }

  /** Fresh instance per session — reusing one is flaky in Safari. */
  private spawn(Ctor: new () => SR): void {
    this.detach(); // a stale recognizer must never ghost-restart alongside
    const rec = new Ctor();
    this.rec = rec;
    this.emitted = [];
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = this.locale;

    // Every handler checks instance identity: events from a superseded
    // recognizer must not touch current state.
    rec.onstart = () => {
      if (this.rec !== rec) return;
      if (this.endedAt > 0) {
        diag.restartGap(performance.now() - this.endedAt);
        this.endedAt = 0;
      }
      this.onStatus?.('listening');
    };

    rec.onresult = (e) => {
      if (this.rec !== rec) return;
      // Rebuild the session transcript, then emit only what's new
      // relative to what we've already emitted.
      const full: string[] = [];
      let lastIsFinal = false;
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        full.push(...r[0].transcript.trim().split(/\s+/).filter(Boolean));
        lastIsFinal = r.isFinal;
      }
      const fresh = appendedWords(this.emitted, full);
      this.emitted = full;
      if (fresh.length > 0) this.onWords?.(fresh, lastIsFinal);
    };

    rec.onerror = (e) => {
      if (this.rec !== rec) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.active = false;
        this.onStatus?.('denied', e.error);
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.onStatus?.('error', e.error);
        diag.event(`speech error: ${e.error}`);
      }
      // 'no-speech' and 'aborted' fall through to onend → restart
    };

    rec.onend = () => {
      if (this.rec !== rec) return;
      this.rec = null;
      if (!this.active) {
        this.onStatus?.('stopped');
        return;
      }
      // Unexpected end while we should be listening → measure and
      // restart. A session can die before ever starting (e.g. network
      // error), so keep the EARLIEST pending timestamp — the gap must
      // cover the whole dead-air stretch, not just the last attempt.
      if (this.endedAt === 0) this.endedAt = performance.now();
      this.onStatus?.('restarting');
      this.restartTimer = setTimeout(() => {
        if (this.active && this.rec === null) this.spawn(Ctor);
      }, 50);
    };

    try {
      rec.start();
    } catch (err) {
      diag.event(`speech start failed: ${String(err)}`);
      this.onStatus?.('error', String(err));
    }
  }

  /** Silence and drop the current recognizer without touching state. */
  private detach(): void {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    rec.onstart = null;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      rec.abort();
    } catch {
      /* already dead */
    }
  }

  stop(): void {
    this.active = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.endedAt = 0;
    this.detach();
    this.onStatus?.('stopped');
  }
}
