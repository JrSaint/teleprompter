import type { SessionLog } from './recorder';
import { segmentScript } from './segmenter';
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
  const m = new PhraseMatcher(phrases, cfg);
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
