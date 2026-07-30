import type { SessionLog } from './recorder';
import { segmentScript } from './segmenter';
import { parseAliases } from './aliases';
import { PhraseMatcher, type MatcherConfig, type MatchEvent } from './matcher';

/**
 * Replays a recorded session's token stream through the matcher (with
 * any candidate config) and reports what the display would have done.
 * Real rig logs become regression fixtures: tune constants until the
 * recorded incidents resolve, then lock the fixture in a test.
 */

const GRACE_MS = 2000;

export interface ReplayResult {
  /** every advance/jump with the rule that fired and the time it fired */
  moves: Array<MatchEvent & { t: number }>;
  /** phrase index path the display took */
  path: number[];
  finalIndex: number;
  finished: boolean;
  phraseCount: number;
}

export function replaySession(
  log: SessionLog,
  cfg: Partial<MatcherConfig> = {},
): ReplayResult {
  const phrases = segmentScript(log.script.body, log.script.lang);
  // the script's own aliases apply unless the caller overrides them
  const m = new PhraseMatcher(phrases, {
    aliases: parseAliases(log.script.aliases),
    ...cfg,
  });
  const moves: ReplayResult['moves'] = [];
  const path: number[] = [0];

  // Reconstruct the post-restart grace window from mic transitions:
  // 'restarting' followed by 'listening' opens GRACE_MS of grace.
  let restarting = false;
  let graceUntil = -1;

  for (const e of log.events) {
    if (e.kind === 'mic') {
      if (e.status === 'restarting') restarting = true;
      else if (e.status === 'listening' && restarting) {
        restarting = false;
        graceUntil = e.t + GRACE_MS;
      }
      continue;
    }
    if (e.kind !== 'token') continue;
    const res = m.feed([e.word], { grace: e.t <= graceUntil });
    for (const ev of res.events) {
      moves.push({ ...ev, t: e.t });
      path.push(ev.to);
    }
  }

  return {
    moves,
    path,
    finalIndex: m.current,
    finished: m.finished,
    phraseCount: phrases.length,
  };
}

/* ---- de-clump mode ---------------------------------------------------
   Safari releases recognition in delayed clumps. To measure how much of
   the perceived lag is Safari (not us), rewrite token timestamps as if
   each clump's words had arrived spread evenly since the previous
   token, then compare when each advance fires. This is measurement
   only — we do not tune the matcher to chase Safari's clump latency. */

/** Tokens closer together than this are one clump. */
const CLUMP_EPS_MS = 150;
/** Assumed inter-word spacing when a clump opens the session. */
const LEAD_SPACING_MS = 250;

export function declumpLog(log: SessionLog, epsMs = CLUMP_EPS_MS): SessionLog {
  const events = log.events.map((e) => ({ ...e }));
  const toks = events.filter((e) => e.kind === 'token');
  let i = 0;
  while (i < toks.length) {
    let j = i;
    while (j + 1 < toks.length && toks[j + 1].t - toks[j].t <= epsMs) j++;
    if (j > i) {
      const start =
        i === 0
          ? Math.max(0, toks[i].t - (j - i) * LEAD_SPACING_MS)
          : toks[i - 1].t;
      const end = toks[j].t;
      const n = j - i + 1;
      for (let k = 0; k < n; k++) {
        toks[i + k].t = Math.round(start + ((k + 1) / n) * (end - start));
      }
    }
    i = j + 1;
  }
  events.sort((a, b) => a.t - b.t);
  return { ...log, events };
}

export interface ClumpLagReport {
  /** per matched advance: clumped fire time minus de-clumped fire time */
  deltasMs: number[];
  medianDeltaMs: number;
  clumpedMoves: number;
  declumpedMoves: number;
}

export function compareClumpLag(
  log: SessionLog,
  cfg: Partial<MatcherConfig> = {},
): ClumpLagReport {
  const clumped = replaySession(log, cfg);
  const declumped = replaySession(declumpLog(log), cfg);
  const used = new Set<number>();
  const deltasMs: number[] = [];
  for (const a of clumped.moves) {
    const bIdx = declumped.moves.findIndex(
      (b, idx) => !used.has(idx) && b.to === a.to && b.type === a.type,
    );
    if (bIdx >= 0) {
      used.add(bIdx);
      deltasMs.push(a.t - declumped.moves[bIdx].t);
    }
  }
  const sorted = [...deltasMs].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  const medianDeltaMs =
    sorted.length === 0
      ? 0
      : sorted.length % 2
        ? sorted[mid]
        : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return {
    deltasMs,
    medianDeltaMs,
    clumpedMoves: clumped.moves.length,
    declumpedMoves: declumped.moves.length,
  };
}
