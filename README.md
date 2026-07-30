# Voice Prompter

A voice-following teleprompter for an iPad in a beam-splitter rig (Glide
Gear TMP 100). It never scrolls and never sets the pace: one phrase is
shown large and centered (next phrase dimmed below), and the display
advances phrase by phrase because the speaker said the words. Silence or
ad-libbing holds; skipping ahead is detected and followed. English
(en-US) and Brazilian Portuguese (pt-BR), all processing on-device.

## Stack

TypeScript + Vite, no UI framework. Vitest for the core unit tests.
IndexedDB (localForage) for scripts/settings. PWA with offline shell and
Screen Wake Lock. Phase B adds a Capacitor iOS shell with a native
on-device speech plugin.

## Develop

```bash
npm install
npm run dev          # http, fine for Mac-side work (no mic on http)
npm run dev:https    # LAN https via mkcert — needed for Safari mic access
npm test             # segmenter + matcher unit tests
npm run build        # type-check + production build to dist/
```

`dev:https` uses mkcert, which installs a local CA (one-time sudo prompt —
run it from a real terminal). The iPad must trust that CA to open the LAN
URL; if that's a fight, deploy the branch and test over the Pages URL.

## Structure

- `src/core/segmenter.ts` — script → 2–5-word phrases (punctuation, `/`
  markers, EN/PT conjunction breaks; never a 1-word orphan)
- `src/core/matcher.ts` — pure alignment engine: fuzzy Levenshtein match,
  advance at final content word or ≥70% coverage, skip-ahead over the
  next 3 phrases, never auto-backward
- `src/core/speech/` — `SpeechSource` interface; `WebSpeechSource`
  (auto-restarting Web Speech) now, native Capacitor plugin in Phase B
- `src/core/flow.ts` — idle → armed → following → holding → finished
- `src/core/diag.ts` — restart gaps + advance latency, rendered by the
  prompter's on-screen overlay (toggle with D — consoles don't exist on
  an iPad in a rig)
- `src/ui/` — SetupView (scripts, language, distance/mirror settings,
  rig checklist), PrompterView (the rig display), CalibrationView (mic
  check + mirrored "R")

## Controls (Bluetooth clickers present as keyboards)

Space start/pause · → / PageDown next · ← / PageUp previous · R restart ·
D diagnostics · Esc exit

## Script markup

`/` forces a phrase break. `{yellow:words}` colors words (any of yellow,
orange, red, green, blue, purple, or `{#hex:…}`); the same `{tag:…}`
mechanism will carry future semantic tags. Matching ignores all markup.
