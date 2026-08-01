import { registerPlugin, Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { SpeechSource, SpeechStatus } from './SpeechSource';
import { stablePrefixLength } from './WebSpeechSource';
import { diag } from '../diag';

/**
 * On-device speech via the custom Capacitor plugin (Swift):
 * SpeechAnalyzer/SpeechTranscriber on iPadOS 26 hardware that supports
 * it, else SFSpeechRecognizer with requiresOnDeviceRecognition. Emits
 * the same append-only word stream as WebSpeechSource, plus word-level
 * audio timestamps for the speech-to-swap metric.
 */

interface WordsEvent {
  words: string[];        // FULL transcript of ONE recognition task
  audioEndMs: number[];   // per-word audio end, ms since request start
  isFinal: boolean;
  sessionStartEpochMs: number;
  engine: string;         // 'analyzer' | 'recognizer'
  /** recognition-task generation — rotation overlap runs two tasks
      whose transcripts must be diffed SEPARATELY (absent on older
      builds / the analyzer: treated as one stream). */
  gen?: number;
}

interface StatusEvent {
  status: string;
  detail?: string;
}

interface NativeSpeechPlugin {
  start(options: { locale: string; vocabulary: string[]; allowServer?: boolean }): Promise<void>;
  prewarm(options: { locale: string }): Promise<{ detail?: string } | void>;
  stop(): Promise<void>;
  addListener(event: 'words', cb: (e: WordsEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: 'status', cb: (e: StatusEvent) => void): Promise<PluginListenerHandle>;
}

const NativeSpeech = registerPlugin<NativeSpeechPlugin>('NativeSpeech');

export function nativeSpeechAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

export class NativeSpeechSource implements SpeechSource {
  onWords?: SpeechSource['onWords'];
  onStatus?: (status: SpeechStatus, detail?: string) => void;

  /** per-generation transcripts: during rotation overlap two tasks
      emit concurrently; diffing them against ONE transcript would
      interleave and re-create the exact regurgitation the rotation
      prevents (adversarial-verify blocker). */
  private emittedByGen = new Map<number, string[]>();
  private handles: PluginListenerHandle[] = [];
  private active = false;

  start(locale: string, vocabulary: string[] = [], opts: { allowServer?: boolean } = {}): void {
    if (!nativeSpeechAvailable()) {
      this.onStatus?.('unavailable', 'native engine requires the iPad app');
      return;
    }
    this.active = true;
    this.emittedByGen.clear();
    // labeled so tapes can distinguish the JS-layer announcement from
    // the plugin's own start (they are two events, not two starts)
    this.onStatus?.('starting', 'js');
    void this.attach();
    NativeSpeech.start({ locale, vocabulary, allowServer: opts.allowServer === true }).catch((err) => {
      diag.event(`native speech start failed: ${String(err)}`);
      this.onStatus?.('error', String(err));
    });
  }

  private async attach(): Promise<void> {
    if (this.handles.length > 0) return;
    this.handles.push(
      await NativeSpeech.addListener('words', (e) => {
        if (!this.active) return;
        // Recognizer segments can carry several words in one substring
        // ("test read") — split on whitespace, replicating the
        // segment's audio end per piece, so the matcher only ever sees
        // real words and the full-transcript diff stays aligned. The
        // plugin splits too; this guards older builds and the analyzer.
        const words: string[] = [];
        const ends: number[] = [];
        e.words.forEach((w, i) => {
          for (const piece of w.split(/\s+/)) {
            if (!piece) continue;
            words.push(piece);
            ends.push(e.audioEndMs[i] ?? 0);
          }
        });
        const gen = e.gen ?? 0;
        const emitted = this.emittedByGen.get(gen) ?? [];
        const prefix = stablePrefixLength(emitted, words);
        const fresh = words.slice(prefix);
        // A revision re-emits the transcript's unchanged tail as
        // "fresh" with its ORIGINAL audio times — lag computed from
        // those is re-statement age, not engine latency. Only pure
        // appends measure.
        const pureAppend = prefix === emitted.length;
        this.emittedByGen.set(gen, words);
        // rotation retires generations quickly — keep the two newest
        if (this.emittedByGen.size > 2) {
          const gens = [...this.emittedByGen.keys()].sort((a, b) => a - b);
          while (gens.length > 2) this.emittedByGen.delete(gens.shift()!);
        }
        if (fresh.length === 0) return;
        // audio anchor mapped onto the performance.now() timeline
        const arrival = performance.now();
        const audioAnchorMs = e.sessionStartEpochMs - performance.timeOrigin;
        const freshEnds = ends.slice(prefix);
        // mouth→emission lag per token — the engine-latency
        // distribution, independent of any swap rule. Null where the
        // segment timing is zeroed (on-device partials often are).
        const emissionLagMs = freshEnds.map((end) =>
          pureAppend && end > 0 ? Math.round(arrival - (audioAnchorMs + end)) : null,
        );
        this.onWords?.(fresh, e.isFinal, {
          audioEndMs: freshEnds,
          audioAnchorMs,
          emissionLagMs,
          pureAppend,
        });
      }),
      await NativeSpeech.addListener('status', (e) => {
        // after stop() the JS layer has already announced 'stopped';
        // the plugin's own trailing 'stopped' (and any late noise)
        // would double up in the tape
        if (!this.active) return;
        if (e.status === 'restarting') this.emittedByGen.clear();
        if (e.status === 'restart-gap' && e.detail) {
          diag.restartGap(Number(e.detail));
          return;
        }
        if (e.status === 'model-progress') {
          // first-use model download — surfaced in the status strip
          this.onStatus?.('starting', `Downloading speech model… ${e.detail}%`);
          return;
        }
        this.onStatus?.(e.status as SpeechStatus, e.detail);
      }),
    );
  }

  stop(): void {
    this.active = false;
    void NativeSpeech.stop().catch(() => {});
    for (const h of this.handles) void h.remove();
    this.handles = [];
    this.onStatus?.('stopped');
  }
}

/** Launch pre-warm (engine surgery item 4): front-load audio-session
    config + recognizer/daemon spin-up so the first arm reaches
    listening fast. Fire-and-forget; a web platform (no plugin)
    rejects and is ignored. */
export function prewarmNativeSpeech(locale: string): void {
  NativeSpeech.prewarm({ locale })
    .then((r) => {
      // boot-time event listeners don't exist yet — the overlay's
      // event feed is the one place the warm depth stays visible
      diag.event(`prewarm: ${(r as { detail?: string } | void)?.detail ?? 'done'}`);
    })
    .catch(() => {
      /* not on the native platform — nothing to warm */
    });
}
