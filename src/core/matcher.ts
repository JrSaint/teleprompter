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
  /** Lead swap timing: the display swaps once every content word
      EXCEPT the final one is consumed (≥2-content phrases; 1-content
      phrases keep confirm behavior). Display-timing repoint only — all
      evidence rules, consume-once, and never-backward are unchanged. */
  leadMode: boolean;
  /** Pronunciation aliases: recognized variant → script target token
      (normalized), folded before consumption. */
  aliases?: Map<string, string>;
}

const DEFAULTS: MatcherConfig = {
  lookahead: 3,
  advancePct: 0.7,
  rescuePct: 0.4,
  skipCurrentBelowPct: 0.4,
  finalWordMinPct: 0.5,
  leadMode: false,
};

/** Which rule moved the display — recorded per decision for tuning. */
export type MatchRule =
  | 'lead'             // lead mode: all content words except the final consumed
  | 'final-exact'      // exact hit on the final content word
  | 'final-fuzzy'      // fuzzy final-word hit with ≥finalWordMinPct support
  | 'content-70'       // ≥advancePct of content words matched
  | 'all-but-one'      // ≥3 content words and all but one matched — no
                       //   single unmatchable word (loanword) vetoes
  | 'boundary-rescue'  // ≥rescuePct matched AND next phrase already started
  | 'tail-rescue'      // engine-dropped tail: all but the final content
                       //   word matched, the final never heard, and the
                       //   next phrase audibly started — glide, not stall
  | 'restart-grace'    // post-restart grace: next-phrase evidence alone
  | 'far-skip'         // later phrase ≥advancePct while current <skip gate
  | 'self-heal'        // forced by the controller's stall self-heal
  | 'flow-predict';    // Flow mode: pace-model predicted the remaining
                       //   words were spoken before the engine emitted them

export interface MatchEvent {
  type: 'advance' | 'jump';
  to: number; // new current phrase index
  rule: MatchRule;
  /** Content-word hits backing the move at fire time: the from-phrase's
      count for advances, the target's for jumps, the next phrase's
      unambiguous count for grace and tail-rescue. Proves no
      zero-evidence moves. */
  evidence: number;
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
  /** fed words that consumed a CONTENT token (current or lookahead) —
      the Flow pace model's confirmed-word signal */
  contentHits: number;
  /** whether the LAST fed word matched anything — an unmatched tail
      suspends Flow prediction until evidence resumes */
  lastWordMatched: boolean;
}

export class PhraseMatcher {
  private phrases: Phrase[];
  private cfg: MatcherConfig;
  private matched = new Map<number, Set<number>>(); // phrase → matched token idx
  private exact = new Map<number, Set<number>>();   // subset matched exactly
  private fresh = new Map<number, number>();        // unambiguous content hits
  private touchedCurrent = false; // a word matched the phrase WHILE current
  /** After a lead/all-but-one/tail-rescue/flow advance: the completed
      phrase's unmatched tokens. Late arrivals matching them are the
      tail of the OLD phrase — absorbed one by one until the list is
      exhausted or a non-leftover word arrives (a flow-predicted swap
      can leave SEVERAL unspoken words; single-shot absorption let the
      rest credit the next phrase and rush the display). */
  private leftover: string[] | null = null;
  /** Previous fed word — a consecutive duplicate (interim re-emission)
      may exact-match a genuinely repeated token but never fuzzy-match. */
  private prevWord = '';
  /** Every word form that has ever been consumed by some token. The
      per-phrase consume-once sets die with dropBefore(), so a
      re-emitted old word ("and", consumed two phrases ago) could
      fuzzy-claim a fresh token ("end") after its phrase was dropped —
      the EN native tape's t=78883 batch did exactly that. A form that
      found a home may exact-match again (genuinely repeated words)
      but never fuzzy-match a different token. */
  private consumed = new Set<string>();
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

  /** Content-match ratio counting EXACT hits only (0..1). */
  private exactContentProgress(p: number): number {
    const ph = this.phrases[p];
    const ex = this.exact.get(p);
    if (!ph || ph.contentIdx.length === 0) return 0;
    if (!ex) return 0;
    let hit = 0;
    for (const idx of ph.contentIdx) if (ex.has(idx)) hit++;
    return hit / ph.contentIdx.length;
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

  /** The phrase's final content token itself (for the short-word gate). */
  private finalContentToken(p: number): string {
    const ph = this.phrases[p];
    if (!ph || ph.contentIdx.length === 0) return '';
    return ph.tokens[ph.contentIdx[ph.contentIdx.length - 1]];
  }

  /** Every content word except the final is matched (exact OR fuzzy);
      vacuously true for single-content phrases. The tail-rescue
      precondition — unlike the lead trigger this tolerates fuzzy
      non-final hits, because the unambiguous next-phrase evidence does
      the confirming. */
  private allButFinalContentMatched(p: number): boolean {
    const ph = this.phrases[p];
    if (!ph || ph.contentIdx.length === 0) return false;
    const set = this.matched.get(p);
    for (let i = 0; i < ph.contentIdx.length - 1; i++) {
      if (!set?.has(ph.contentIdx[i])) return false;
    }
    return true;
  }

  /** Lead-mode trigger: every content word EXCEPT the final one is
      matched EXACTLY (requires ≥2 content words). Exact-only keeps the
      early swap honest — fuzzy ad-lib noise ("muitas"≈"muito") must
      not fire it; alias-folded hits count as exact. */
  private nonFinalContentComplete(p: number): boolean {
    const ph = this.phrases[p];
    const ex = this.exact.get(p);
    if (!ph || !ex || ph.contentIdx.length < 2) return false;
    for (let i = 0; i < ph.contentIdx.length - 1; i++) {
      if (!ex.has(ph.contentIdx[i])) return false;
    }
    return true;
  }

  /** Try to mark one token of phrase p as matched by word w. Returns
      the matched token index or -1. Exact matches take priority over
      fuzzy ones so a precisely spoken final word is never consumed by
      an earlier similar token. */
  private tryMatch(p: number, w: string, allowFuzzy = true): number {
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
        this.consumed.add(w);
        let ex = this.exact.get(p);
        if (!ex) {
          ex = new Set();
          this.exact.set(p, ex);
        }
        ex.add(t);
        return t;
      }
    }
    // Duplicate suppression: a word identical to an already-satisfied
    // token is a re-hearing (interim re-emission, repeated delivery) —
    // it must not fuzzy-spill onto a different token ("este" must never
    // cross-credit "teste" on its second arrival).
    if (!allowFuzzy) return -1;
    for (const t of set) {
      if (wordsEqual(w, ph.tokens[t])) return -1;
    }
    for (let t = 0; t < ph.tokens.length; t++) {
      if (set.has(t)) continue;
      if (fuzzyMatch(w, ph.tokens[t])) {
        set.add(t);
        this.consumed.add(w);
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

  private advanceTo(next: number, type: 'advance' | 'jump', rule: MatchRule, evidence: number, events: MatchEvent[]): void {
    this.current = next;
    // A jump's evidence IS the speaker saying phrase j, so it counts as
    // touched; a plain advance starts the new phrase untouched.
    this.touchedCurrent = type === 'jump';
    this.dropBefore(this.current);
    if (this.current >= this.phrases.length) {
      this.finished = true;
      this.current = this.phrases.length - 1;
    }
    events.push({ type, to: this.current, rule, evidence });
  }

  /**
   * Consume recognized words (already incremental — the speech source
   * emits only newly appended words). Returns what happened.
   */
  feed(words: string[], opts: FeedOptions = {}): FeedResult {
    const events: MatchEvent[] = [];
    let matchedAny = false;
    let contentHits = 0;
    let lastWordMatched = false;
    for (const raw of words) {
      let w = normalizeWord(raw);
      if (!w || this.finished) continue;
      // pronunciation aliases: fold recognized variant → script target
      w = this.cfg.aliases?.get(w) ?? w;

      // absorb the completed phrase's late-arriving tail, word by
      // word; the first non-leftover word ends the glide
      if (this.leftover !== null) {
        const hit = this.leftover.findIndex(
          (tok) => wordsEqual(w, tok) || fuzzyMatch(w, tok),
        );
        if (hit >= 0) {
          this.leftover.splice(hit, 1);
          if (this.leftover.length === 0) this.leftover = null;
          matchedAny = true; // it's script speech, just already accounted
          lastWordMatched = true;
          continue;
        }
        this.leftover = null;
      }

      // match against the current phrase and the lookahead window
      const windowEnd = Math.min(
        this.current + this.cfg.lookahead,
        this.phrases.length - 1,
      );
      // Fuzzy rights: never for a consecutive duplicate, and never for
      // a form that already found a home (survives dropBefore — see
      // `consumed`). Exact matching is always allowed.
      const fuzzyOk = w !== this.prevWord && !this.consumed.has(w);
      this.prevWord = w;
      const curIdx = this.tryMatch(this.current, w, fuzzyOk);
      const hitCurrent = curIdx >= 0;
      lastWordMatched = hitCurrent;
      if (hitCurrent) {
        matchedAny = true;
        this.touchedCurrent = true;
        if (this.phrases[this.current].contentIdx.includes(curIdx)) contentHits++;
      }
      for (let p = this.current + 1; p <= windowEnd; p++) {
        // A word the current phrase already explains may still
        // exact-match ahead (genuinely repeated words) but must not
        // fuzzy-BANK lookahead credit: "and" exact-hit its own phrase
        // and fuzzy-credited a later "end" (lev 1), poisoning that
        // phrase's progress to 100% and teleporting the display
        // (EN native tape t=76868).
        const tIdx = this.tryMatch(p, w, fuzzyOk && !hitCurrent);
        if (tIdx >= 0) {
          matchedAny = true;
          lastWordMatched = true;
          if (this.phrases[p].contentIdx.includes(tIdx)) {
            if (!hitCurrent) contentHits++;
            // only count as forward evidence when the word could NOT be
            // part of the current phrase (defeats repeated-line rushing)
            if (!hitCurrent) {
              this.fresh.set(p, (this.fresh.get(p) ?? 0) + 1);
            }
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
        const hits = this.contentMatchedCount(this.current);
        const contentTotal = this.phrases[this.current]?.contentIdx.length ?? 0;
        if (this.touchedCurrent) {
          // Lead swap timing: everything but the final word is in — the
          // late-arriving final word is absorbed by the completed phrase
          // via the leftover machinery below.
          if (this.cfg.leadMode && this.nonFinalContentComplete(this.current)) {
            rule = 'lead';
          }
          if (rule === null) {
            const final = this.finalContentMatched(this.current);
            // A final content word of ≤3 letters (normalized) is too
            // easy to hit by accident ("é", "joy") — even an exact hit
            // needs half the phrase's content behind it.
            const shortFinal = this.finalContentToken(this.current).length <= 3;
            if (
              final === 'exact' &&
              (!shortFinal || pct >= this.cfg.finalWordMinPct)
            ) rule = 'final-exact';
            // A fuzzy final cannot be its own support: the backing pct
            // excludes the final itself, else a 1-content phrase
            // ("the end.") self-satisfies the gate on any near-miss.
            else if (
              final === 'fuzzy' &&
              contentTotal > 0 &&
              (hits - 1) / contentTotal >= this.cfg.finalWordMinPct
            ) rule = 'final-fuzzy';
            else if (pct >= this.cfg.advancePct) rule = 'content-70';
            // Integer-aware completion: with ≥3 content words, all but
            // one matched completes the phrase — one untranscribable
            // loanword must never hold the display hostage.
            else if (contentTotal >= 3 && hits >= contentTotal - 1) rule = 'all-but-one';
            // Engine-dropped tail: everything except the final content
            // word is in, the final was never heard AT ALL, and the
            // speaker has audibly started the next phrase. Low-content
            // phrases sit below the rescue gate forever otherwise —
            // the recognizer simply never emitted "end" on the EN
            // native tape and "the end." stalled until self-heal.
            else if (
              this.finalContentMatched(this.current) === 'none' &&
              this.allButFinalContentMatched(this.current) &&
              this.unambiguousEvidence(this.current + 1) >= 1
            ) rule = 'tail-rescue';
          }
        }
        // Boundary-crossing rescue: the phrase is half-in and the
        // speaker has audibly started the NEXT phrase. Needs no touch:
        // when the display lags, every hearable token of the phrase can
        // arrive pre-consumed as lookahead credit (re-hearings then
        // dup-suppress), so touch may be unobtainable — the EN web tape
        // wedged on exactly that. The unambiguous next-phrase evidence
        // IS live speech the current phrase cannot explain.
        if (
          rule === null &&
          pct >= this.cfg.rescuePct &&
          this.unambiguousEvidence(this.current + 1) >= 1
        ) rule = 'boundary-rescue';
        // Post-restart grace: the current phrase's words may have been
        // eaten by the dead session, so next-phrase evidence alone is
        // enough (touchedCurrent may legitimately be false).
        if (
          rule === null &&
          opts.grace &&
          this.unambiguousEvidence(this.current + 1) >= 1
        ) {
          rule = 'restart-grace';
          this.advanceTo(
            this.current + 1, 'advance', rule,
            this.unambiguousEvidence(this.current + 1), events,
          );
        } else if (rule !== null) {
          if (rule === 'all-but-one' || rule === 'lead' || rule === 'tail-rescue') {
            // absorb the phrase's remaining word(s) when they arrive late
            const ph = this.phrases[this.current];
            const set = this.matched.get(this.current);
            this.leftover = ph.tokens.filter((_, t) => !set?.has(t));
          }
          // tail-rescue is backed by the NEXT phrase's unambiguous
          // hits — the from-phrase count can legitimately be 0 there
          const evidence = rule === 'tail-rescue'
            ? this.unambiguousEvidence(this.current + 1)
            : hits;
          this.advanceTo(this.current + 1, 'advance', rule, evidence, events);
        }
      }

      // Far skip: a later phrase is clearly being spoken while the
      // current one was barely touched — jump forward, never back.
      if (!this.finished) {
        const wEnd = Math.min(
          this.current + this.cfg.lookahead,
          this.phrases.length - 1,
        );
        // The current-phrase gate counts EXACT content only: a lone
        // fuzzy hit on a mangled line ("baixo"≈"abaixo" when Safari
        // heard "primeiro baixo" for "vermelha abaixo") must not pin
        // the display while a later phrase is spoken unambiguously.
        if (this.exactContentProgress(this.current) < this.cfg.skipCurrentBelowPct) {
          for (let j = this.current + 1; j <= wEnd; j++) {
            // Progress alone can be poisoned by ambiguous credit (a
            // word the current phrase also explains); a far jump needs
            // at least one content hit that could NOT have been the
            // current phrase.
            if (
              this.progress(j) >= this.cfg.advancePct &&
              this.unambiguousEvidence(j) >= 1
            ) {
              this.advanceTo(j, 'jump', 'far-skip', this.contentMatchedCount(j), events);
              break;
            }
          }
        }
      }
    }
    return { events, matchedAny, finished: this.finished, contentHits, lastWordMatched };
  }

  /**
   * Forced single-step advance (stall self-heal). Keeps lookahead
   * credits so evidence gathered for upcoming phrases survives.
   */
  forceAdvance(): MatchEvent | null {
    if (this.finished) return null;
    const events: MatchEvent[] = [];
    const evidence = this.unambiguousEvidence(this.current + 1);
    this.advanceTo(this.current + 1, 'advance', 'self-heal', evidence, events);
    return events[0];
  }

  /**
   * Predictive advance (Flow mode). The phrase's unspoken tail is
   * expected momentarily — absorb its late arrival via leftover.
   * Never predicts the finish: the last phrase completes on evidence.
   */
  flowAdvance(): MatchEvent | null {
    if (this.finished || this.current + 1 >= this.phrases.length) return null;
    const events: MatchEvent[] = [];
    const ph = this.phrases[this.current];
    const set = this.matched.get(this.current);
    this.leftover = ph.tokens.filter((_, t) => !set?.has(t));
    this.advanceTo(
      this.current + 1, 'advance', 'flow-predict',
      this.contentMatchedCount(this.current), events,
    );
    return events[0];
  }

  /** Manual navigation (remote/keys). Clears match state. */
  goTo(index: number): void {
    this.current = Math.max(0, Math.min(index, this.phrases.length - 1));
    this.finished = false;
    this.matched.clear();
    this.exact.clear();
    this.fresh.clear();
    this.consumed.clear();
    this.touchedCurrent = false;
    this.leftover = null;
  }

  get length(): number {
    return this.phrases.length;
  }

  /** Whether any word matched the current phrase WHILE it was current.
      Flow prediction requires it — a phrase confirmed purely by banked
      lookahead credit is not one the speaker has demonstrably entered. */
  get touched(): boolean {
    return this.touchedCurrent;
  }
}
