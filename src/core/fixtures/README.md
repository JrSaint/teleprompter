# Rig-session fixtures

Real "⧉ Copy log" exports from the iPad rig. Drop each session's JSON
into this directory as `<short-name>.json` — `replay.test.ts` picks up
every `*.json` here automatically and asserts the regression contract:

- every advance/jump carries evidence ≥ 1 (no zero-evidence moves)
- the session replays to `finished`

Add fixture-specific assertions (stall windows, skip behavior) in
`replay.test.ts` next to the generic block.

Known annotation — first pt-BR rig tape (2026-07-30): the ad-lib-window
advance at t≈52489 was RULE-CORRECT, not a bug: the v1 seeded script
told the reader to improvise about "o tempo" while itself containing
"como o tempo por uns oito segundos". The v2 seeds change the suggested
topic to "comida" (zero lexical overlap).

Known annotation — B.3 tapes (rigtest-en-b3 / rigtest-pt-b3,
2026-07-31): recorded on the close-out build — replay reproduces the
recorded decision stream move-for-move. They carry the phrases list
but NO speechToSwapMs/summary despite that wiring being live: the
device recognizer returned zeroed segment timings for every partial —
the finding that drove the B.3 emission-lag fallback (VAD voice-onset
correlation). Unmatched ad-lib stretches (EN t=107781–109184) logged
no decisions on this build; B.3 logs a hold for every batch.

Known annotation — B.2 close-out tapes (rigtest-en-native /
rigtest-pt-native, 2026-07-31): first working on-device recognizer
sessions (iPad12,1, per-word streaming). The EN tape recorded the
"the end" incident: the recognizer never emitted "end", and the spoken
"and" both exact-matched its own phrase AND fuzzy-banked the later
"end" (lev 1), teleporting the display via far-skip at t=76868. Fixed
by ambiguous-credit blocking + the tail-rescue mercy rule; the
recorded decision stream therefore shows the OLD (buggy) moves —
replay of the same tokens produces the corrected sequence the
regression tests pin. These tapes predate the phrase-list,
speechToSwapMs, and summary log fields, and contain unsplit
multi-word token strings ("test read") — replayed as recorded.

## B.3.3 re-baseline (2026-07-31)

Every fixture now carries a `phrases` header — the segmentation the
session actually displayed. Tapes cut before B.3 lacked one, so it was
backfilled from the v1 chunker (verbatim `events` untouched); replay
uses the recorded list (`phraseFromText`), never fresh segmentation,
so fixtures stay pinned to their own reality as the segmenter evolves.
New tapes: `rigtest-en-b33-2026-07-31.json` / `rigtest-pt-b33-2026-07-31.json`
(VAD onsets + summary events; the metric-sampler acceptance replays
them in `latency.test.ts`).
