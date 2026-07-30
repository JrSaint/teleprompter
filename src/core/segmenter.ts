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
  // Pass 1: split runs into words, joining fragments across markup
  // boundaries when no whitespace separates them ("un{yellow:believable}"
  // is ONE word — the tagged fragment's tag wins for the whole word).
  const joined: RawWord[] = [];
  let glueNext = false;
  let pendingNewline = false;
  for (const run of parseInline(body)) {
    for (const piece of run.text.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) {
        glueNext = false;
        if (piece.includes('\n')) pendingNewline = true;
        continue;
      }
      if (glueNext && joined.length > 0 && !pendingNewline) {
        const prev = joined[joined.length - 1];
        prev.text += piece;
        if (prev.tag === undefined && run.tag !== undefined) prev.tag = run.tag;
      } else {
        joined.push({ text: piece, tag: run.tag, breakAfter: 0 });
        if (pendingNewline && joined.length > 1) {
          joined[joined.length - 2].breakAfter = 3;
        }
        pendingNewline = false;
      }
      glueNext = true;
    }
  }

  // Pass 2: slashes as manual break markers (standalone, leading, or
  // trailing only — never inside a word like "24/7"), standalone dashes
  // as tier-2 breaks, then punctuation strengths.
  const words: RawWord[] = [];
  const bumpPrev = (strength: number) => {
    if (words.length > 0 && words[words.length - 1].breakAfter < strength) {
      words[words.length - 1].breakAfter = strength;
    }
  };
  for (const w of joined) {
    let text = w.text;
    let ba = w.breakAfter;
    if (/^\/+$/.test(text)) {
      bumpPrev(3);
      continue;
    }
    if (/^\/+/.test(text)) {
      text = text.replace(/^\/+/, '');
      bumpPrev(3);
    }
    const trail = text.match(/\/+$/);
    if (trail && trail[0].length < text.length) {
      text = text.slice(0, -trail[0].length);
      ba = Math.max(ba, 3);
    }
    if (/^[-–—]+$/.test(text)) {
      // spaced dash: keep it visible on the previous word, tier-2 break
      if (words.length > 0) {
        words[words.length - 1].text += ' ' + text;
        bumpPrev(2);
        if (ba > 0) bumpPrev(ba);
      }
      continue;
    }
    if (!text) continue;
    if (/[.!?…]["'")\]]*$/.test(text)) ba = Math.max(ba, 3);
    else if (/[,;:—–]$/.test(text)) ba = Math.max(ba, 2);
    words.push({ text, tag: w.tag, breakAfter: ba });
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
  // Never leave a 1-word orphan (or a phrase with no matchable tokens —
  // e.g. standalone punctuation). Prefer stealing a single word from a
  // neighbor so both phrases stay within the word cap; swallow the whole
  // neighbor only when it's too small to give one up. Direction: a
  // sentence-final orphan ("…the hall.") rebalances BACKWARD within its
  // own sentence — merging it forward would glue two sentences together
  // and scatter phrases the matcher then can't align.
  const degenerate = (ph: RawWord[]) =>
    ph.length === 1 || ph.every((w) => !normalizeWord(w.text));
  for (let p = 0; p < phrases.length && phrases.length > 1; ) {
    const ph = phrases[p];
    if (!degenerate(ph)) {
      p++;
      continue;
    }
    const sentenceEnd = ph[ph.length - 1].breakAfter >= 3;
    const canBack = p > 0;
    const canFwd = p + 1 < phrases.length;
    if ((sentenceEnd && canBack) || !canFwd) {
      const prev = phrases[p - 1];
      if (prev.length <= 2 || ph.length > 1) {
        phrases[p - 1] = [...prev, ...ph];
        phrases.splice(p, 1);
        p--;
      } else {
        phrases[p] = [prev[prev.length - 1], ...ph];
        phrases[p - 1] = prev.slice(0, -1);
        p++;
      }
    } else {
      const nxt = phrases[p + 1];
      if (nxt.length <= 2 || ph.length > 1) {
        phrases[p + 1] = [...ph, ...nxt];
        phrases.splice(p, 1);
      } else {
        phrases[p] = [...ph, nxt[0]];
        phrases[p + 1] = nxt.slice(1);
        p++;
      }
    }
  }
  return phrases;
}

/** Split a script body (may contain {tag:…} markup) into phrases. */
export function segmentScript(body: string, lang: Lang): Phrase[] {
  return chunk(tokenize(body, lang)).map((ws) => {
    const tokens: string[] = [];
    for (const w of ws) {
      // "24/7", "07/30", "10:30" → one digit-group token per group, so
      // spoken digits can match each part (number folding lives in the
      // matcher's equality check).
      const bare = w.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (/^\d+(?:[/:.,-]\d+)+$/.test(bare)) {
        for (const group of bare.split(/[^\d]+/)) {
          if (group) tokens.push(group);
        }
        continue;
      }
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
