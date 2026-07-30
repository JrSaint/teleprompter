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
