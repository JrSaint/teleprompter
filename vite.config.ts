import { defineConfig } from 'vite';
import mkcert from 'vite-plugin-mkcert';

// HTTPS is opt-in (npm run dev:https) because Safari only exposes the
// microphone / SpeechRecognition in secure contexts. mkcert installs a
// local CA into the macOS trust store, which prompts for sudo — run the
// https script once from a real terminal to approve it. The iPad must
// also trust the mkcert root CA to use the LAN URL; if that's a fight,
// test on the iPad via the Pages deploy of the last merged build.
export default defineConfig({
  base: './',
  plugins: process.env.VP_HTTPS ? [mkcert()] : [],
  server: {
    host: true,
  },
  build: {
    target: 'es2020',
  },
});
