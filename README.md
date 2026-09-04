# Blackjack Trainer

A single-file blackjack trainer: basic-strategy feedback, Hi-Lo card-counting
practice, regional rule presets, a house-odds view, and a fully synthesized
premium sound system. Simulated chips only — no real-money gambling.

Installable as a PWA — add it to your home screen or desktop and it works offline.

## Run it
Serve the folder over HTTP (the service worker needs `http://` or `https://`,
not `file://`):

    python3 -m http.server 8000

then visit http://localhost:8000

To install: open the site in a browser, then use the browser's "Install app" /
"Add to Home Screen" option (address-bar icon on desktop Chrome/Edge, share
sheet on iOS Safari, menu on Android Chrome).

## Contents
- `index.html` — the whole app (HTML/CSS/JS, no build step, no dependencies)
- `bj-audio.js` — the table sound-design module (also inlined in index.html)
- `sound-assets/` — 44 rendered `.wav` sounds (48kHz/24-bit stereo)
- `manifest.webmanifest` — PWA manifest (name, icons, theme, start URL)
- `sw.js` — service worker; caches the app shell and sounds for offline play
- `icons/` — app icons (192/512/512-maskable/180-apple-touch/32-favicon)

## Sound assets
Every sound is generated in the browser. Regenerate/download the asset pack
from the console: `BJAudio.exportAll()`
