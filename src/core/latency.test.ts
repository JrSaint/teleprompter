import { describe, it, expect } from 'vitest';
import { LagSampler } from './latency';
import { median, p90 } from './diag';
import type { SessionLog } from './recorder';
import enB33 from './fixtures/rigtest-en-b33-2026-07-31.json';
import ptB33 from './fixtures/rigtest-pt-b33-2026-07-31.json';

describe('LagSampler rules (B.3.3 finding 2)', () => {
  it('every onset opens a sample; the first fresh token closes it', () => {
    const s = new LagSampler();
    s.onset(1000);
    expect(s.tokens(1600, false)).toBe(600);
    expect(s.samples).toEqual([600]);
    // no pending → no sample
    expect(s.tokens(1700, false)).toBeNull();
  });

  it('a later onset replaces the pending one', () => {
    const s = new LagSampler();
    s.onset(1000);
    s.onset(2000);
    expect(s.tokens(2500, false)).toBe(500);
  });

  it('re-emission batches never close samples', () => {
    const s = new LagSampler();
    s.onset(1000);
    expect(s.tokens(1500, true)).toBeNull(); // batch — pending survives
    expect(s.tokens(1900, false)).toBe(900);
  });

  it('entering holding voids the pending onset', () => {
    const s = new LagSampler();
    s.onset(1000);
    s.hold();
    expect(s.tokens(1500, false)).toBeNull();
    expect(s.voidedByHold).toBe(1);
  });

  it('pairs over 3000ms are counted invalid and excluded', () => {
    const s = new LagSampler();
    s.onset(1000);
    expect(s.tokens(11189 + 1000, false)).toBeNull(); // the PT stale pair
    expect(s.samples).toEqual([]);
    expect(s.invalid).toBe(1);
  });
});

/* Replay the B.3.3 tapes' onset/token streams through the REAL
   sampler: the acceptance gate is n≥8 valid emissionLag samples per
   60s read. The old logic produced n=1 on both tapes. */
function simulate(log: SessionLog): LagSampler {
  const s = new LagSampler();
  const events = log.events;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind === 'mic' && e.status === 'voice-onset') s.onset(e.t);
    else if (e.kind === 'mic' && e.status === 'restarting') s.restart();
    else if (e.kind === 'state' && e.state === 'holding') s.hold();
    else if (e.kind === 'token') {
      // one consume() per run of consecutive token events sharing an
      // arrival time — a run of ≥4 is a re-emission batch
      let j = i;
      while (j + 1 < events.length && events[j + 1].kind === 'token' &&
             events[j + 1].t === e.t) j++;
      s.tokens(e.t, j - i + 1 >= 4);
      i = j;
    }
  }
  return s;
}

describe.each([
  ['en-b33', enB33 as unknown as SessionLog],
  ['pt-b33', ptB33 as unknown as SessionLog],
])('B.3.3 tape %s through the new sampler', (name, log) => {
  it('yields ≥8 valid emission-lag samples (was n=1)', () => {
    const s = simulate(log);
    console.log(
      `${name}: n=${s.samples.length} median=${median(s.samples)}ms ` +
      `p90=${p90(s.samples)}ms voidedByHold=${s.voidedByHold} invalid=${s.invalid}`,
    );
    expect(s.samples.length).toBeGreaterThanOrEqual(8);
    // every sample is a plausible engine latency, not a pause
    for (const ms of s.samples) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(3000);
    }
  });
});
