import type { MatchRule } from './matcher';
import type { Lang } from './text';

/**
 * Flight recorder: everything needed to replay a prompting session
 * offline — every recognized token (with interim/final flag), every
 * matcher decision (with the rule that fired and the match state), mic
 * status transitions, and flow-state changes. Exported via the "Copy
 * log" button; real rig logs become replay-harness regression fixtures.
 */

export type SessionEvent =
  | {
      t: number; kind: 'token'; word: string; final: boolean;
      /** mouth→emission lag for this token, ms — absent when the
          engine gave no usable word timestamp (on-device partials
          often report zeroed segment timings) */
      emissionLagMs?: number;
    }
  | {
      t: number; kind: 'decision';
      action: 'advance' | 'jump' | 'hold' | 'heal';
      rule: MatchRule | 'none';
      from: number; to: number;
      /** match % of the FROM phrase before this feed was applied */
      curPct: number; ahead: number[];
      /** content-word hits backing the move (0 for holds) */
      evidence: number;
      /** triggering word's audio time → painted swap, ms — patched in
          after the paint frame; absent when the engine gave no usable
          word timestamp (e.g. recognizer partials report 0 until
          finalization) */
      speechToSwapMs?: number;
      /** flow-predict only: the pace model behind the swap */
      flow?: { rateMs: number; elapsedMs: number; remaining: number };
    }
  | { t: number; kind: 'mic'; status: string; detail?: string }
  | { t: number; kind: 'state'; state: string }
  | {
      t: number; kind: 'summary';
      /** per listening stretch */
      speechToSwap: { count: number; medianMs: number; p90Ms: number };
      /** engine-latency distribution: 'segments' = per-word audio
          timestamps; 'vad-onset' = rough voice-onset→token-arrival
          fallback when segment timings are zeroed */
      emissionLag?: {
        count: number; medianMs: number; p90Ms: number;
        source: 'segments' | 'vad-onset';
      };
    };

/** SessionEvent without its timestamp, distributed over the union. */
type Body<E> = E extends { t: number } ? Omit<E, 't'> : never;
type SessionEventBody = Body<SessionEvent>;

export interface SessionLog {
  version: 1;
  id: string;
  startedAtIso: string;
  script: { title: string; lang: Lang; body: string; aliases?: string };
  /** Swap timing the session ran with — replay honors it (flow =
      lead rules + predictive swaps). Absent in logs recorded before
      B.2; replay then tries both modes. */
  swapTiming?: 'lead' | 'confirm' | 'flow';
  /** The segmented phrase list (index → text) as the session saw it —
      decisions are index-only and unanalyzable without this. */
  phrases?: string[];
  events: SessionEvent[];
}

export class FlightRecorder {
  private log: SessionLog | null = null;
  private t0 = 0;

  start(
    script: { title: string; lang: Lang; body: string; aliases?: string },
    opts: { swapTiming?: 'lead' | 'confirm' | 'flow'; phrases?: string[] } = {},
  ): void {
    this.t0 = performance.now();
    this.log = {
      version: 1,
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      startedAtIso: new Date().toISOString(),
      script,
      ...(opts.swapTiming ? { swapTiming: opts.swapTiming } : {}),
      ...(opts.phrases ? { phrases: opts.phrases } : {}),
      events: [],
    };
  }

  private push(e: SessionEventBody): SessionEvent | null {
    if (!this.log) return null;
    const full = {
      ...e,
      t: Math.round(performance.now() - this.t0),
    } as SessionEvent;
    this.log.events.push(full);
    return full;
  }

  token(word: string, final: boolean, emissionLagMs?: number): void {
    this.push({
      kind: 'token', word, final,
      ...(emissionLagMs !== undefined ? { emissionLagMs } : {}),
    });
  }

  /** Returns the pushed event so the caller can patch speechToSwapMs
      onto it once the swap has actually painted. */
  decision(d: {
    action: 'advance' | 'jump' | 'hold' | 'heal';
    rule: MatchRule | 'none';
    from: number; to: number;
    curPct: number; ahead: number[];
    evidence: number;
    flow?: { rateMs: number; elapsedMs: number; remaining: number };
  }): SessionEvent | null {
    return this.push({ kind: 'decision', ...d });
  }

  /** Metric summary for one listening stretch. */
  summary(
    speechToSwap: { count: number; medianMs: number; p90Ms: number },
    emissionLag?: {
      count: number; medianMs: number; p90Ms: number;
      source: 'segments' | 'vad-onset';
    },
  ): void {
    this.push({
      kind: 'summary', speechToSwap,
      ...(emissionLag ? { emissionLag } : {}),
    });
  }

  mic(status: string, detail?: string): void {
    this.push({ kind: 'mic', status, ...(detail ? { detail } : {}) });
  }

  state(state: string): void {
    this.push({ kind: 'state', state });
  }

  current(): SessionLog | null {
    return this.log;
  }

  end(): SessionLog | null {
    const done = this.log;
    this.log = null;
    return done;
  }
}
