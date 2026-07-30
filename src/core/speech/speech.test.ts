import { describe, it, expect } from 'vitest';
import { appendedWords } from './WebSpeechSource';

describe('appendedWords (interim-result diffing)', () => {
  it('emits only newly appended words', () => {
    expect(appendedWords(['we', 'begin'], ['we', 'begin', 'tonight'])).toEqual(['tonight']);
  });

  it('ignores case/punctuation-only revisions of earlier words', () => {
    // engine finalizes "big dreams need" as "Big dreams, need" — nothing new
    expect(appendedWords(['big', 'dreams', 'need'], ['Big', 'dreams,', 'need'])).toEqual([]);
  });

  it('re-emits from the first genuinely revised word', () => {
    expect(appendedWords(['we', 'befin', 'tonight'], ['we', 'begin', 'tonight'])).toEqual(['begin', 'tonight']);
  });

  it('handles empty previous transcript', () => {
    expect(appendedWords([], ['hello', 'there'])).toEqual(['hello', 'there']);
  });
});
