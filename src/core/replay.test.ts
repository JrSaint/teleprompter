import { describe, it, expect } from 'vitest';
import type { SessionLog, SessionEvent } from './recorder';
import { replaySession } from './replay';

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
