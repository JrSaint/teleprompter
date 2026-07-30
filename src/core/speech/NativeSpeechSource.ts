import type { SpeechSource, SpeechStatus } from './SpeechSource';

/**
 * Placeholder for the Phase B Capacitor plugin (SpeechAnalyzer /
 * SFSpeechRecognizer with requiresOnDeviceRecognition). Same interface
 * as WebSpeechSource so the controller never has to care which engine
 * is underneath.
 */
export class NativeSpeechSource implements SpeechSource {
  onWords?: (words: string[], isFinal: boolean) => void;
  onStatus?: (status: SpeechStatus, detail?: string) => void;

  start(_locale: string): void {
    this.onStatus?.('unavailable', 'native speech ships in Phase B (Capacitor)');
  }

  stop(): void {
    this.onStatus?.('stopped');
  }
}
