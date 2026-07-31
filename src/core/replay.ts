import type { SessionLog } from './recorder';
import { segmentScript } from './segmenter';
import { parseAliases } from './aliases';
import { PhraseMatcher, type MatcherConfig, type MatchEvent } from './matcher';
import { FlowModel, FLOW_HOLD_MS } from './flowpredict';

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
  opts: { flowPredict?: boolean } = {},
): ReplayResult {
  const phrases = segmentScript(log.script.body, log.script.lang);
  // the session's own aliases and swap timing apply unless overridden
  // (flow = lead evidence rules + simulated predictive swaps)
  const m = new PhraseMatcher(phrases, {
    aliases: parseAliases(log.script.aliases),
    ...(log.swapTiming ? { leadMode: log.swapTiming !== 'confirm' } : {}),
    ...cfg,
  });
  const flowOn = opts.flowPredict ?? log.swapTiming === 'flow';
  const moves: ReplayResult['moves'] = [];
  const path: number[] = [0];

  // Reconstruct the post-restart grace window from mic transitions:
  // 'restarting' followed by 'listening' opens GRACE_MS of grace.
  let restarting = false;
  let graceUntil = -1;

  // Flow simulation state — mirrors the controller's rails exactly:
  // rate model from confirmed content tokens, holding reconstructed
  // from match times (a tape recorded in another mode has no flow
  // state events), chain rail via the evidenced frontier, mic gate
  // and timer lifetime from the recorded mic transitions (live fires
  // only while listening, and stop/restart clears the pending timer).
  const model = new FlowModel();
  let lastMatchedT: number | null = null;
  let evidencedAt = 0;
  let micListening = true; // tapes without mic events stay permissive
  let timerArmed = false;  // live arms the timer on each consume

  const tryFlowPredict = (beforeT: number): void => {
    if (!flowOn || m.finished || m.current !== evidencedAt) return;
    if (!micListening || !timerArmed) return;
    if (!m.touched) return; // banked credit alone is not the speaker
    if (lastMatchedT === null) return; // armed — nothing heard yet
    const ph = phrases[m.current];
    const total = ph?.contentIdx.length ?? 0;
    if (total === 0) return;
    const hits = m.contentMatchedCount(m.current);
    const w = model.window(total - hits, hits / total);
    if (!w || w.fireAt >= beforeT || w.fireAt > w.deadline) return;
    // suppressed while holding: no matched token in the silence window
    if (w.fireAt - lastMatchedT > FLOW_HOLD_MS) return;
    const e = m.flowAdvance();
    if (e) {
      moves.push({ ...e, t: Math.round(w.fireAt) });
      path.push(e.to);
    }
  };

  for (const e of log.events) {
    if (e.kind === 'mic') {
      if (e.status === 'restarting') restarting = true;
      else if (e.status === 'listening' && restarting) {
        restarting = false;
        graceUntil = e.t + GRACE_MS;
      }
      // mic-state transitions gate Flow; side-channel statuses
      // (env/level/voice-onset/starting) are not state changes
      if (e.status === 'listening') micListening = true;
      else if (['restarting', 'stopped', 'denied', 'unavailable'].includes(e.status)) {
        micListening = false;
        timerArmed = false; // live clears the pending timer here
      }
      continue;
    }
    if (e.kind !== 'token') continue;
    tryFlowPredict(e.t);
    const res = m.feed([e.word], { grace: e.t <= graceUntil });
    if (flowOn) {
      timerArmed = true; // consume() reschedules the live timer
      for (let i = 0; i < res.contentHits; i++) model.noteContent(e.t);
      if (res.matchedAny) {
        lastMatchedT = e.t;
        if (res.lastWordMatched) model.noteMatched();
      }
      if (!res.lastWordMatched) model.noteUnmatched();
    }
    for (const ev of res.events) {
      moves.push({ ...ev, t: e.t });
      path.push(ev.to);
      evidencedAt = ev.to; // rule-based move — the frontier advances
    }
  }
  // Live's timer needs no further token to fire — evaluate the window
  // that matures after the tape's last token (a terminal mic event
  // has already disarmed it above).
  tryFlowPredict(Number.MAX_SAFE_INTEGER);

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
