import type { Phrase } from './segmenter';
import { normalizeWord, fuzzyMatch } from './text';

/**
 * Pure phrase-alignment engine. Feed it recognized words; it decides
 * when the current phrase advances, when to jump forward over a skipped
 * phrase, and otherwise holds. It never moves backward on its own.
 */

export interface MatcherConfig {
  lookahead: number;        // phrases scanned ahead for skip detection
  advancePct: number;       // content-word ratio that completes a phrase
  skipCurrentBelowPct: number; // current must be below this to jump
}

const DEFAULTS: MatcherConfig = {
  lookahead: 3,
  advancePct: 0.7,
  skipCurrentBelowPct: 0.3,
};

export interface MatchEvent {
  type: 'advance' | 'jump';
  to: number; // new current phrase index
}

export interface FeedResult {
  events: MatchEvent[];
  matchedAny: boolean; // at least one fed word matched a window phrase
  finished: boolean;   // advanced past the final phrase
}

export class PhraseMatcher {
  private phrases: Phrase[];
  private cfg: MatcherConfig;
  private matched = new Map<number, Set<number>>(); // phrase → matched token idx
  private exact = new Map<number, Set<number>>();   // subset matched exactly
  private touchedCurrent = false; // a word matched the phrase WHILE current
  current = 0;
  finished = false;

  constructor(phrases: Phrase[], cfg: Partial<MatcherConfig> = {}) {
    this.phrases = phrases;
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  /** Content-match ratio for a phrase (0..1). */
  progress(p: number): number {
    const ph = this.phrases[p];
    if (!ph || ph.contentIdx.length === 0) return 0;
    const set = this.matched.get(p);
    if (!set) return 0;
    let hit = 0;
    for (const idx of ph.contentIdx) if (set.has(idx)) hit++;
    return hit / ph.contentIdx.length;
  }

  /** 'none' | 'fuzzy' | 'exact' for the phrase's final content token. */
  private finalContentMatched(p: number): 'none' | 'fuzzy' | 'exact' {
    const ph = this.phrases[p];
    const set = this.matched.get(p);
    if (!ph || !set || ph.contentIdx.length === 0) return 'none';
    const finalIdx = ph.contentIdx[ph.contentIdx.length - 1];
    if (!set.has(finalIdx)) return 'none';
    return this.exact.get(p)?.has(finalIdx) ? 'exact' : 'fuzzy';
  }

  /** Try to mark one token of phrase p as matched by word w.
      Exact matches take priority over fuzzy ones so a precisely spoken
      final word is never consumed by an earlier similar token. */
  private tryMatch(p: number, w: string): boolean {
    const ph = this.phrases[p];
    if (!ph) return false;
    let set = this.matched.get(p);
    if (!set) {
      set = new Set();
      this.matched.set(p, set);
    }
    for (let t = 0; t < ph.tokens.length; t++) {
      if (set.has(t)) continue;
      if (w === ph.tokens[t]) {
        set.add(t);
        let ex = this.exact.get(p);
        if (!ex) {
          ex = new Set();
          this.exact.set(p, ex);
        }
        ex.add(t);
        return true;
      }
    }
    for (let t = 0; t < ph.tokens.length; t++) {
      if (set.has(t)) continue;
      if (fuzzyMatch(w, ph.tokens[t])) {
        set.add(t);
        return true;
      }
    }
    return false;
  }

  private dropBefore(idx: number): void {
    for (const key of [...this.matched.keys()]) {
      if (key < idx) {
        this.matched.delete(key);
        this.exact.delete(key);
      }
    }
  }

  /**
   * Consume recognized words (already incremental — the speech source
   * emits only newly appended words). Returns what happened.
   */
  feed(words: string[]): FeedResult {
    const events: MatchEvent[] = [];
    let matchedAny = false;
    for (const raw of words) {
      const w = normalizeWord(raw);
      if (!w || this.finished) continue;

      // match against the current phrase and the lookahead window
      const windowEnd = Math.min(
        this.current + this.cfg.lookahead,
        this.phrases.length - 1,
      );
      for (let p = this.current; p <= windowEnd; p++) {
        if (this.tryMatch(p, w)) {
          matchedAny = true;
          if (p === this.current) this.touchedCurrent = true;
        }
      }

      // Advancement requires evidence gathered while the phrase was
      // actually current (touchedCurrent) — carried lookahead credits
      // alone never advance, so shared words between adjacent phrases
      // can't chain the display ahead of the speaker. At most one
      // advance and one jump per recognized word.
      if (!this.finished && this.touchedCurrent) {
        const final = this.finalContentMatched(this.current);
        const pct = this.progress(this.current);
        // A lone fuzzy hit on the final word is not enough — it must be
        // exact, or come with half the phrase's content already matched.
        const finalOk =
          final === 'exact' || (final === 'fuzzy' && pct >= 0.5);
        if (finalOk || pct >= this.cfg.advancePct) {
          this.current++;
          this.touchedCurrent = false;
          this.dropBefore(this.current);
          if (this.current >= this.phrases.length) {
            this.finished = true;
            this.current = this.phrases.length - 1;
          }
          events.push({ type: 'advance', to: this.current });
        }
      }

      // skip: a later phrase is clearly being spoken while the current
      // one was barely touched — jump forward, never back
      if (!this.finished) {
        const wEnd = Math.min(
          this.current + this.cfg.lookahead,
          this.phrases.length - 1,
        );
        if (this.progress(this.current) < this.cfg.skipCurrentBelowPct) {
          for (let j = this.current + 1; j <= wEnd; j++) {
            if (this.progress(j) >= this.cfg.advancePct) {
              this.current = j;
              // The jump's evidence IS the speaker saying phrase j, so
              // it counts as touched — otherwise a fully-spoken jump
              // target could never advance again.
              this.touchedCurrent = true;
              this.dropBefore(j);
              events.push({ type: 'jump', to: j });
              break;
            }
          }
        }
      }
    }
    return { events, matchedAny, finished: this.finished };
  }

  /** Manual navigation (remote/keys). Clears match state. */
  goTo(index: number): void {
    this.current = Math.max(0, Math.min(index, this.phrases.length - 1));
    this.finished = false;
    this.matched.clear();
    this.exact.clear();
    this.touchedCurrent = false;
  }

  get length(): number {
    return this.phrases.length;
  }
}
