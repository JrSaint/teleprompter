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
  words: string[];        // FULL session transcript so far
  audioEndMs: number[];   // per-word audio end, ms since session start
  isFinal: boolean;
  sessionStartEpochMs: number;
  engine: string;         // 'analyzer' | 'recognizer'
}

interface StatusEvent {
  status: string;
  detail?: string;
}

interface NativeSpeechPlugin {
  start(options: { locale: string; vocabulary: string[] }): Promise<void>;
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

  private emitted: string[] = [];
  private handles: PluginListenerHandle[] = [];
  private active = false;

  start(locale: string, vocabulary: string[] = []): void {
    if (!nativeSpeechAvailable()) {
      this.onStatus?.('unavailable', 'native engine requires the iPad app');
      return;
    }
    this.active = true;
    this.emitted = [];
    // labeled so tapes can distinguish the JS-layer announcement from
    // the plugin's own start (they are two events, not two starts)
    this.onStatus?.('starting', 'js');
    void this.attach();
    NativeSpeech.start({ locale, vocabulary }).catch((err) => {
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
        const prefix = stablePrefixLength(this.emitted, words);
        const fresh = words.slice(prefix);
        // A revision re-emits the transcript's unchanged tail as
        // "fresh" with its ORIGINAL audio times — lag computed from
        // those is re-statement age, not engine latency. Only pure
        // appends measure.
        const pureAppend = prefix === this.emitted.length;
        this.emitted = words;
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
        });
      }),
      await NativeSpeech.addListener('status', (e) => {
        // after stop() the JS layer has already announced 'stopped';
        // the plugin's own trailing 'stopped' (and any late noise)
        // would double up in the tape
        if (!this.active) return;
        if (e.status === 'restarting') this.emitted = [];
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
