/**
 * Voice-onset ↔ token-arrival correlation — the emission-lag fallback
 * when the engine zeroes segment timestamps (B.3.3 finding 2, hard
 * gate). Rules:
 *  - EVERY onset opens (or replaces) the pending sample;
 *  - the first FRESH token arrival closes it — except tokens inside a
 *    re-emission batch (≥BATCH_MIN_TOKENS sharing one arrival), which
 *    never close samples;
 *  - entering holding voids the pending onset (that silence was an
 *    ad-lib, not engine latency);
 *  - a pair further apart than STALE_SAMPLE_MS is counted invalid and
 *    excluded — the metric must never silently absorb a pause.
 */

export const STALE_SAMPLE_MS = 3000;
export const BATCH_MIN_TOKENS = 4;

/** Phrase-boundary sampling window: a phrase's first fresh token may
    pair with an UNCONSUMED onset this recent (B.3.4 finding 2 —
    fluent reading produces few quiet→voice onsets; boundary pairing
    recovers samples without fabricating any). */
export const BOUNDARY_WINDOW_MS = 1500;

export class LagSampler {
  private pending: number | null = null;
  /** most recent onset and whether any sample consumed it */
  private lastOnset: number | null = null;
  private lastOnsetConsumed = false;
  readonly samples: number[] = [];
  readonly boundarySamples: number[] = [];
  invalid = 0;
  voidedByHold = 0;

  /** A quiet→voice onset at `wall` opens/replaces the pending sample. */
  onset(wall: number): void {
    this.pending = wall;
    this.lastOnset = wall;
    this.lastOnsetConsumed = false;
  }

  /** The session entered holding — the pending onset is an ad-lib. */
  hold(): void {
    if (this.pending !== null) {
      this.pending = null;
      this.voidedByHold++;
    }
  }

  /** A restart invalidates the pending onset without blame. */
  restart(): void {
    this.pending = null;
  }

  /** Fresh tokens arrived at `wall`. Returns the closed sample's lag
      in ms, or null (no pending, a batch, or an excluded stale pair). */
  tokens(wall: number, batch: boolean): number | null {
    if (this.pending === null || batch) return null;
    const lag = Math.round(wall - this.pending);
    this.pending = null;
    if (lag > 0 && lag <= STALE_SAMPLE_MS) {
      this.samples.push(lag);
      this.lastOnsetConsumed = true;
      return lag;
    }
    this.invalid++;
    return null;
  }

  /** A new phrase's first fresh token arrived at `wall`: when recent
      VAD activity is available (an unconsumed onset inside the
      boundary window), pair it — otherwise no sample, never a
      fabricated one. */
  phraseFirstToken(wall: number): number | null {
    if (
      this.lastOnset === null ||
      this.lastOnsetConsumed ||
      wall - this.lastOnset > BOUNDARY_WINDOW_MS
    ) return null;
    const lag = Math.round(wall - this.lastOnset);
    this.lastOnsetConsumed = true;
    this.pending = null; // fully consumed — no second sample later
    if (lag > 0) {
      this.boundarySamples.push(lag);
      return lag;
    }
    return null;
  }

  reset(): void {
    this.pending = null;
    this.lastOnset = null;
    this.lastOnsetConsumed = false;
    this.samples.length = 0;
    this.boundarySamples.length = 0;
    this.invalid = 0;
    this.voidedByHold = 0;
  }
}
