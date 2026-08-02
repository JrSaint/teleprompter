import { describe, expect, it } from 'vitest';
import { stripMarkup } from './markup';

/**
 * Render truth (B.3.6): decisions say where the matcher went; render
 * events say what the SCREEN did. For every fixture that carries
 * render events, each settled snapshot must show the active phrase's
 * slot at the 100% tier with the active phrase's text — the class of
 * bug where the line being read sits at a faded tier can never ship
 * silently again.
 *
 * Fixtures recorded before B.3.6 carry no render events and are
 * skipped; the assertion is a standing contract for every tape going
 * forward.
 */

type RenderEvent = {
  kind: 'render';
  phase: 'target' | 'settled';
  active: number;
  slots: Array<{ p: number; tier: number; text?: string; dy?: number; band?: number }>;
  t: number;
};

const fixtures = import.meta.glob<{
  default: { phrases?: string[]; events: Array<{ kind: string }> };
}>('./fixtures/*.json', { eager: true });

describe('render truth', () => {
  for (const [path, mod] of Object.entries(fixtures)) {
    const log = mod.default;
    const renders = (log.events as RenderEvent[]).filter((e) => e.kind === 'render');
    if (renders.length === 0 || !log.phrases) continue;
    it(`${path.split('/').pop()}: active slot is bright and correct`, () => {
      for (const r of renders) {
        const slot = r.slots.find((s) => s.p === r.active);
        expect(slot, `render@${r.t} (${r.phase}): no slot shows active ${r.active}`).toBeTruthy();
        expect(slot!.tier, `render@${r.t} (${r.phase}): active ${r.active} at tier ${slot!.tier}`)
          .toBeGreaterThanOrEqual(0.99);
        if (r.phase === 'settled' && slot!.dy !== undefined) {
          // column truth: Step settles ON the anchor (±2px); Glide
          // holds the active line inside the anchor band while
          // following (band = half-width px, from the tape)
          expect(
            Math.abs(slot!.dy),
            `render@${r.t}: active ${r.active} settled ${slot!.dy}px off anchor`,
          ).toBeLessThanOrEqual(slot!.band ?? 2);
        }
        if (r.phase === 'settled' && slot!.text) {
          const want = stripMarkup(log.phrases![r.active] ?? '').trim();
          expect(
            want.startsWith(slot!.text.slice(0, 12)),
            `render@${r.t}: settled text "${slot!.text}" != phrase ${r.active} "${want.slice(0, 24)}"`,
          ).toBe(true);
        }
      }
    });
  }

  it('placeholder until first render-carrying tape lands', () => {
    // keeps the describe non-empty while no fixture has render events
    expect(true).toBe(true);
  });
});
