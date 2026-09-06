# Blackjack Trainer

A single-file blackjack trainer: basic-strategy feedback, Hi-Lo card-counting
practice, regional rule presets, a house-odds view, and a fully synthesized
premium sound system. Simulated chips only — no real-money gambling.

## Run it
Open `index.html` in any browser, or serve the folder:

    python3 -m http.server 8000

then visit http://localhost:8000

## Contents
- `index.html` — the whole app (HTML/CSS/JS, no build step, no dependencies)
- `bj-audio.js` — the table sound-design module (also inlined in index.html)
- `sound-assets/` — 44 rendered `.wav` sounds (48kHz/24-bit stereo)

## Sound assets
Every sound is generated in the browser. Regenerate/download the asset pack
from the console: `BJAudio.exportAll()`
