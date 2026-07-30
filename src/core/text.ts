/** Language code used across the app. */
export type Lang = 'en-US' | 'pt-BR';

/**
 * Normalize a word for matching: lowercase, fold diacritics, strip
 * everything that isn't a letter or digit. "Coração," → "coracao".
 */
export function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Classic Levenshtein distance (words are short; O(mn) is fine). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Fuzzy equality for recognized words vs script tokens.
 * Levenshtein ≤ 2, tightened to ≤ 1 when either word has ≤ 4 letters.
 */
export function fuzzyMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const max = Math.min(a.length, b.length) <= 4 ? 1 : 2;
  if (Math.abs(a.length - b.length) > max) return false;
  return levenshtein(a, b) <= max;
}

/* Function words: excluded from the "content word" percentage the matcher
   uses to decide an advance. Normalized forms (diacritics folded). */
const STOP_EN = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by',
  'from', 'as', 'and', 'but', 'or', 'so', 'is', 'are', 'was', 'were',
  'be', 'been', 'am', 'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'his', 'her',
  'our', 'their', 'not', 'do', 'does', 'did', 'have', 'has', 'had',
  'will', 'would', 'can', 'could', 'there', 'here',
]);
/* Folded forms only — isStopword() receives normalized tokens. */
const STOP_PT = new Set([
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da',
  'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'por', 'para', 'com',
  'sem', 'e', 'mas', 'ou', 'que', 'se', 'sao', 'foi', 'era',
  'ser', 'estar', 'esta', 'estao', 'eu', 'voce', 'ele', 'ela',
  'eles', 'elas', 'meu', 'minha', 'seu', 'sua', 'nao', 'ja', 'la',
  'ao', 'aos', 'pelo', 'pela', 'num', 'numa',
]);

export function isStopword(token: string, lang: Lang): boolean {
  return (lang === 'pt-BR' ? STOP_PT : STOP_EN).has(token);
}

/* Words the segmenter prefers to break BEFORE (conjunctions and
   subordinators), per the locked break-priority rules. */
const CONJ_EN = new Set([
  'and', 'but', 'or', 'because', 'when', 'if', 'so', 'while',
  'after', 'before', 'unless', 'until',
]);
const CONJ_PT = new Set([
  'e', 'mas', 'ou', 'porque', 'quando', 'se', 'entao', 'enquanto',
  'depois', 'antes', 'ate',
]);

export function isConjunction(token: string, lang: Lang): boolean {
  return (lang === 'pt-BR' ? CONJ_PT : CONJ_EN).has(token);
}
