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
