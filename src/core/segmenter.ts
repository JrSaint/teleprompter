import { parseInline } from './markup';
import { normalizeWord, bareWord, isStopword, isConjunction, type Lang } from './text';

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

/** Bump when the chunking algorithm changes: session headers record it
    so a tape can prove which segmentation actually rendered (B.3.3
    finding 0 — a segmentation change that never reaches the device
    must be visible in the data, not assumed). */
export const SEGMENTER_VERSION = 2;

/* v2 (B.3.3): 4–8 word phrases. The v1 5-word/30-char caps produced
   2-word crumbs ("rig test.", "then stop") and once-per-second swap
   churn; reading cadence wants a phrase to be most of a breath. */
const MAX_WORDS = 8;
const TARGET_WORDS = 6;
/** Soft width target; the display's per-script width-fit cap is the
    hard guarantee against mid-phrase wrapping. */
const TARGET_CHARS = 40;
const HARD_CHARS = 48;

/* Break strength between adjacent words:
   5 = manual "/" marker            (inviolable)
   4 = paragraph break              (inviolable)
   3 = sentence punctuation         (group boundary; micro-sentences
                                     of ≤2 words may glue across it)
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
          joined[joined.length - 2].breakAfter = 4;
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
      bumpPrev(5);
      continue;
    }
    if (/^\/+/.test(text)) {
      text = text.replace(/^\/+/, '');
      bumpPrev(5);
    }
    const trail = text.match(/\/+$/);
    if (trail && trail[0].length < text.length) {
      text = text.slice(0, -trail[0].length);
      ba = Math.max(ba, 5);
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

  // conjunction rule: prefer to break BEFORE these words (unfolded
  // comparison — "é" must not be mistaken for the conjunction "e")
  for (let i = 1; i < words.length; i++) {
    if (isConjunction(bareWord(words[i].text), lang)) {
      if (words[i - 1].breakAfter < 1) words[i - 1].breakAfter = 1;
    }
  }
  return words;
}

/* ---- v2 chunker: sentence groups + best-cut selection --------------- */

const hasMatchable = (g: RawWord[]) => g.some((w) => normalizeWord(w.text));

/** Cost of emitting words i..j (inclusive) of a group as one phrase. */
function chunkCost(g: RawWord[], i: number, j: number, lang: Lang): number {
  const len = j - i + 1;
  if (len > MAX_WORDS) return Infinity;
  let c = Math.abs(len - TARGET_WORDS) * 0.25;
  const interior = j < g.length - 1;
  const ba = interior ? g[j].breakAfter : 3;
  // crumbs only when a group leaves no choice; 3-word chunks are
  // tolerable at real boundaries (a comma clause) but must lose
  // ties to fuller cuts elsewhere
  if (len < 3) c += 4;
  else if (len === 3) c += ba >= 2 ? 0.4 : 1;
  const chars =
    g.slice(i, j + 1).reduce((s, w) => s + w.text.length, 0) + (len - 1);
  if (chars > TARGET_CHARS) c += (chars - TARGET_CHARS) * 0.12;
  if (chars > HARD_CHARS) c += (chars - HARD_CHARS) * 2;
  if (interior) {
    // prefer real prosodic boundaries…
    c += ba >= 2 ? 0 : ba === 1 ? 0.35 : 1.4;
    // …and never dangle a function word at a MADE-UP cut ("stayed
    // with |", "encontrou de |"). Tier-1 cuts are real boundaries —
    // a pronoun before a conjunction ends its clause legitimately.
    if (ba === 0 && isStopword(normalizeWord(g[j].text), lang)) c += 0.6;
  }
  return c;
}

/** Minimum-cost segmentation of one group via DP over cut positions. */
function cutGroup(g: RawWord[], lang: Lang): RawWord[][] {
  const n = g.length;
  const best = new Array<number>(n + 1).fill(Infinity);
  const cutAt = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    // i descending: on exact cost ties the LATER cut wins (front-
    // loaded phrases — "…stayed with you | the whole way through.")
    for (let i = j - 1; i >= Math.max(0, j - MAX_WORDS); i--) {
      const c = best[i] + chunkCost(g, i, j - 1, lang);
      if (c < best[j] - 1e-9) {
        best[j] = c;
        cutAt[j] = i;
      }
    }
  }
  const chunks: RawWord[][] = [];
  for (let j = n; j > 0; j = cutAt[j]) chunks.unshift(g.slice(cutAt[j], j));
  return chunks;
}

function chunk(words: RawWord[], lang: Lang): RawWord[][] {
  // Hard boundaries end a group: sentence punctuation, paragraph
  // breaks, manual "/" markers. No phrase ever spans one — with the
  // single deliberate exception below.
  const groups: RawWord[][] = [];
  let cur: RawWord[] = [];
  for (const w of words) {
    cur.push(w);
    if (w.breakAfter >= 3) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) groups.push(cur);

  // Micro-sentences (≤2 words — "Good.", "Muito bem." — or nothing
  // matchable) read as beats, not phrases; standalone they are the
  // crumb churn B.3.3 kills. Glue them across a PLAIN sentence
  // boundary: forward when their own break is sentence punctuation,
  // else backward (paragraph-final beats attach to their own
  // paragraph). Tagged micros ({red:…}) stand alone by design, and
  // paragraph/manual breaks are never crossed.
  const isMicro = (g: RawWord[]) =>
    (g.length <= 2 || !hasMatchable(g)) && g.every((w) => w.tag === undefined);
  for (let i = 0; i < groups.length && groups.length > 1; ) {
    const g = groups[i];
    if (!isMicro(g)) {
      i++;
      continue;
    }
    const ownBreak = g[g.length - 1].breakAfter;
    const prevBreak = i > 0 ? groups[i - 1][groups[i - 1].length - 1].breakAfter : 99;
    if (ownBreak === 3 && i + 1 < groups.length) {
      groups[i + 1] = [...g, ...groups[i + 1]];
      groups.splice(i, 1);
    } else if (prevBreak === 3) {
      groups[i - 1] = [...groups[i - 1], ...g];
      groups.splice(i, 1);
    } else {
      i++; // fenced in by hard breaks — the author's own doing
    }
  }

  return groups.flatMap((g) => cutGroup(g, lang));
}

function toPhrase(ws: RawWord[]): Phrase {
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
  return { words: ws, text: ws.map((w) => w.text).join(' '), tokens, contentIdx: [] };
}

function finishPhrase(p: Phrase, lang: Lang): Phrase {
  let contentIdx = p.tokens
    .map((t, idx) => (isStopword(t, lang) ? -1 : idx))
    .filter((idx) => idx >= 0);
  if (contentIdx.length === 0) contentIdx = p.tokens.map((_, idx) => idx);
  return {
    words: p.words.map(({ text, tag }) => (tag === undefined ? { text } : { text, tag })),
    text: p.text,
    tokens: p.tokens,
    contentIdx,
  };
}

/** Split a script body (may contain {tag:…} markup) into phrases. */
export function segmentScript(body: string, lang: Lang): Phrase[] {
  return chunk(tokenize(body, lang), lang).map((ws) => finishPhrase(toPhrase(ws), lang));
}

/** One recorded phrase text → a Phrase, with NO re-chunking. Replay
    uses this so a session replays against the exact phrase list it
    displayed, regardless of how the segmenter has evolved since. */
export function phraseFromText(text: string, lang: Lang): Phrase {
  return finishPhrase(toPhrase(tokenize(text, lang)), lang);
}
