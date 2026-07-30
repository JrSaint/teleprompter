import { describe, it, expect } from 'vitest';
import { segmentScript } from './segmenter';
import { stripMarkup, parseInline } from './markup';

const texts = (body: string, lang: 'en-US' | 'pt-BR' = 'en-US') =>
  segmentScript(body, lang).map((p) => p.text);

describe('segmenter', () => {
  it('splits on sentence punctuation first', () => {
    const out = texts('We begin tonight. The river was rising fast.');
    expect(out[0]).toBe('We begin tonight.');
    expect(out.join(' ')).toBe('We begin tonight. The river was rising fast.');
    // no phrase longer than 5 words
    for (const p of segmentScript('We begin tonight. The river was rising fast.', 'en-US')) {
      expect(p.words.length).toBeLessThanOrEqual(5);
      expect(p.words.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('honors manual "/" break markers and hides the slash', () => {
    const out = texts('Hold the line / no matter what happens');
    expect(out[0]).toBe('Hold the line');
    expect(out[1].startsWith('no matter')).toBe(true);
    expect(out.join(' ')).not.toContain('/');
  });

  it('breaks at commas before falling back to word caps', () => {
    const out = texts('First we gather, then we march together');
    expect(out[0]).toBe('First we gather,');
  });

  it('prefers breaking before conjunctions', () => {
    const out = texts('The night was cold and the road was long');
    // "and" should start a phrase, not end one
    const withAnd = out.find((t) => t.includes('and'));
    expect(withAnd!.startsWith('and')).toBe(true);
  });

  it('never emits a 1-word phrase (merges orphans forward)', () => {
    const out = segmentScript('Stop. Everything you know is wrong.', 'en-US');
    for (const p of out) expect(p.words.length).toBeGreaterThanOrEqual(2);
    expect(out[0].text.startsWith('Stop.')).toBe(true);
  });

  it('keeps phrases under ~30 characters when unbroken text is long', () => {
    const long = 'supercalifragilistic expialidocious antidisestablishmentarianism words continue here now';
    for (const p of segmentScript(long, 'en-US')) {
      expect(p.words.length).toBeLessThanOrEqual(5);
    }
  });

  it('handles pt-BR: conjunctions and diacritics preserved in display', () => {
    const out = segmentScript('A noite era fria mas a estrada era longa', 'pt-BR');
    const withMas = out.find((p) => p.text.includes('mas'));
    expect(withMas!.text.startsWith('mas')).toBe(true);
    const acc = segmentScript('O coração da cidade não dorme nunca.', 'pt-BR');
    expect(acc.map((p) => p.text).join(' ')).toContain('coração');
    // tokens are folded for matching
    expect(acc.flatMap((p) => p.tokens)).toContain('coracao');
  });

  it('carries markup tags onto words and strips them from tokens', () => {
    const out = segmentScript('Remember the {yellow:key point} tonight everyone', 'en-US');
    const tagged = out.flatMap((p) => p.words).filter((w) => w.tag === 'yellow');
    expect(tagged.map((w) => w.text)).toEqual(['key', 'point']);
    for (const p of out) {
      for (const t of p.tokens) {
        expect(t).not.toContain('{');
        expect(t).not.toContain('}');
      }
    }
  });

  it('classifies content words vs stopwords', () => {
    const [p] = segmentScript('the river was rising', 'en-US');
    // content words: river, rising — not "the"/"was"
    const content = p.contentIdx.map((i) => p.tokens[i]);
    expect(content).toContain('river');
    expect(content).toContain('rising');
    expect(content).not.toContain('the');
  });

  it('falls back to all tokens when a phrase is only stopwords', () => {
    const out = segmentScript('To be or not to be. That is the question of our age.', 'en-US');
    for (const p of out) expect(p.contentIdx.length).toBeGreaterThan(0);
  });
});

describe('markup', () => {
  it('parses generic {tag:text} runs', () => {
    const runs = parseInline('plain {yellow:gold} and {verify:locked line} end');
    expect(runs.map((r) => r.tag)).toEqual([undefined, 'yellow', undefined, 'verify', undefined]);
  });
  it('strips markup to visible text', () => {
    expect(stripMarkup('a {red:b} c {#ff0000:d}')).toBe('a b c d');
  });
});
