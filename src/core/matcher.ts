import type { Phrase } from './segmenter';
import { normalizeWord, fuzzyMatch, wordsEqual } from './text';

/**
 * Pure phrase-alignment engine. Feed it recognized words; it decides
 * when the current phrase advances, when to jump forward over a skipped
 * phrase, and otherwise holds. It never moves backward on its own.
 */

export interface MatcherConfig {
  lookahead: number;        // phrases scanned ahead for skip detection
  advancePct: number;       // content-word ratio that completes a phrase
  rescuePct: number;        // partial ratio that advances with next-phrase evidence
  skipCurrentBelowPct: number; // current must be below this to far-jump
  finalWordMinPct: number;  // a FUZZY final-word hit needs this much support
}

const DEFAULTS: MatcherConfig = {
  lookahead: 3,
  advancePct: 0.7,
  rescuePct: 0.4,
  skipCurrentBelowPct: 0.4,
  finalWordMinPct: 0.5,
};

/** Which rule moved the display — recorded per decision for tuning. */
export type MatchRule =
  | 'final-exact'      // exact hit on the final content word
  | 'final-fuzzy'      // fuzzy final-word hit with ≥finalWordMinPct support
  | 'content-70'       // ≥advancePct of content words matched
  | 'boundary-rescue'  // ≥rescuePct matched AND next phrase already started
  | 'restart-grace'    // post-restart grace: next-phrase evidence alone
  | 'far-skip'         // later phrase ≥advancePct while current <skip gate
  | 'self-heal';       // forced by the controller's stall self-heal

export interface MatchEvent {
  type: 'advance' | 'jump';
  to: number; // new current phrase index
  rule: MatchRule;
}

export interface FeedOptions {
  /** Post-restart grace window: words may have been eaten by the dead
      session, so next-phrase evidence alone can advance. */
  grace?: boolean;
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
  private fresh = new Map<number, number>();        // unambiguous content hits
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
    return this.contentMatchedCount(p) / ph.contentIdx.length;
  }

  /** How many content words of phrase p have been matched. */
  contentMatchedCount(p: number): number {
    const ph = this.phrases[p];
    const set = this.matched.get(p);
    if (!ph || !set) return 0;
    let hit = 0;
    for (const idx of ph.contentIdx) if (set.has(idx)) hit++;
    return hit;
  }

  /** Snapshot for the flight recorder: current + lookahead match %. */
  progressSnapshot(): { current: number; pct: number; ahead: number[] } {
    const ahead: number[] = [];
    for (let j = 1; j <= this.cfg.lookahead; j++) {
      ahead.push(Math.round(this.progress(this.current + j) * 100));
    }
    return {
      current: this.current,
      pct: Math.round(this.progress(this.current) * 100),
      ahead,
    };
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

  /** Try to mark one token of phrase p as matched by word w. Returns
      the matched token index or -1. Exact matches take priority over
      fuzzy ones so a precisely spoken final word is never consumed by
      an earlier similar token. */
  private tryMatch(p: number, w: string): number {
    const ph = this.phrases[p];
    if (!ph) return -1;
    let set = this.matched.get(p);
    if (!set) {
      set = new Set();
      this.matched.set(p, set);
    }
    for (let t = 0; t < ph.tokens.length; t++) {
      if (set.has(t)) continue;
      if (wordsEqual(w, ph.tokens[t])) { // identical or same number
        set.add(t);
        let ex = this.exact.get(p);
        if (!ex) {
          ex = new Set();
          this.exact.set(p, ex);
        }
        ex.add(t);
        return t;
      }
    }
    for (let t = 0; t < ph.tokens.length; t++) {
      if (set.has(t)) continue;
      if (fuzzyMatch(w, ph.tokens[t])) {
        set.add(t);
        return t;
      }
    }
    return -1;
  }

  /** Content hits on phrase p by words that did NOT also match the
      then-current phrase — evidence the speaker has genuinely moved
      on, immune to shared-word double counting (repeated lines). */
  unambiguousEvidence(p: number): number {
    return this.fresh.get(p) ?? 0;
  }

  private dropBefore(idx: number): void {
    for (const key of [...this.matched.keys()]) {
      if (key < idx) {
        this.matched.delete(key);
        this.exact.delete(key);
      }
    }
    for (const key of [...this.fresh.keys()]) {
      if (key < idx) this.fresh.delete(key);
    }
  }

  private advanceTo(next: number, type: 'advance' | 'jump', rule: MatchRule, events: MatchEvent[]): void {
    this.current = next;
    // A jump's evidence IS the speaker saying phrase j, so it counts as
    // touched; a plain advance starts the new phrase untouched.
    this.touchedCurrent = type === 'jump';
    this.dropBefore(this.current);
    if (this.current >= this.phrases.length) {
      this.finished = true;
      this.current = this.phrases.length - 1;
    }
    events.push({ type, to: this.current, rule });
  }

  /**
   * Consume recognized words (already incremental — the speech source
   * emits only newly appended words). Returns what happened.
   */
  feed(words: string[], opts: FeedOptions = {}): FeedResult {
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
      const hitCurrent = this.tryMatch(this.current, w) >= 0;
      if (hitCurrent) {
        matchedAny = true;
        this.touchedCurrent = true;
      }
      for (let p = this.current + 1; p <= windowEnd; p++) {
        const tIdx = this.tryMatch(p, w);
        if (tIdx >= 0) {
          matchedAny = true;
          // only count as forward evidence when the word could NOT be
          // part of the current phrase (defeats repeated-line rushing)
          if (!hitCurrent && this.phrases[p].contentIdx.includes(tIdx)) {
            this.fresh.set(p, (this.fresh.get(p) ?? 0) + 1);
          }
        }
      }

      // Advancement normally requires evidence gathered while the
      // phrase was actually current (touchedCurrent) — carried
      // lookahead credits alone never advance, so shared words between
      // adjacent phrases can't chain the display ahead of the speaker.
      // At most one advance and one jump per recognized word.
      if (!this.finished) {
        let rule: MatchRule | null = null;
        const pct = this.progress(this.current);
        if (this.touchedCurrent) {
          const final = this.finalContentMatched(this.current);
          if (final === 'exact') rule = 'final-exact';
          else if (final === 'fuzzy' && pct >= this.cfg.finalWordMinPct) rule = 'final-fuzzy';
          else if (pct >= this.cfg.advancePct) rule = 'content-70';
          // Boundary-crossing rescue: the phrase is half-said and the
          // speaker has audibly started the NEXT phrase — a stalled
          // half-match must not pin the display.
          else if (
            pct >= this.cfg.rescuePct &&
            this.unambiguousEvidence(this.current + 1) >= 1
          ) rule = 'boundary-rescue';
        }
        // Post-restart grace: the current phrase's words may have been
        // eaten by the dead session, so next-phrase evidence alone is
        // enough (touchedCurrent may legitimately be false).
        if (
          rule === null &&
          opts.grace &&
          this.unambiguousEvidence(this.current + 1) >= 1
        ) rule = 'restart-grace';
        if (rule !== null) {
          this.advanceTo(this.current + 1, 'advance', rule, events);
        }
      }

      // Far skip: a later phrase is clearly being spoken while the
      // current one was barely touched — jump forward, never back.
      if (!this.finished) {
        const wEnd = Math.min(
          this.current + this.cfg.lookahead,
          this.phrases.length - 1,
        );
        if (this.progress(this.current) < this.cfg.skipCurrentBelowPct) {
          for (let j = this.current + 1; j <= wEnd; j++) {
            if (this.progress(j) >= this.cfg.advancePct) {
              this.advanceTo(j, 'jump', 'far-skip', events);
              break;
            }
          }
        }
      }
    }
    return { events, matchedAny, finished: this.finished };
  }

  /**
   * Forced single-step advance (stall self-heal). Keeps lookahead
   * credits so evidence gathered for upcoming phrases survives.
   */
  forceAdvance(): MatchEvent | null {
    if (this.finished) return null;
    const events: MatchEvent[] = [];
    this.advanceTo(this.current + 1, 'advance', 'self-heal', events);
    return events[0];
  }

  /** Manual navigation (remote/keys). Clears match state. */
  goTo(index: number): void {
    this.current = Math.max(0, Math.min(index, this.phrases.length - 1));
    this.finished = false;
    this.matched.clear();
    this.exact.clear();
    this.fresh.clear();
    this.touchedCurrent = false;
  }

  get length(): number {
    return this.phrases.length;
  }
}
