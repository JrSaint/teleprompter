# Voice Prompter

Voice-following teleprompter for an 11" iPad in a beam-splitter rig
(Glide Gear TMP 100). Static phrase-swap display driven by on-device
speech recognition. Vite + TypeScript, no UI framework; Capacitor iOS
shell with a custom Swift NativeSpeech plugin. Tests: `npx vitest run`.

## Design laws (locked — do not revisit)

- **Light moves, text doesn't.** No feature may animate text position
  on the prompter screen. Text sits in fixed slots (karaoke: 2,
  ladder: 3) and the line being read brightens IN PLACE; the only
  permitted transition is brightness (opacity), e.g. the swap
  crossfade (`SWAP_FADE_MS` in `src/ui/PrompterView.ts`). Never
  scroll, slide, or zoom prompter text.
- The display advances only because words were spoken; silence and
  ad-lib hold; never auto-backward.
- All speech processing on-device — no cloud speech APIs, ever.
- Prompter typography: current and next line at the SAME
  distance-derived size, one block, emphasis by brightness only;
  never wrap mid-phrase (per-script width-fit cap).

## Working agreement

- Work in sprints from the founder's briefs; verify tape findings
  against source before fixing; stop at declared stop points.
- Real rig session logs become fixtures in `src/core/fixtures/` and
  replay in the suite. Diagnostics must be on-screen (D overlay) —
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
- **NativeSpeechPlugin sync consolidation** (B.3.3 review debt): the
  plugin has three synchronization domains (stateQueue, meterLock,
  unsynchronized session objects across four threads). Fold
  request/task/recognizer/failure state into one serial authority.
- Locked-lines verified verbatim via the generic `{tag:text}` markup.
