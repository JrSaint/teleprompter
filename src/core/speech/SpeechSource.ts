/**
 * Abstraction over speech recognition engines. WebSpeechSource wraps
 * the browser API; NativeSpeechSource talks to the Capacitor plugin
 * (on-device SpeechAnalyzer / SFSpeechRecognizer) and adds word-level
 * audio timestamps the web engine can never provide.
 */

export type SpeechStatus =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'restarting'
  | 'stopped'
  | 'denied'
  | 'unavailable'
  | 'error'
  // side-channel events (native engine): environment report at session
  // start; ~1Hz microphone level while active. Not mic-state changes.
  | 'env'
  | 'level';

/** Extra per-batch data from engines that can provide it (native). */
export interface WordsMeta {
  /** Per-word audio END time, ms relative to the session's audio start.
      Same length/order as the emitted words. */
  audioEndMs?: number[];
  /** The session audio start on the performance.now() timeline, so
      audio times convert to wallclock: spoken = anchor + audioEndMs. */
  audioAnchorMs?: number;
}

export interface SpeechSource {
  /** Begin recognition. `vocabulary` primes engines that support it
      (script content words + alias targets); others ignore it. */
  start(locale: string, vocabulary?: string[]): void;
  stop(): void;
  /**
   * Newly appended recognized words (sources de-duplicate interim
   * revisions — consumers see an append-only stream).
   */
  onWords?: (words: string[], isFinal: boolean, meta?: WordsMeta) => void;
  onStatus?: (status: SpeechStatus, detail?: string) => void;
}
