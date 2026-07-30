import type { SpeechSource, SpeechStatus } from './SpeechSource';
import { diag } from '../diag';

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
    const rec = new Ctor();
    this.rec = rec;
    this.emitted = [];
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = this.locale;

    rec.onstart = () => {
      if (this.endedAt > 0) {
        diag.restartGap(performance.now() - this.endedAt);
        this.endedAt = 0;
      }
      this.onStatus?.('listening');
    };

    rec.onresult = (e) => {
      // Rebuild the session transcript, then emit only what's new
      // relative to what we've already emitted (interim results revise
      // earlier words; the common-prefix diff re-emits revised tails).
      const full: string[] = [];
      let lastIsFinal = false;
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        full.push(...r[0].transcript.trim().split(/\s+/).filter(Boolean));
        lastIsFinal = r.isFinal;
      }
      let prefix = 0;
      while (
        prefix < full.length &&
        prefix < this.emitted.length &&
        full[prefix] === this.emitted[prefix]
      ) prefix++;
      const fresh = full.slice(prefix);
      this.emitted = full;
      if (fresh.length > 0) this.onWords?.(fresh, lastIsFinal);
    };

    rec.onerror = (e) => {
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
      this.rec = null;
      if (!this.active) {
        this.onStatus?.('stopped');
        return;
      }
      // Unexpected end while we should be listening → measure and restart
      this.endedAt = performance.now();
      this.onStatus?.('restarting');
      this.restartTimer = setTimeout(() => {
        if (this.active) this.spawn(Ctor);
      }, 50);
    };

    try {
      rec.start();
    } catch (err) {
      diag.event(`speech start failed: ${String(err)}`);
      this.onStatus?.('error', String(err));
    }
  }

  stop(): void {
    this.active = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.endedAt = 0;
    try {
      this.rec?.stop();
    } catch {
      /* already stopped */
    }
    this.rec = null;
    this.onStatus?.('stopped');
  }
}
