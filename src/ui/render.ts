import type { Phrase, PhraseWord } from '../core/segmenter';

/** Color tags renderable today; unknown tags pass through unstyled so
    future semantic tags ({verify:…}) degrade gracefully. */
const INK: Record<string, string> = {
  red: '#ff453a', orange: '#ff9f0a', yellow: '#ffd60a', green: '#30d158',
  blue: '#64d2ff', cyan: '#64d2ff', purple: '#bf5af2', pink: '#ff375f',
  white: '#ffffff', gray: '#8e8e93', grey: '#8e8e93',
};

function colorFor(tag?: string): string | null {
  if (!tag) return null;
  if (tag.startsWith('#')) return tag;
  return INK[tag.toLowerCase()] ?? null;
}

/** Render a phrase's words into an element (textContent-safe).
    Words go inside a single inline wrapper: the phrase containers are
    flex boxes, and flex layout drops whitespace-only text nodes. */
export function renderPhrase(el: HTMLElement, phrase: Phrase | null): void {
  el.innerHTML = '';
  if (!phrase) return;
  const wrap = document.createElement('span');
  phrase.words.forEach((w: PhraseWord, i: number) => {
    if (i > 0) wrap.appendChild(document.createTextNode(' '));
    const color = colorFor(w.tag);
    if (color) {
      const span = document.createElement('span');
      span.style.color = color;
      span.textContent = w.text;
      wrap.appendChild(span);
    } else {
      wrap.appendChild(document.createTextNode(w.text));
    }
  });
  el.appendChild(wrap);
}
