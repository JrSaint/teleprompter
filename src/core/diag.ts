/**
 * On-device diagnostics. Console logging is unreachable on the iPad in
 * the rig, so everything worth measuring lands here and the prompter's
 * corner overlay renders it live.
 */

export interface DiagSnapshot {
  restartCount: number;
  restartGaps: number[];      // ms, most recent last
  advanceLatencies: number[]; // ms from result-event receipt to painted swap
  /** ms from the triggering word's AUDIO time to the painted swap —
      only the native engine can provide this (word timestamps). */
  speechToSwap: number[];
  /** native engine environment report (device/engine/locales) */
  env: string;
  /** last reported mic input level, 0–100 (native engine, ~1Hz) */
  level: number;
  log: string[];              // recent human-readable events
}

type Listener = (s: DiagSnapshot) => void;

const MAX_KEPT = 20;

class Diagnostics {
  private state: DiagSnapshot = {
    restartCount: 0,
    restartGaps: [],
    advanceLatencies: [],
    speechToSwap: [],
    env: '',
    level: -1,
    log: [],
  };
  private listeners = new Set<Listener>();

  private push(): void {
    for (const fn of this.listeners) fn(this.snapshot());
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): DiagSnapshot {
    return {
      restartCount: this.state.restartCount,
      restartGaps: [...this.state.restartGaps],
      advanceLatencies: [...this.state.advanceLatencies],
      speechToSwap: [...this.state.speechToSwap],
      env: this.state.env,
      level: this.state.level,
      log: [...this.state.log],
    };
  }

  setEnv(env: string): void {
    this.state.env = env;
    this.event(`env: ${env.slice(0, 160)}`);
  }

  setLevel(level: number): void {
    this.state.level = Number.isFinite(level) ? level : -1;
    this.push();
  }

  event(message: string): void {
    const t = (performance.now() / 1000).toFixed(1);
    this.state.log.push(`[${t}s] ${message}`);
    if (this.state.log.length > MAX_KEPT) this.state.log.shift();
    // Also mirror to console for Mac-side development.
    console.log(`[diag ${t}s] ${message}`);
    this.push();
  }

  restartGap(ms: number): void {
    this.state.restartCount++;
    this.state.restartGaps.push(Math.round(ms));
    if (this.state.restartGaps.length > MAX_KEPT) this.state.restartGaps.shift();
    this.event(`speech session restart #${this.state.restartCount}, gap ${Math.round(ms)}ms`);
  }

  advanceLatency(ms: number): void {
    this.state.advanceLatencies.push(Math.round(ms));
    if (this.state.advanceLatencies.length > MAX_KEPT) this.state.advanceLatencies.shift();
    this.push();
  }

  speechToSwap(ms: number): void {
    this.state.speechToSwap.push(Math.round(ms));
    if (this.state.speechToSwap.length > MAX_KEPT) this.state.speechToSwap.shift();
    this.push();
  }

  reset(): void {
    this.state = {
      restartCount: 0, restartGaps: [], advanceLatencies: [],
      speechToSwap: [], env: '', level: -1, log: [],
    };
    this.push();
  }
}

export const diag = new Diagnostics();

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
