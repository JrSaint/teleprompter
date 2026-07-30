import { describe, expect, it } from 'vitest';
import { segmentScript } from './segmenter';
import { PhraseMatcher } from './matcher';
import { fuzzyMatch, isStopword } from './text';

describe('probe: reviewer claim — single fuzzy final-word hit advances', () => {
  it('segments the script as claimed', () => {
    const phrases = segmentScript('Leave the stage now. Wait for the applause please.', 'en-US');
    console.log(JSON.stringify(phrases.map((p) => ({ text: p.text, tokens: p.tokens, contentIdx: p.contentIdx })), null, 2));
    expect(phrases[0].tokens[phrases[0].tokens.length - 1]).toBe('now');
  });

  it('fuzzyMatch("not","now") behavior', () => {
    console.log('fuzzyMatch not/now =', fuzzyMatch('not', 'now'));
    console.log('isStopword not =', isStopword('not', 'en-US'));
  });

  it('feeding the single off-script word "not"', () => {
    const phrases = segmentScript('Leave the stage now. Wait for the applause please.', 'en-US');
    const m = new PhraseMatcher(phrases);
    const res = m.feed(['not']);
    console.log('events =', JSON.stringify(res.events), 'current =', m.current, 'matchedAny =', res.matchedAny);
    console.log('progress(0) before feed would-be — other content matched check');
  });

  it('other short-final-word neighbors: so/go, a/at, in/win', () => {
    for (const [heard, script] of [
      ['so', 'Please go'],
      ['at', 'Give it a'],
      ['in', 'You can win'],
    ] as const) {
      const phrases = segmentScript(`${script}. Second phrase here now everyone.`, 'en-US');
      const m = new PhraseMatcher(phrases);
      const res = m.feed([heard]);
      console.log(heard, '->', JSON.stringify(phrases[0].tokens), 'events:', JSON.stringify(res.events));
    }
  });
});
