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

  it('boundary-rescue: half-matched phrase advances when the next phrase starts', () => {
    // recognizer mangled half of phrase A including the final word;
    // speaker moves on — the display must not stay pinned
    const { m } = build('The morning fog settled early. We walked the narrow path.');
    m.feed(['morning', 'fog']); // 2 of 4 content words, final word never comes
    expect(m.current).toBe(0);
    const r = m.feed(['walked']); // first content word of the NEXT phrase
    expect(r.events.some((e) => e.rule === 'boundary-rescue')).toBe(true);
    expect(m.current).toBe(1);
  });

  it('boundary-rescue does not fire below the rescue threshold', () => {
    const { m } = build('The morning fog settled early. We walked the narrow path.');
    m.feed(['morning']); // 1 of 4 = 25% < 40%
    m.feed(['walked']);
    expect(m.current).toBe(0);
  });

  it('far-skip gate raised to 40%: a third-matched phrase can still be rescued by a jump', () => {
    const { m } = build('Alpha bravo charlie tonight. / Delta echo foxtrot gather. / Golf hotel india juliet.');
    m.feed(['alpha']); // 1 of 4 content ≈ 25–33% — above old 30% gate on 3-content phrases
    const r = m.feed(['golf', 'hotel', 'india', 'juliet']);
    expect(r.events.some((e) => e.type === 'jump')).toBe(true);
    expect(m.current).toBeGreaterThanOrEqual(2);
  });

  it('post-restart grace: next-phrase evidence alone advances', () => {
    // the whole current phrase was eaten by a dead session
    const { m } = build('The morning fog settled early. We walked the narrow path.');
    const r = m.feed(['walked'], { grace: true });
    expect(r.events.some((e) => e.rule === 'restart-grace')).toBe(true);
    expect(m.current).toBe(1);
    // without grace the same single word does nothing
    const { m: m2 } = build('The morning fog settled early. We walked the narrow path.');
    m2.feed(['walked']);
    expect(m2.current).toBe(0);
  });

  it('folds numbers: digits and spelled forms match both ways (EN and PT)', () => {
    const { m } = build('Doors open at seven sharp. Everything begins right then.');
    const r = m.feed(['doors', 'open', 'at', '7', 'sharp']);
    expect(r.events.some((e) => e.type === 'advance')).toBe(true);

    const { m: pt } = build('O culto começa às sete horas. Todos chegam bem antes.', 'pt-BR');
    const r2 = pt.feed(['o', 'culto', 'comeca', 'as', '7', 'horas']);
    expect(r2.events.some((e) => e.type === 'advance')).toBe(true);

    // spelled recognition against a digit script token
    const { m: en2 } = build('The store closes at 9 tonight. Nobody stays after that.');
    const r3 = en2.feed(['store', 'closes', 'at', 'nine', 'tonight']);
    expect(r3.events.some((e) => e.type === 'advance')).toBe(true);
  });

  it('matches digit groups inside 24/7-style tokens', () => {
    const { m, phrases } = build('We are open 24/7 here. Come by any time friend.');
    expect(phrases[0].tokens).toContain('24');
    expect(phrases[0].tokens).toContain('7');
    const r = m.feed(['we', 'are', 'open', '24', '7', 'here']);
    expect(r.events.some((e) => e.type === 'advance')).toBe(true);
  });

  it('forceAdvance steps one phrase and keeps lookahead credits', () => {
    const { m } = build('One two three four. Five six seven eight. Nine ten eleven twelve.');
    m.feed(['five', 'six']); // lookahead credits on phrase 1
    const e = m.forceAdvance();
    expect(e?.rule).toBe('self-heal');
    expect(m.current).toBe(1);
    // the earlier credits survive: two more words complete phrase 1
    m.feed(['seven', 'eight']);
    expect(m.current).toBe(2);
  });

  it('RC1: one untranscribable loanword cannot hold a phrase hostage (all-but-one)', () => {
    // Siri pt-BR never emits "prompter"; with 3 content words, matching
    // all but one must complete the phrase
    const { m, phrases } = build('We walked the hill prompter. Something else entirely follows here.');
    const content0 = phrases[0].contentIdx.length;
    expect(content0).toBeGreaterThanOrEqual(3);
    const r = m.feed(['walked', 'hill']); // everything except the loanword
    expect(r.events.some((e) => e.rule === 'all-but-one')).toBe(true);
    expect(m.current).toBe(1);
  });

  it('RC1: all-but-one does not apply to 2-content phrases', () => {
    const { m } = build('The prompter waited. Something else entirely follows here.');
    m.feed(['prompter']); // 1 of 2 content, not the final word — must NOT complete
    expect(m.current).toBe(0);
  });

  it('RC2: a short (≤3-letter) final content word cannot advance alone, even exact', () => {
    const { m, phrases } = build('Keep the faith and joy. Another sentence comes right after.');
    const finalTok = phrases[0].tokens[phrases[0].contentIdx[phrases[0].contentIdx.length - 1]];
    expect(finalTok).toBe('joy');
    const r = m.feed(['joy']); // stray exact hit, zero other evidence
    expect(r.events.length).toBe(0);
    expect(m.current).toBe(0);
    // with half the phrase behind it, the same word completes normally
    m.feed(['keep', 'faith', 'joy']);
    expect(m.current).toBe(1);
  });

  it('RC3: a duplicated word never cross-credits a similar token (este→teste)', () => {
    const { m } = build('Este é o teste de sessenta segundos agora.', 'pt-BR');
    m.feed(['este']);
    const before = m.contentMatchedCount(0);
    m.feed(['este']); // duplicate interim re-emission
    expect(m.contentMatchedCount(0)).toBe(before); // "teste" NOT credited
    expect(m.current).toBe(0);                      // and no advance
    // the real word still lands afterwards and completes the phrase
    m.feed(['teste']);
    expect(m.current).toBe(1);
  });

  it('every advance and jump carries evidence ≥ 1', () => {
    const { m } = build('We begin tonight. The river was rising fast. Nothing else moved there.');
    const all = [
      ...m.feed(['we', 'begin', 'tonight']).events,
      ...m.feed(['the', 'river', 'was', 'rising', 'fast']).events,
      ...m.feed(['nothing', 'else', 'moved', 'there']).events,
    ];
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const e of all) expect(e.evidence).toBeGreaterThanOrEqual(1);
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
