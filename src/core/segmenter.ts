import { parseInline } from './markup';
import { normalizeWord, isStopword, isConjunction, type Lang } from './text';

/** One display word, carrying its markup tag (if any). */
export interface PhraseWord {
  text: string;      // display form, punctuation attached
  tag?: string;      // inline markup tag ({yellow:…} etc.)
}

/** One prompter phrase — the unit the display swaps by. */
export interface Phrase {
  words: PhraseWord[];
  text: string;          // plain visible text of the phrase
  tokens: string[];      // normalized tokens for matching
  contentIdx: number[];  // indices into tokens that are content words
}

const MAX_WORDS = 5;
const MAX_CHARS = 30;

/* Break strength between adjacent words:
   3 = sentence punctuation, manual "/", newline  (always break)
   2 = comma / semicolon / colon / dash
   1 = before a conjunction or subordinator
   0 = none */
interface RawWord extends PhraseWord {
  breakAfter: number;
}

function tokenize(body: string, lang: Lang): RawWord[] {
  const words: RawWord[] = [];
  const bump = (strength: number) => {
    if (words.length > 0 && words[words.length - 1].breakAfter < strength) {
      words[words.length - 1].breakAfter = strength;
    }
  };
  for (const run of parseInline(body)) {
    for (const piece of run.text.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) {
        if (piece.includes('\n')) bump(3);
        continue;
      }
      // "/" is a manual phrase break, never displayed
      const parts = piece.split('/');
      parts.forEach((part, idx) => {
        if (part) {
          const w: RawWord = { text: part, tag: run.tag, breakAfter: 0 };
          if (/[.!?…]["'")\]]*$/.test(part)) w.breakAfter = 3;
          else if (/[,;:—–]$/.test(part)) w.breakAfter = 2;
          words.push(w);
        }
        if (idx < parts.length - 1) bump(3); // the "/" itself
      });
    }
  }
  // conjunction rule: prefer to break BEFORE these words
  for (let i = 1; i < words.length; i++) {
    if (isConjunction(normalizeWord(words[i].text), lang)) {
      if (words[i - 1].breakAfter < 1) words[i - 1].breakAfter = 1;
    }
  }
  return words;
}

function chunk(words: RawWord[]): RawWord[][] {
  const phrases: RawWord[][] = [];
  let i = 0;
  while (i < words.length) {
    // widest window from i respecting word and char caps (always ≥1 word)
    let end = i;
    let chars = words[i].text.length;
    while (end + 1 < words.length && end - i + 1 < MAX_WORDS) {
      const added = 1 + words[end + 1].text.length;
      if (chars + added > MAX_CHARS) break;
      end++;
      chars += added;
    }
    // choose the cut: earliest sentence-level break wins outright;
    // otherwise strongest boundary in window, latest on ties;
    // otherwise fill the window.
    let cut = end;
    let best = 0;
    for (let k = i; k <= end; k++) {
      const s = words[k].breakAfter;
      if (s >= 3) { cut = k; best = 3; break; }
      if (k < end && s >= best && s > 0) { best = s; cut = k; }
    }
    if (best === 0) cut = end;
    phrases.push(words.slice(i, cut + 1));
    i = cut + 1;
  }
  // never leave a 1-word orphan: merge it forward (backward if it's last)
  for (let p = 0; p < phrases.length; ) {
    if (phrases[p].length === 1 && phrases.length > 1) {
      if (p + 1 < phrases.length) {
        phrases[p + 1] = [...phrases[p], ...phrases[p + 1]];
        phrases.splice(p, 1);
      } else {
        phrases[p - 1] = [...phrases[p - 1], ...phrases[p]];
        phrases.splice(p, 1);
        p--;
      }
    } else {
      p++;
    }
  }
  return phrases;
}

/** Split a script body (may contain {tag:…} markup) into phrases. */
export function segmentScript(body: string, lang: Lang): Phrase[] {
  return chunk(tokenize(body, lang)).map((ws) => {
    const tokens: string[] = [];
    for (const w of ws) {
      const t = normalizeWord(w.text);
      if (t) tokens.push(t);
    }
    let contentIdx = tokens
      .map((t, idx) => (isStopword(t, lang) ? -1 : idx))
      .filter((idx) => idx >= 0);
    if (contentIdx.length === 0) contentIdx = tokens.map((_, idx) => idx);
    return {
      words: ws.map(({ text, tag }) => (tag === undefined ? { text } : { text, tag })),
      text: ws.map((w) => w.text).join(' '),
      tokens,
      contentIdx,
    };
  });
}
