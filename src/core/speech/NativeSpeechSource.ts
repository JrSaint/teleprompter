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
    this.onStatus?.('starting');
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
        const prefix = stablePrefixLength(this.emitted, e.words);
        const fresh = e.words.slice(prefix);
        this.emitted = e.words;
        if (fresh.length === 0) return;
        // audio anchor mapped onto the performance.now() timeline
        const audioAnchorMs = e.sessionStartEpochMs - performance.timeOrigin;
        this.onWords?.(fresh, e.isFinal, {
          audioEndMs: e.audioEndMs.slice(prefix),
          audioAnchorMs,
        });
      }),
      await NativeSpeech.addListener('status', (e) => {
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
