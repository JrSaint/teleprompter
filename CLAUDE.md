# Voice Prompter

Voice-following teleprompter for an 11" iPad in a beam-splitter rig
(Glide Gear TMP 100). Static phrase-swap display driven by on-device
speech recognition. Vite + TypeScript, no UI framework; Capacitor iOS
shell with a custom Swift NativeSpeech plugin. Tests: `npx vitest run`.

## Design laws (locked — do not revisit)

- **Light moves, text doesn't.** No feature may animate text position
  on the prompter screen. Text sits in fixed slots (ladder: 3 —
  the default per the B.3.4 A/B verdict; karaoke: 2, settings
  option) and the line being read brightens IN PLACE; the only
  permitted transition is brightness (opacity), e.g. the swap
  crossfade (`SWAP_FADE_MS` in `src/ui/PrompterView.ts`). Never
  scroll, slide, or zoom prompter text.
- The display advances only because words were spoken; silence and
  ad-lib hold; never auto-backward. Swap timing is per-language
  (B.3.5 duel verdict: EN = Flow, PT = Lead until its engine is
  cured); Flow's rails log their suppression reasons (`flow-rail`
  events), and catch-up gulps of ≥2 advances render as ONE
  transition (`display-collapsed` events).
- All speech processing on-device — no cloud speech APIs, ever.
- Prompter typography: current and next line at the SAME
  distance-derived size, one block, emphasis by brightness only;
  never wrap mid-phrase (per-script width-fit cap).
- The validated reading surface — ladder slots, 100/60/35 tiers,
  crossfade + collapse behavior — is FROZEN; design polish touches
  chrome only. The diagnostics overlay ships hidden behind a
  developer setting, never user-visible by default.

## Ship gate (launch scope)

- PT ships WITH EN — same build, same day. PT engine ladder, in
  order: (a) lifecycle surgery (fresh task per watchdog, task age
  limit with proactive rotation, buffer continuity) — success bar:
  cold-start PT read of a real-length script, zero dropout windows
  >2s, zero abandonment, two consecutive sessions; (b) fallback:
  server-assisted pt-BR (`allowServer` plugin option →
  requiresOnDeviceRecognition=false, PT ONLY, dev flag
  `ptServerAssisted`, no UI) with scheduled task rotation (~50s
  server limit) + overlap so no words are lost, and per-language
  privacy copy (EN fully on-device; PT via Apple servers, network
  required). EN never leaves on-device — that design law stands.
  Spike truth (B.4 sim, 2026-07-31): allowServer is wired end-to-end
  (env logs `serverAssisted:true`, session reaches listening); the
  SIMULATOR cannot finish the job — SFSpeechRecognizer's server
  errors "Retry" (no Apple speech identity in sims) and
  supportedLocales() is EMPTY there, so ALL recognition validation
  is device-only. webkitSpeechRecognition inside the app's WKWebView
  is NOT a valid fallback and must never be assumed: it is
  present-but-MUTE — the API exists, reaches listening, and never
  delivers a result (verified in the B.4 sim pass; a presence check
  passes and still cannot prompt).
- Final PT acceptance requires an Erika session (second voice):
  real famous-minds script, her pace, in the rig. Fixture naming:
  `rigtest-pt-erika-<tag>-<date>.json` for rig probes,
  `take-<script-id>-<voice>-<n>-<date>.json` for real takes.

## Working agreement

- Work in sprints from the founder's briefs; verify tape findings
  against source before fixing; stop at declared stop points.
- Real rig session logs become fixtures in `src/core/fixtures/` and
  replay in the suite. Render truth (B.3.6): every prompter render
  logs `render` events (target + settled slot snapshots); the suite
  asserts the active phrase's slot is at the 100% tier on every tape
  that carries them. Diagnostics must be on-screen (D overlay) —
  no console on the rig iPad.
- Device truth: the only hardware is iPad12,1 — SFSpeechRecognizer is
  the product path; SpeechAnalyzer validates in the simulator only.
- After web changes: `npm run build && npx cap sync ios` before any
  Xcode build, or the app ships a stale bundle.

## Backlog

- **Word-sweep brightening** (B.3.2 item 2, deferred as not-cheap):
  within the (now built) karaoke display, brighten the line being
  read word-by-word as tokens confirm. Needs per-word matched-state
  surfaced from the matcher to the display plus a "Line vs Word"
  brightening setting. Revisit after the display + timing A/Bs.
- **Engine-surgery device validation** (supersedes the B.3.5 dropout
  hunt): the surgery is BUILT — matcher re-emission guard (jumps
  never launch on regurgitated evidence; replay feeds same-t token
  batches as one arrival), proactive task-age rotation (45s
  on-device / 40s server, 1s overlap, 2.5s retiring-results window,
  `rotating` events), fresh-task-per-watchdog, launch pre-warm +
  `warming` readiness gate, PT-server dev toggle in the D overlay.
  Next device tapes must show: rotation events at ~45s intervals,
  ZERO transcript regurgitations (the age hypothesis), zero false
  jumps, cold start <2s to listening. The simulator cannot host any
  of the recognition classes (B.2: instant task failure; B.4 spike:
  server tasks die 'Retry', supportedLocales empty).
- **NativeSpeechPlugin sync consolidation** (B.3.3 review debt): the
  plugin has three synchronization domains (stateQueue, meterLock,
  unsynchronized session objects across four threads). Fold
  request/task/recognizer/failure state into one serial authority.
- Locked-lines verified verbatim via the generic `{tag:text}` markup.
