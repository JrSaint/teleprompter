import { describe, it, expect } from 'vitest';
import { RIG_SCRIPTS } from '../store/seeds';
import { segmentScript } from './segmenter';
import { PhraseMatcher } from './matcher';

/**
 * The seeded rig-test scripts choreograph the Phase A protocol, so
 * their structure is load-bearing: the red skip block must sit within
 * the matcher's 3-phrase lookahead, ad-lib must hold, and a straight
 * read-through must finish. Guard all of it against script edits.
 */
describe.each(RIG_SCRIPTS.map((s) => [s.title, s] as const))('%s', (_title, script) => {
  const phrases = segmentScript(script.body, script.lang);

  it('segments into clean phrases (no orphans)', () => {
    expect(phrases.length).toBeGreaterThan(10);
    for (const p of phrases) {
      expect(p.words.length).toBeGreaterThanOrEqual(2);
      expect(p.tokens.length).toBeGreaterThan(0);
    }
  });

  it('v2 acceptance (B.3.3): 4–8 word cadence, zero crumbs, sentences intact', () => {
    // crumb churn killed: nothing under 3 words, mean around a breath
    expect(phrases.length).toBeLessThanOrEqual(26); // was 36/38 on v1
    for (const p of phrases) {
      expect(p.words.length).toBeGreaterThanOrEqual(3);
      expect(p.words.length).toBeLessThanOrEqual(8);
    }
    const words = phrases.reduce((n, p) => n + p.words.length, 0);
    expect(words / phrases.length).toBeGreaterThanOrEqual(5);
    // no phrase runs across a sentence end — the single exception is a
    // glued micro-beat ("Good.", "Muito bem.") LEADING a phrase, where
    // the stop sits within the first two words
    for (const p of phrases) {
      p.words.forEach((w, i) => {
        if (i < p.words.length - 1 && /[.!?…]["'")\]]*$/.test(w.text)) {
          expect(i).toBeLessThanOrEqual(1);
        }
      });
    }
  });

  it('a straight read-through reaches the end', () => {
    const m = new PhraseMatcher(phrases);
    for (const p of phrases) m.feed(p.tokens);
    expect(m.finished).toBe(true);
  });

  it('holds through an ad-lib and rejoins', () => {
    const m = new PhraseMatcher(phrases);
    m.feed(phrases[0].tokens);
    m.feed(phrases[1].tokens);
    const at = m.current;
    // genuinely off-script words — no lexical overlap with either script
    m.feed('zeppelin marmalade quantum crocodile wintergreen bicycle harmonica stalactite'.split(' '));
    expect(m.current).toBe(at);
    m.feed(phrases[at].tokens);
    expect(m.current).toBeGreaterThan(at);
  });

  it('keeps the red skip block visible and within the lookahead', () => {
    const isRed = (i: number) => phrases[i].words.some((w) => w.tag === 'red');
    const firstRed = phrases.findIndex((_, i) => isRed(i));
    expect(firstRed).toBeGreaterThan(0);
    let lastRed = firstRed;
    while (lastRed + 1 < phrases.length && isRed(lastRed + 1)) lastRed++;
    const resume = lastRed + 1;
    expect(resume).toBeLessThan(phrases.length);
    // The display shows current + ONE preview: while holding on the red
    // phrase, the resume line must be the visible preview — so the red
    // block must be exactly one phrase.
    expect(lastRed).toBe(firstRed);
    // jump distance from the first red phrase to the resume phrase
    expect(resume - firstRed).toBeLessThanOrEqual(3);
  });

  it('skipping the red block jumps forward to the resume phrase', () => {
    const isRed = (i: number) => phrases[i].words.some((w) => w.tag === 'red');
    const firstRed = phrases.findIndex((_, i) => isRed(i));
    let lastRed = firstRed;
    while (lastRed + 1 < phrases.length && isRed(lastRed + 1)) lastRed++;
    const resume = lastRed + 1;

    const m = new PhraseMatcher(phrases);
    for (let i = 0; i < firstRed; i++) m.feed(phrases[i].tokens);
    expect(m.current).toBe(firstRed);
    // reader skips the red block and speaks the resume phrase
    m.feed(phrases[resume].tokens);
    expect(m.current).toBeGreaterThanOrEqual(resume);
    // and the rest of the script still completes
    for (let i = m.current; i < phrases.length; i++) m.feed(phrases[i].tokens);
    expect(m.finished).toBe(true);
  });
});
