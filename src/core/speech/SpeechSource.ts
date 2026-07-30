/**
 * Abstraction over speech recognition engines. Phase A ships the Web
 * Speech implementation; Phase B adds a native on-device Capacitor
 * plugin behind the same interface.
 */

export type SpeechStatus =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'restarting'
  | 'stopped'
  | 'denied'
  | 'unavailable'
  | 'error';

export interface SpeechSource {
  /** Begin recognition for a locale ('en-US' | 'pt-BR'). */
  start(locale: string): void;
  stop(): void;
  /**
   * Newly appended recognized words (the source de-duplicates interim
   * revisions — consumers see an append-only stream).
   */
  onWords?: (words: string[], isFinal: boolean) => void;
  onStatus?: (status: SpeechStatus, detail?: string) => void;
}
