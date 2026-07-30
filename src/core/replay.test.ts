import { describe, it, expect } from 'vitest';
import type { SessionLog, SessionEvent } from './recorder';
import { replaySession, declumpLog, compareClumpLag } from './replay';
import { segmentScript } from './segmenter';

/**
 * Replay-harness fixtures. These are SYNTHETIC reconstructions of the
 * three incident classes from the first rig test (stall, over-eager
 * hold vs skip, restart-eaten words) — real "Copy log" exports from the
 * rig drop in with the same shape and become the authoritative
 * fixtures. "OLD" = Phase A constants (no rescue, 30% skip gate, no
 * grace) to demonstrate before/after.
 */

const OLD = { rescuePct: 1.01, skipCurrentBelowPct: 0.3 };

let t = 0;
const tok = (word: string, final = false): SessionEvent =>
  ({ t: (t += 120), kind: 'token', word, final });
const mic = (status: string): SessionEvent => ({ t: (t += 10), kind: 'mic', status });

function session(script: { title: string; lang: 'en-US' | 'pt-BR'; body: string }, events: SessionEvent[]): SessionLog {
  return { version: 1, id: 'fixture', startedAtIso: '2026-07-30T00:00:00Z', script, events };
}

describe('replay harness', () => {
  it('incident: stall on a half-matched phrase (boundary rescue fixes it)', () => {
    t = 0;
    const log = session(
      { title: 'stall', lang: 'en-US', body: 'The morning fog settled early. We walked the narrow path.' },
      [
        // recognizer got half of phrase 1, mangled the rest incl. the final word
        tok('morning'), tok('fog'), tok('hurley'),
        // speaker is already into phrase 2
        tok('walked'), tok('narrow'), tok('path', true),
      ],
    );
    const before = replaySession(log, OLD);
    const after = replaySession(log);
    expect(before.finalIndex).toBe(0);            // stuck — the recorded incident
    expect(after.moves[0]?.rule).toBe('boundary-rescue');
    expect(after.finished).toBe(true);            // rides through to the end
  });

  it('incident: restart eats a phrase (grace window fixes it)', () => {
    t = 0;
    const body = 'The morning fog settled early. We walked the narrow path.';
    const log = session({ title: 'restart', lang: 'en-US', body }, [
      mic('listening'),
      mic('restarting'),
      mic('listening'), // gap over — grace window opens here
      // everything of phrase 1 was eaten; first words heard are phrase 2
      tok('walked'), tok('narrow'), tok('path', true),
    ]);
    const withGrace = replaySession(log);
    expect(withGrace.moves[0]?.rule).toBe('restart-grace');
    expect(withGrace.finished).toBe(true);
    // Without grace, the old config only recovers via far-skip AFTER
    // the entire next phrase is spoken — the recorded lag. Grace moves
    // on the FIRST word instead.
    const stripped = { ...log, events: log.events.filter((e) => e.kind !== 'mic') };
    const withoutGrace = replaySession(stripped, OLD);
    expect(withoutGrace.moves[0]?.rule).toBe('far-skip');
    expect(withoutGrace.moves[0].t).toBeGreaterThan(withGrace.moves[0].t);
  });

  it('incident: clump crossing two phrase boundaries steps through both, no far-skip', () => {
    t = 0;
    const log = session(
      { title: 'clump', lang: 'en-US', body: 'Alpha bravo charlie. Delta echo foxtrot. Golf hotel india.' },
      // Safari releases one delayed clump spanning two full phrases
      ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((w) => tok(w)),
    );
    const r = replaySession(log);
    const advances = r.moves.filter((m) => m.type === 'advance');
    expect(advances.length).toBe(2);
    expect(r.moves.every((m) => m.type === 'advance')).toBe(true); // stepped, never jumped
    expect(r.path).toEqual([0, 1, 2]);
  });

  it('de-clump mode: clumped delivery fires advances later than de-clumped', () => {
    // two phrases' words withheld by Safari and released in one burst
    const body = 'Alpha bravo charlie. Delta echo foxtrot. Golf hotel india.';
    const events: SessionEvent[] = [
      { t: 1000, kind: 'token', word: 'alpha', final: false },
      // …then Safari goes quiet and dumps everything at t≈9000
      ...['bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((word, i) => ({
        t: 9000 + i * 8, kind: 'token' as const, word, final: false,
      })),
    ];
    const log = session({ title: 'clumplag', lang: 'en-US', body }, events);
    const de = declumpLog(log);
    const deToks = de.events.filter((e) => e.kind === 'token');
    // burst got spread across the silent interval instead of stacking at 9s
    expect(deToks[1].t).toBeLessThan(8000);
    const report = compareClumpLag(log);
    expect(report.clumpedMoves).toBe(report.declumpedMoves);
    expect(report.medianDeltaMs).toBeGreaterThan(1000); // Safari's share of the lag
  });

  it('regression: ad-lib still holds under the new constants', () => {
    t = 0;
    const log = session(
      { title: 'adlib', lang: 'en-US', body: 'Hold the line tonight. Stand together as one people.' },
      'zeppelin marmalade quantum crocodile wintergreen bicycle harmonica stalactite'.split(' ').map((w) => tok(w)),
    );
    const r = replaySession(log);
    expect(r.moves.length).toBe(0);
    expect(r.finalIndex).toBe(0);
  });
});

/* First real pt-BR rig tape (2026-07-30, recorded on the A.1 build).
   Tape "before": bogus advances at t=4543/4757 (é-conjunction
   segmentation bug + stopword finals), 19.7s hostage on the "prompter"
   phrase, duplicate re-emission cross-credits. Pins the A.2 behavior. */
import ptbrRig1 from './fixtures/ptbr-rig-1.json';

describe('fixture ptbr-rig-1 (real tape)', () => {
  const log = ptbrRig1 as unknown as SessionLog;
  const r = replaySession(log);

  it('kills the early bogus advances (tape: t=4543 and t=4757)', () => {
    // first legitimate advance is the number-folded "60" rescue at 8624
    expect(r.moves[0].t).toBeGreaterThanOrEqual(8000);
    expect(r.moves[0].evidence).toBeGreaterThanOrEqual(1);
  });

  it('advances past the "prompter" phrase on the first matchable word', () => {
    const phrases = segmentScript(log.script.body, log.script.lang);
    const promptIdx = phrases.findIndex((p) => p.tokens.includes('prompter'));
    expect(promptIdx).toBeGreaterThan(0);
    const out = r.moves.find((m) => m.to === promptIdx + 1);
    // "espero" (fuzzy esperou) lands at t=87309 — no post-evidence stall
    expect(out?.t).toBeLessThanOrEqual(87400);
  });

  it('still far-skips the red line and finishes', () => {
    const skip = r.moves.find((m) => m.rule === 'far-skip');
    expect(skip).toBeDefined();
    expect(r.finished).toBe(true);
  });

  it('exercises the all-but-one rule on real Siri drops', () => {
    expect(r.moves.filter((m) => m.rule === 'all-but-one').length).toBeGreaterThanOrEqual(1);
  });
});

/* Real rig-session fixtures: drop "Copy log" JSON into ./fixtures and
   every file is replayed against the regression contract. */
const realFixtures = Object.entries(
  import.meta.glob('./fixtures/*.json', { eager: true }),
) as Array<[string, { default: SessionLog }]>;

describe.skipIf(realFixtures.length === 0)('real rig fixtures', () => {
  it.each(realFixtures.map(([p, m]) => [p.replace(/^.*\//, ''), m.default] as const))(
    '%s: no zero-evidence moves, replays to finished',
    (_name, log) => {
      const r = replaySession(log);
      for (const move of r.moves) {
        expect(move.evidence).toBeGreaterThanOrEqual(1);
      }
      expect(r.finished).toBe(true);
    },
  );
});
