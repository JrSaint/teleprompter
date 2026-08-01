/**
 * Abstraction over speech recognition engines. WebSpeechSource wraps
 * the browser API; NativeSpeechSource talks to the Capacitor plugin
 * (on-device SpeechAnalyzer / SFSpeechRecognizer) and adds word-level
 * audio timestamps the web engine can never provide.
 */

export type SpeechStatus =
  | 'idle'
  | 'starting'
  /** readiness gate: engine spin-up begun, no real buffer yet */
  | 'warming'
  | 'listening'
  | 'restarting'
  | 'stopped'
  | 'denied'
  | 'unavailable'
  | 'error'
  // side-channel events (native engine): environment report at session
  // start; ~1Hz microphone level while active; voice-activity onset
  // (buffer-resolution, epoch ms in detail) after a quiet stretch —
  // the emission-lag fallback when segment timings are zeroed.
  // Not mic-state changes.
  /** proactive task rotation / watchdog fresh-task (side-channel) */
  | 'rotating'
  /** launch pre-warm completed (side-channel) */
  | 'prewarmed'
  | 'env'
  | 'level'
  | 'voice-onset';

/** Extra per-batch data from engines that can provide it (native). */
export interface WordsMeta {
  /** Per-word audio END time, ms relative to the session's audio start.
      Same length/order as the emitted words. */
  audioEndMs?: number[];
  /** The session audio start on the performance.now() timeline, so
      audio times convert to wallclock: spoken = anchor + audioEndMs. */
  audioAnchorMs?: number;
  /** Per-word mouth→emission lag, ms (arrival wall minus spoken-end
      wall). Null where the engine gave no usable timestamp — on-device
      partials often report zeroed segment timings. */
  emissionLagMs?: Array<number | null>;
  /** True when this event strictly appended to the transcript; false
      when a revision re-stated earlier words. Re-statements never
      close metric samples — a legitimate long append may. */
  pureAppend?: boolean;
}

export interface SpeechSource {
  /** Begin recognition. `vocabulary` primes engines that support it
      (script content words + alias targets); others ignore it. */
  start(locale: string, vocabulary?: string[], opts?: { allowServer?: boolean }): void;
  stop(): void;
  /**
   * Newly appended recognized words (sources de-duplicate interim
   * revisions — consumers see an append-only stream).
   */
  onWords?: (words: string[], isFinal: boolean, meta?: WordsMeta) => void;
  onStatus?: (status: SpeechStatus, detail?: string) => void;
}
