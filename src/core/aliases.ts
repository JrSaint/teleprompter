import { normalizeWord } from './text';

/**
 * Per-script pronunciation aliases for loanwords and brand names the
 * recognizer can't produce ("prompter" in pt-BR). One per line:
 *
 *   target: variant, variant, ...
 *   prompter: peter, pro, pt
 *
 * A recognized variant is folded to its target token BEFORE the
 * matcher consumes it. Everything is normalized (lowercase, diacritics
 * folded), so "Péter" and "peter" behave identically. Targets and
 * variants are single tokens; alias each word of a multi-word name
 * ("kids", "chore", "chart") on its own line.
 */
export function parseAliases(text: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!text) return map;
  for (const line of text.split('\n')) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const target = normalizeWord(line.slice(0, at));
    if (!target) continue;
    for (const variant of line.slice(at + 1).split(',')) {
      const v = normalizeWord(variant);
      if (v && v !== target) map.set(v, target);
    }
  }
  return map;
}
