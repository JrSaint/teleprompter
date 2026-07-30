# Teleprompter

A web-based teleprompter designed for iPad, controllable with Bluetooth remotes,
pedals, and clickers. No accounts, no server — scripts are stored on the device.

## Features

- **Script library** — create, edit, import `.txt` / `.md` files; autosaved locally
- **Smooth auto-scroll** with adjustable speed (works while paused too: jump back/forward, restart)
- **Word-by-word highlight** — the current word lights up at the reading line as the text scrolls
- **Mirror mode** — flip the image horizontally (and/or vertically) for beam-splitter teleprompter glass
- **Reading guide**, progress bar, estimated time remaining, 3-second countdown
- Adjustable **font size, line height, side margins, text color, ALL CAPS**
- **Screen wake lock** so the iPad doesn't sleep mid-read
- **PWA** — add to Home Screen for a fullscreen app experience

## Bluetooth remote control

iPad Safari has no Web Bluetooth, but that doesn't matter: Bluetooth page-turner
pedals (AirTurn, PageFlip, Donner…), presentation clickers, and mini keyboards all
pair with the iPad as a **keyboard** and send key presses, which the app listens for.

1. Pair the remote in **iPad Settings › Bluetooth** (it appears as a keyboard).
2. Open the app. Default mappings:
   - `Space` / `Enter` — play / pause
   - `↓` / `PageDown` — faster `↑` / `PageUp` — slower
   - `←` — jump back `→` — jump forward
   - `Home` — restart `Esc` — exit
3. If your remote sends something else: **Settings › Bluetooth Remote**, press a
   button on the remote to see what it sends, then tap **＋ map key** next to any
   action and press the button.

> Note: cheap "camera shutter" BT buttons send *volume* keys on iOS, which Safari
> doesn't expose to web pages — page-turner pedals and clickers are the reliable
> choice.

## Running it

Any static file server works. For example:

```bash
python3 -m http.server 8123
```

Then on the iPad (same Wi-Fi network) open `http://<your-mac-ip>:8123`.

For the full experience (Home Screen install, offline cache, wake lock), serve it
over **HTTPS** — e.g. deploy the folder to any static host (Vercel, Netlify,
Cloudflare Pages) and open that URL on the iPad, then **Share › Add to Home Screen**.

## Files

- `index.html` / `style.css` / `app.js` — the whole app (no build step, no dependencies)
- `manifest.webmanifest`, `sw.js`, `icon-*.png` — PWA install + offline support
