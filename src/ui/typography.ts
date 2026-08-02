/**
 * Distance-based type sizing (locked from research):
 *   cap height (cm) ≈ standing distance (cm) × 0.0051, times a user
 *   multiplier of 1.0–2.0.
 * CSS pixels are defined as 96/inch; cap height for a heavy sans is
 * ~0.72 of the font-size box, so we divide to get font-size.
 */
export function fontPxForDistance(distanceFt: number, mult: number): number {
  const distanceCm = distanceFt * 30.48;
  const capCm = distanceCm * 0.0051 * mult;
  const capPx = (capCm / 2.54) * 96;
  return Math.round(capPx / 0.72);
}

/** Average glyph width of the display font at 100px, measured once —
    the segmentation budget converts a font size into a char ceiling
    with it. Fallback matches -apple-system's measured average. */
export const AVG_CHAR_W_100 = (() => {
  const ctx = document.createElement('canvas')?.getContext?.('2d');
  if (!ctx) return 52;
  ctx.font = '700 100px -apple-system, system-ui, sans-serif';
  const ref = 'the quick brown fox jumps over a lazy dog, e as palavras vao seguir voce.';
  return ctx.measureText(ref).width / ref.length;
})();

/** Usable prompter line width (the block/column pads 6vw per side). */
export const availWidthPx = (): number => window.innerWidth * 0.88;
