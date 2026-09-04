# Blackjack Trainer

A single-file blackjack trainer: basic-strategy feedback, Hi-Lo card-counting
practice, regional rule presets, a house-odds view, and a fully synthesized
premium sound system. Simulated chips only — no real-money gambling.

Installable as a PWA — add it to your home screen or desktop and it works offline.
Deployed to Cloudflare Workers as a static-assets site.

## Run it locally

With Wrangler (matches how Cloudflare serves it):

    npm install
    npm run dev

Or with any static file server (the service worker needs `http://` or
`https://`, not `file://`):

    python3 -m http.server 8000 --directory public

To install: open the site in a browser, then use the browser's "Install app" /
"Add to Home Screen" option (address-bar icon on desktop Chrome/Edge, share
sheet on iOS Safari, menu on Android Chrome).

## Deploy to Cloudflare

The app is 100% client-side, so it deploys as a **static-assets Worker** — there
is no server code, no database, and no bindings to configure.

Manual deploy:

    npx wrangler login
    npm run deploy

Deploy from GitHub (Workers Builds): in the Cloudflare dashboard go to
**Workers & Pages → Create → Import a repository**, pick this repo and branch, then set

| Setting          | Value            |
| ---------------- | ---------------- |
| Build command    | *(leave empty)*  |
| Deploy command   | `npx wrangler deploy` |

No environment variables or secrets are required.

## Layout
- `public/` — everything served to the browser (this is the assets directory)
  - `index.html` — the whole app (HTML/CSS/JS, no build step, no dependencies)
  - `bj-audio.js` — the table sound-design module (also inlined in index.html)
  - `sound-assets/` — 44 rendered `.wav` sounds (48kHz/24-bit stereo)
  - `manifest.webmanifest` — PWA manifest (name, icons, theme, start URL)
  - `sw.js` — service worker; caches the app shell and sounds for offline play
  - `icons/` — app icons (192/512/512-maskable/180-apple-touch/32-favicon)
  - `_headers` — keeps `sw.js` revalidating so updates reach installed users
- `wrangler.jsonc` — Cloudflare config (assets directory, no Worker script)

## Data storage

Nothing is stored server-side. The app keeps three values in the browser's
`localStorage`, per device:

- audio preferences (sfx/music toggles and volumes)
- `bjt_highscores` — local high score list
- `ccg_age_ok` — age-gate acknowledgement

This needs no D1 or KV. Adding cross-device sync would require accounts plus a
Worker API, which is out of scope for the current app.

## Updating the app

After changing anything in `public/`, bump `CACHE_VERSION` at the top of
`public/sw.js` (e.g. `bj-trainer-v2` → `v3`). Otherwise installed copies keep
serving the previously cached files.

## Sound assets
Every sound is generated in the browser. Regenerate/download the asset pack
from the console: `BJAudio.exportAll()`
