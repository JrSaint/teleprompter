import { describe, it, expect } from 'vitest';
import { segmentScript } from './segmenter';
import { PhraseMatcher } from './matcher';

const build = (body: string, lang: 'en-US' | 'pt-BR' = 'en-US') => {
  const phrases = segmentScript(body, lang);
  return { phrases, m: new PhraseMatcher(phrases) };
};

describe('matcher', () => {
  it('advances phrase by phrase as the script is spoken', () => {
    const { m } = build('We begin tonight. The river was rising fast.');
    expect(m.current).toBe(0);
    const r1 = m.feed(['we', 'begin', 'tonight']);
    expect(r1.events.some((e) => e.type === 'advance')).toBe(true);
    expect(m.current).toBe(1);
    const r2 = m.feed(['the', 'river', 'was', 'rising', 'fast']);
    expect(r2.finished).toBe(true);
  });

  it('holds on ad-lib: off-script words never advance', () => {
    const { m } = build('Hold the line tonight. Stand together as one people.');
    const adlib = 'let me tell you a quick story about my grandmother yesterday morning'.split(' ');
    const r = m.feed(adlib);
    expect(m.current).toBe(0);
    expect(r.events.length).toBe(0);
  });

  it('rejoins after an ad-lib when script words resume', () => {
    const { m } = build('Hold the line tonight. Stand together as one people.');
    m.feed('completely different words spoken here for several seconds honestly'.split(' '));
    expect(m.current).toBe(0);
    m.feed(['hold', 'the', 'line', 'tonight']);
    expect(m.current).toBe(1);
  });

  it('matches proper nouns fuzzily (Michael Phelps case)', () => {
    const { m } = build('Michael Phelps broke the record. Nobody expected that finish.');
    // recognizer mangles the surname: "felps" (common PT-phonetic miss)
    const r = m.feed(['michael', 'felps', 'broke', 'record']);
    expect(r.events.some((e) => e.type === 'advance')).toBe(true);
    expect(m.current).toBeGreaterThanOrEqual(1);
  });

  it('is stricter with short words (≤4 letters → distance ≤1)', () => {
    const { m } = build('The cat sat quietly. Nothing else moved there.');
    // "cut" is 1 edit from "cat" → accepted; "dog" is 3 → rejected
    const r1 = m.feed(['dog']);
    expect(r1.matchedAny).toBe(false);
    const r2 = m.feed(['cut']);
    expect(r2.matchedAny).toBe(true);
  });

  it('folds diacritics for pt-BR matching', () => {
    const { m } = build('O coração da cidade não dorme nunca.', 'pt-BR');
    // ASR output usually lacks diacritics context — feed folded forms
    const r = m.feed(['coracao', 'cidade', 'nao']);
    expect(r.matchedAny).toBe(true);
    expect(m.current).toBeGreaterThanOrEqual(0);
    m.feed(['dorme', 'nunca']);
    expect(m.finished || m.current > 0).toBe(true);
  });

  it('skips forward when a later phrase is clearly spoken', () => {
    const { m, phrases } = build(
      'First we gather in the hall. / Then we march across the bridge. / Finally we sing the anthem loudly.',
    );
    expect(phrases.length).toBeGreaterThanOrEqual(3);
    // speaker jumps straight to the "finally" phrase
    const r = m.feed(['finally', 'we', 'sing', 'anthem', 'loudly']);
    expect(r.events.some((e) => e.type === 'jump' || e.type === 'advance')).toBe(true);
    expect(m.current).toBeGreaterThanOrEqual(2);
  });

  it('never auto-jumps backward', () => {
    const { m } = build('One two three four. Five six seven eight. Nine ten eleven twelve.');
    m.feed(['one', 'two', 'three', 'four']);
    const at = m.current;
    m.feed(['one', 'two', 'three', 'four']); // repeat earlier phrase
    expect(m.current).toBeGreaterThanOrEqual(at);
  });

  it('advances at ≥70% of content words without the final word', () => {
    const phrases = segmentScript('red orange yellow green blue', 'en-US');
    expect(phrases.length).toBe(1);
    const m = new PhraseMatcher([
      ...phrases,
      ...segmentScript('another phrase entirely here', 'en-US'),
    ]);
    // 4 of 5 content words, final word "blue" never said → 80% ≥ 70%
    const r = m.feed(['red', 'orange', 'yellow', 'green']);
    expect(r.events.some((e) => e.type === 'advance')).toBe(true);
  });

  it('supports manual navigation including backward', () => {
    const { m } = build('One two three four. Five six seven eight. Nine ten eleven twelve.');
    m.feed(['one', 'two', 'three', 'four']);
    expect(m.current).toBe(1);
    m.goTo(0);
    expect(m.current).toBe(0);
    m.feed(['one', 'two', 'three', 'four']);
    expect(m.current).toBe(1);
  });
});
