# Blackjack Trainer

A blackjack trainer: basic-strategy feedback, Hi-Lo card-counting practice,
regional rule presets, a house-odds view, and a fully synthesized premium sound
system. Simulated chips only — no real-money gambling.

Installable as a PWA, works offline, and — once you sign in — syncs your
preferences and high scores across every device.

## Architecture

```
Browser / PWA  ──►  Worker API (/api/*)  ──►  D1
   localStorage       session cookie          user-scoped tables
   (offline cache)    → user_id
```

Static files in `public/` are served by Cloudflare's asset layer. Anything that
isn't a static asset falls through to `src/index.js`, which owns `/api/*`.

**Signed out, nothing changes:** the game runs entirely on `localStorage` with no
network calls, exactly as it always has. Signing in makes D1 the source of truth
and demotes `localStorage` to an offline cache.

## Accounts

| Method | Notes |
| ------ | ----- |
| Continue with Google | Primary. OAuth 2.0 / OIDC with PKCE. |
| Email one-time code  | Fallback. 6-digit code, 10-minute expiry, 5 attempts. |

**No passwords are stored, ever.** Google is the identity provider for the
primary path; the email path proves control of an address by delivering a code
to it. Both resolve to a stable `user_id` (`usr_<random>`), and the `identities`
table lets one person use both methods and land on the same account.

Sessions are opaque 256-bit random tokens in an `HttpOnly`, `SameSite=Lax`,
`Secure` (on HTTPS) cookie. Only the SHA-256 hash of a token is stored, so a
database leak yields no usable cookies.

## Data model

All user-owned tables carry `user_id` and cascade on user deletion:

```
users ──┬── identities        (provider + subject → user_id)
        ├── sessions          (token_hash → user_id)
        ├── user_preferences  (1 row/user, JSON, last-write-wins)
        └── high_scores       (N rows/user, union-merged)
```

Migrations live in `migrations/`. See `migrations/0001_initial_schema.sql`.

Two things stay device-local by design:

- **`ccg_age_ok`** — the age-gate acknowledgement. Syncing it would auto-dismiss
  a legal gate on a device where nobody had answered it.
- **In-progress hands** — the current shoe/bankroll is session state, not saved
  progress; the game already discards it on reload.

## Authorization

Every endpoint under `/api` that touches user data:

1. Reads the session cookie and resolves `user_id` **server-side**.
2. Returns `401` if there is no valid, unexpired session.
3. Filters every query with `WHERE user_id = ?` using that value.

A `user_id` sent by the browser is **ignored**. There is no code path where a
request body or query parameter can select which account is read or written.
Cross-site requests are additionally rejected by an `Origin` check.

## Cross-device sync

`localStorage` stays the game's working store, so the app is instant and works
offline. `public/sync.js` mirrors it to the API:

- **Push** — writes to the two synced keys are intercepted and pushed (debounced
  1.2s). Failures stay queued and retry on the next load or `online` event.
- **Pull** — on load, the queue is flushed first, then server state is merged in.
- **Conflicts** — preferences are last-write-wins. High scores are **union-merged**
  and de-duplicated: two devices that each recorded a session offline both keep
  their entries, which plain last-write-wins would lose.
- **Account switching** — the cache records which `user_id` it belongs to. Signing
  in as someone else, or signing out, clears it first, so one person's scores are
  never merged into another's on a shared device.

The service worker never caches `/api/*`, so per-user responses can't leak
between accounts on the same device.

---

## Setup you need to perform

### 1. Create the D1 database

```bash
npx wrangler d1 create blackjack-trainer
```

Copy the printed `database_id` into `wrangler.jsonc`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`. Then apply the schema:

```bash
npx wrangler d1 migrations apply blackjack-trainer --local   # local dev
npx wrangler d1 migrations apply blackjack-trainer --remote  # production
```

### 2. Configure Google sign-in

In the [Google Cloud console](https://console.cloud.google.com/apis/credentials):

1. **Create credentials → OAuth client ID → Web application**.
2. Add an **Authorized redirect URI** for each origin you deploy to:
   - `https://<your-worker>.workers.dev/api/auth/google/callback`
   - `http://localhost:8787/api/auth/google/callback` (local dev)
3. Configure the OAuth consent screen (External) with the `email`, `profile` and
   `openid` scopes.

Then store the credentials as secrets — never in `wrangler.jsonc`:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

### 3. Configure email codes (optional fallback)

Create an API key at [resend.com](https://resend.com) (free tier is sufficient),
verify your sending domain, then:

```bash
npx wrangler secret put RESEND_API_KEY
```

Set `MAIL_FROM` in `wrangler.jsonc` to a verified sender address.

If these are unset the email option simply doesn't appear in the sign-in dialog;
Google-only is a valid configuration.

### Bindings and variables reference

| Name | Kind | Required | Purpose |
| ---- | ---- | -------- | ------- |
| `DB` | D1 binding | yes | User data |
| `ASSETS` | Assets binding | yes | Serves `public/` |
| `GOOGLE_CLIENT_ID` | secret | for Google | OAuth client id |
| `GOOGLE_CLIENT_SECRET` | secret | for Google | OAuth client secret |
| `RESEND_API_KEY` | secret | for email | Sends one-time codes |
| `MAIL_FROM` | var | for email | Verified sender address |

For local development put secrets in `.dev.vars` (already gitignored):

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

---

## Run it locally

```bash
npm install
npx wrangler d1 migrations apply blackjack-trainer --local
npm run dev
```

## Deploy

```bash
npx wrangler login
npx wrangler d1 migrations apply blackjack-trainer --remote
npm run deploy
```

Deploy from GitHub (Workers Builds): **Workers & Pages → Create → Import a
repository**, then set build command empty and deploy command
`npx wrangler deploy`. Set the secrets in the dashboard under
**Settings → Variables and Secrets**.

## Verifying user isolation

Seed two users with known session tokens against the local database, then confirm
neither can see the other's rows:

```bash
# hash a token the way the Worker does
node -e "console.log(require('crypto').createHash('sha256').update('TOKEN_ALICE').digest('hex'))"
```

Insert a `users` row and a `sessions` row for each token via
`npx wrangler d1 execute blackjack-trainer --local --command "..."`, then:

```bash
# Alice writes, and tries to claim she is Bob
curl -X PUT -H 'Cookie: bj_session=TOKEN_ALICE' -H 'Content-Type: application/json' \
  -d '{"user_id":"usr_bob","highscores":[{"date":"Sep 4","peak":2200,"region":"Vegas"}]}' \
  http://127.0.0.1:8787/api/state

# Bob sees only his own data — the spoofed user_id was ignored
curl -H 'Cookie: bj_session=TOKEN_BOB' http://127.0.0.1:8787/api/state

# No cookie is rejected outright
curl -i http://127.0.0.1:8787/api/state          # → 401
```

In a browser, sign in as one account in a normal window and another in a private
window; each should see only its own high scores.

## Layout
- `public/` — everything served to the browser (the assets directory)
  - `index.html` — the game (HTML/CSS/JS, no build step, no dependencies)
  - `sync.js` — account UI + cross-device sync (the game itself is untouched)
  - `bj-audio.js` — the table sound-design module
  - `sound-assets/` — 44 rendered `.wav` sounds (48kHz/24-bit stereo)
  - `manifest.webmanifest`, `sw.js`, `icons/`, `_headers` — PWA plumbing
- `src/index.js` — Worker API (auth + user-scoped data)
- `migrations/` — D1 schema migrations
- `wrangler.jsonc` — Cloudflare config

## Updating the app

After changing anything in `public/`, bump `CACHE_VERSION` at the top of
`public/sw.js`. Otherwise installed copies keep serving the previously cached
files.

## Sound assets
Every sound is generated in the browser. Regenerate/download the asset pack
from the console: `BJAudio.exportAll()`
