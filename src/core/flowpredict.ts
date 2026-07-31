/**
 * Flow mode: predictive swap timing. A rolling median of the reader's
 * ms-per-content-word (from CONFIRMED tokens only) projects when the
 * current phrase's remaining content words will have been spoken; the
 * display may swap then even if the engine hasn't emitted them yet.
 *
 * Hard rails (locked): never more than one phrase beyond the last
 * evidenced phrase (no predictive chains); suppressed while holding or
 * armed; any unmatched token suspends prediction until evidence
 * resumes; an overdue phrase (elapsed > OVERDUE_FACTOR × expected) is
 * a pause, not missed speech — defer to hold; never backward; never
 * predict the finish.
 *
 * The same model runs live (controller timer) and in replay (simulated
 * between recorded token timestamps), so Flow behavior is regression-
 * testable against real tapes.
 */

/** Rolling window of confirmed-content inter-word gaps. */
export const FLOW_WINDOW = 10;
/** Samples needed before the model predicts at all. */
export const FLOW_MIN_SAMPLES = 3;
/** Gaps below this are same-batch artifacts (words sharing one
    recognizer emission), not speech rate — skipped. */
export const FLOW_MIN_GAP_MS = 60;
/** Gaps above this are pauses/holds, not speech rate — skipped. */
export const FLOW_MAX_GAP_MS = 2000;
/** The current phrase must be at least this content-confirmed. */
export const FLOW_MIN_CONFIRMED_PCT = 0.5;
/** Elapsed beyond expected × this is a pause — never predict. */
export const FLOW_OVERDUE_FACTOR = 1.8;
/** Mirror of the controller's silence window: past this without a
    matched token the session is holding, and Flow must not fire. */
export const FLOW_HOLD_MS = 2500;

export class FlowModel {
  private gaps: number[] = [];
  /** Time of the last CONFIRMED (matched) content token. */
  lastContentT: number | null = null;
  /** Set by an unmatched token; cleared when evidence resumes. */
  suspended = false;

  /** Feed the time of a confirmed content-token match. */
  noteContent(t: number): void {
    if (this.lastContentT !== null) {
      const gap = t - this.lastContentT;
      if (gap >= FLOW_MIN_GAP_MS && gap <= FLOW_MAX_GAP_MS) {
        this.gaps.push(gap);
        if (this.gaps.length > FLOW_WINDOW) this.gaps.shift();
      }
    }
    this.lastContentT = t;
    this.suspended = false;
  }

  /** A token matched nothing — the engine and script disagree right
      now; predictions pause until evidence resumes. */
  noteUnmatched(): void {
    this.suspended = true;
  }

  /** A token matched (content or not) — evidence resumed. */
  noteMatched(): void {
    this.suspended = false;
  }

  /** Rolling median ms-per-content-word, or null while cold. */
  medianRate(): number | null {
    if (this.gaps.length < FLOW_MIN_SAMPLES) return null;
    const s = [...this.gaps].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  }

  /**
   * When may a predictive swap fire, given the current phrase state?
   * Returns the wallclock window [fireAt, deadline], or null when any
   * rail blocks. `remaining` is unmatched content words of the current
   * phrase; `confirmedPct` its content-match ratio (0..1).
   */
  window(remaining: number, confirmedPct: number): { fireAt: number; deadline: number; rateMs: number } | null {
    if (this.suspended || this.lastContentT === null) return null;
    if (remaining < 1 || confirmedPct < FLOW_MIN_CONFIRMED_PCT) return null;
    const rateMs = this.medianRate();
    if (rateMs === null) return null;
    const expected = remaining * rateMs;
    return {
      fireAt: this.lastContentT + expected,
      deadline: this.lastContentT + expected * FLOW_OVERDUE_FACTOR,
      rateMs,
    };
  }

  reset(): void {
    this.gaps = [];
    this.lastContentT = null;
    this.suspended = false;
  }
}
