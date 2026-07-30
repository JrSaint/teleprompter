/**
 * Generic inline markup: {tag:some text}. Today tags are colors
 * ({yellow:…}, {#ff0000:…}); later phases add semantic tags (e.g.
 * locked lines verified verbatim), so the parser carries the tag
 * through untouched and lets renderers decide what it means.
 */

export interface InlineRun {
  text: string;
  tag?: string;
}

const TAG_RE = /\{([a-zA-Z]+|#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))\s*:\s*([^}]*)\}/g;

/** Parse a script body into runs of tagged / untagged text. */
export function parseInline(body: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const re = new RegExp(TAG_RE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m.index > last) runs.push({ text: body.slice(last, m.index) });
    runs.push({ text: m[2], tag: m[1] });
    last = m.index + m[0].length;
  }
  if (last < body.length) runs.push({ text: body.slice(last) });
  return runs;
}

/** Visible text with all markup removed. */
export function stripMarkup(body: string): string {
  return parseInline(body).map((r) => r.text).join('');
}
