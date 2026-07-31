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
import ptbrRig1 from './fixtures/rigtest-pt-2026-07-30.json';

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

/* B.0 lead-mode regression: both PT fixtures replayed with lead swap
   timing — no chains (one move per trigger, strictly forward), same
   far-skip, still finishes, all moves evidenced. */
import ptbrRig2 from './fixtures/rigtest-pt-2026-07-30b.json';

describe.each([
  ['rigtest-pt-2026-07-30', ptbrRig1 as unknown as SessionLog],
  ['rigtest-pt-2026-07-30b', ptbrRig2 as unknown as SessionLog],
])('lead-mode replay: %s', (_name, log) => {
  const lead = replaySession(log, { leadMode: true });

  it('finishes with every move evidenced, never backward', () => {
    expect(lead.finished).toBe(true);
    for (const m of lead.moves) expect(m.evidence).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < lead.path.length; i++) {
      expect(lead.path[i]).toBeGreaterThanOrEqual(lead.path[i - 1]);
    }
  });

  it('never cascades more than one phrase per trigger token', () => {
    const byTime = new Map<number, number>();
    for (const m of lead.moves.filter((x) => x.type === 'advance')) {
      byTime.set(m.t, (byTime.get(m.t) ?? 0) + 1);
    }
    for (const n of byTime.values()) expect(n).toBeLessThanOrEqual(1);
  });

  it('keeps the red-line far-skip', () => {
    expect(lead.moves.some((m) => m.rule === 'far-skip')).toBe(true);
  });
});

it('lead-mode replay: zero moves inside the acceptance-tape ad-lib window', () => {
  // fixture-b improv ran t≈61233–68906; lead must add no moves there
  // (the t=68906 boundary advance is the reader literally speaking the
  // phrase words — rule-correct in both modes)
  const lead = replaySession(ptbrRig2 as unknown as SessionLog, { leadMode: true });
  const inWindow = lead.moves.filter((m) => m.t >= 61233 && m.t < 68906);
  expect(inWindow).toEqual([]);
});

/* B.2 close-out tapes: first working on-device recognizer sessions.
   EN pins the "the end" incident fix (see fixtures/README.md): the
   engine never emitted "end", a stale "and" fuzzy-banked onto it, and
   the display teleported a phrase ahead. The corrected replay must
   glide via tail-rescue on the first next-phrase content evidence and
   never jump. PT pins that the honest paths — evidence-backed
   far-skip, live alias fold, ad-lib holds — survive the tightening. */
import enNative from './fixtures/rigtest-en-native-2026-07-31.json';
import ptNative from './fixtures/rigtest-pt-native-2026-07-31.json';

describe('fixture en-native (B.2 close-out tape)', () => {
  const log = enNative as unknown as SessionLog;
  const r = replaySession(log);

  it('kills the ambiguous far-skip teleport (tape: jump 30→31 at t=76868)', () => {
    expect(r.moves.filter((m) => m.type === 'jump')).toEqual([]);
  });

  it('glides past the engine-dropped tail via tail-rescue on first next-phrase evidence', () => {
    const phrases = segmentScript(log.script.body, log.script.lang);
    const endIdx = phrases.findIndex((p) => p.text === 'the end.');
    expect(endIdx).toBeGreaterThan(0);
    const out = r.moves.find((m) => m.to === endIdx + 1);
    // fires on "screen" (t=80492) — not a stall, not a mislabeled lead
    expect(out?.rule).toBe('tail-rescue');
    expect(out?.t).toBe(80492);
    expect(out?.evidence).toBeGreaterThanOrEqual(1);
  });

  it('re-emission batches advance nothing (all six full re-statements consumed silently)', () => {
    const batchTimes = [26476, 49060, 56705, 78883];
    for (const m of r.moves) expect(batchTimes).not.toContain(m.t);
  });

  it('the ad-lib held and the tape finishes with every move evidenced', () => {
    // weather improv ran t≈49255–52478; "good" at 52478 is the reader
    // back on script (phrase-final word) — rule-correct boundary
    const inWindow = r.moves.filter((m) => m.t > 49255 && m.t < 52478);
    expect(inWindow).toEqual([]);
    expect(r.finished).toBe(true);
    for (const m of r.moves) expect(m.evidence).toBeGreaterThanOrEqual(1);
  });
});

describe('fixture pt-native (B.2 close-out tape)', () => {
  const log = ptNative as unknown as SessionLog;
  const r = replaySession(log);

  it('keeps the evidence-backed far-skip over the red line', () => {
    const skip = r.moves.find((m) => m.rule === 'far-skip');
    expect(skip?.t).toBe(75012);
    expect(skip?.evidence).toBeGreaterThanOrEqual(3);
  });

  it('live alias fold still advances on "pro" → prompter (t=54623)', () => {
    const m = r.moves.find((x) => x.t === 54623);
    expect(m?.rule).toBe('lead');
  });

  it('re-emission batches and the ad-lib advance nothing', () => {
    const batchTimes = [26059, 31403, 50123, 57508, 70158, 73613, 79611, 86829];
    for (const m of r.moves) expect(batchTimes).not.toContain(m.t);
    // comida improv ran t≈45878–48611; "voltar" at 48611 is script
    const inAdlib = r.moves.filter((m) => m.t > 45201 && m.t < 48611);
    expect(inAdlib).toEqual([]);
  });

  it('finishes with every move evidenced, never backward', () => {
    expect(r.finished).toBe(true);
    for (const m of r.moves) expect(m.evidence).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < r.path.length; i++) {
      expect(r.path[i]).toBeGreaterThanOrEqual(r.path[i - 1]);
    }
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
      const tokenCount = log.events.filter((e) => e.kind === 'token').length;
      if (tokenCount > 0) {
        // logs recorded before B.2 don't say which swap timing they ran
        // with — accept a finish in either mode for those
        const finished =
          r.finished ||
          (log.swapTiming === undefined &&
            replaySession(log, { leadMode: true }).finished);
        expect(finished).toBe(true);
      } else {
        // failure-capture fixture (e.g. the native zero-output session):
        // nothing was heard, so nothing may move
        expect(r.moves).toEqual([]);
      }
    },
  );
});
