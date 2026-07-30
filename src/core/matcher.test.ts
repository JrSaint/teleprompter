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
      'First we gather in the hall. / Then we march across the bridge.',
    );
    expect(phrases.length).toBeGreaterThanOrEqual(3);
    // speaker skips the rest of sentence one and starts sentence two,
    // which lives within the 3-phrase lookahead window
    const r = m.feed(['then', 'we', 'march', 'across']);
    expect(r.events.some((e) => e.type === 'jump')).toBe(true);
    expect(m.current).toBeGreaterThanOrEqual(2);
  });

  it('can finish the script normally after a jump', () => {
    const { m } = build(
      'First we gather in the hall. / Then we march across the bridge.',
    );
    m.feed(['then', 'we', 'march', 'across']); // jump into sentence two
    const r = m.feed(['the', 'bridge']);
    expect(r.finished || m.current >= 3).toBe(true);
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

  it('does not advance on a lone fuzzy stopword hit on the final word', () => {
    // "not" (off-script, in the stopword list) is Levenshtein-1 from
    // final content word "now" — a single fuzzy hit must NOT advance
    const { m } = build('Leave the stage now. Wait for the applause please.');
    const r = m.feed(['not']);
    expect(r.events.length).toBe(0);
    expect(m.current).toBe(0);
    // …but actually speaking the phrase still advances
    m.feed(['leave', 'the', 'stage', 'now']);
    expect(m.current).toBe(1);
  });

  it('prefers exact token matches over earlier fuzzy-similar tokens', () => {
    // phrase has both "star" and "stars"; spoken "stars" (exact for the
    // final word) must not be consumed by the earlier "star"
    const { m } = build('The star counts stars. Another phrase entirely here now.');
    m.feed(['the', 'star', 'counts', 'stars']);
    expect(m.current).toBe(1);
  });

  it('does not chain-advance through lookahead credits alone', () => {
    // adjacent phrases share every word; speaking the line once must
    // advance exactly one phrase, not rush through the repeat
    const { m, phrases } = build('Holy holy holy. / Holy holy holy. / Amen forever and ever.');
    expect(phrases.length).toBeGreaterThanOrEqual(3);
    m.feed(['holy', 'holy', 'holy']);
    expect(m.current).toBe(1);
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
