/**
 * Blackjack Trainer — Worker API.
 *
 * Static assets are served by Cloudflare's asset layer; this Worker only owns
 * /api/*. Identity comes from Google OIDC (primary) or an emailed one-time code
 * (fallback). No passwords are stored.
 *
 * Security model:
 *  - The browser never sends a user_id. Every request's user is resolved from an
 *    HttpOnly session cookie, and every data query filters on that user_id.
 *  - Session cookies hold a random opaque token; only its SHA-256 hash is stored.
 */

const SESSION_COOKIE = 'bj_session';
const OAUTH_COOKIE = 'bj_oauth';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const OAUTH_TTL_SECONDS = 60 * 10;
const CODE_TTL_SECONDS = 60 * 10;
const MAX_CODE_ATTEMPTS = 5;
const MAX_HIGH_SCORES = 15;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const now = () => Math.floor(Date.now() / 1000);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(byteLength = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256b64url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64url(new Uint8Array(digest));
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function cookieHeader(name, value, { maxAge, secure }) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

const isHttps = (url) => url.protocol === 'https:';

/** Reject cross-site state-changing requests. The session cookie is SameSite=Lax,
 *  so this is defence in depth rather than the only guard. */
function originAllowed(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // same-origin navigations often omit Origin
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const text = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return JSON.parse(decodeURIComponent(escape(text)));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

async function createSession(env, userId) {
  const token = randomToken();
  const tokenHash = await sha256hex(token);
  const ts = now();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  )
    .bind(tokenHash, userId, ts, ts + SESSION_TTL_SECONDS)
    .run();
  return token;
}

/** Resolves the authenticated user from the session cookie. Returns null when
 *  unauthenticated or expired. This is the ONLY source of user identity. */
async function getSessionUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.picture, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  )
    .bind(tokenHash)
    .first();
  if (!row) return null;
  if (row.expires_at <= now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, picture: row.picture };
}

// ---------------------------------------------------------------------------
// User + identity linking
// ---------------------------------------------------------------------------

async function findOrCreateUser(env, { provider, subject, email, name, picture, emailVerified }) {
  const ts = now();
  const normalisedEmail = email ? email.trim().toLowerCase() : null;

  const existing = await env.DB.prepare(
    'SELECT user_id FROM identities WHERE provider = ? AND subject = ?'
  )
    .bind(provider, subject)
    .first();
  if (existing) return existing.user_id;

  // Link to an existing account by email only when the provider vouched for it,
  // otherwise an unverified address could take over someone else's account.
  let userId = null;
  if (normalisedEmail && emailVerified) {
    const byEmail = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind(normalisedEmail)
      .first();
    if (byEmail) userId = byEmail.id;
  }

  if (!userId) {
    userId = 'usr_' + randomToken(16);
    await env.DB.prepare(
      'INSERT INTO users (id, email, name, picture, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(userId, normalisedEmail, name || null, picture || null, ts, ts)
      .run();
  }

  await env.DB.prepare(
    'INSERT OR IGNORE INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(provider, subject, userId, ts)
    .run();

  return userId;
}

// ---------------------------------------------------------------------------
// Google OIDC
// ---------------------------------------------------------------------------

async function googleStart(request, env, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return json({ error: 'google_not_configured', message: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.' }, 503);
  }
  const state = randomToken(16);
  const verifier = randomToken(32);
  const challenge = await sha256b64url(verifier);
  const redirectUri = `${url.origin}/api/auth/google/callback`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('prompt', 'select_account');

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      'Set-Cookie': cookieHeader(OAUTH_COOKIE, JSON.stringify({ state, verifier }), {
        maxAge: OAUTH_TTL_SECONDS,
        secure: isHttps(url),
      }),
      'Cache-Control': 'no-store',
    },
  });
}

async function googleCallback(request, env, url) {
  const fail = (reason) =>
    new Response(null, { status: 302, headers: { Location: `/?auth_error=${encodeURIComponent(reason)}` } });

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return fail('google_not_configured');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const raw = getCookie(request, OAUTH_COOKIE);
  if (!code || !state || !raw) return fail('missing_state');

  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    return fail('bad_state');
  }
  if (stored.state !== state) return fail('state_mismatch');

  const redirectUri = `${url.origin}/api/auth/google/callback`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: stored.verifier,
    }),
  });
  if (!tokenRes.ok) return fail('token_exchange_failed');

  const tokens = await tokenRes.json();
  if (!tokens.id_token) return fail('no_id_token');

  // The id_token arrived directly from Google's token endpoint over TLS,
  // authenticated with our client secret, so we validate claims rather than
  // re-verifying the signature against JWKS.
  let claims;
  try {
    claims = decodeJwtPayload(tokens.id_token);
  } catch {
    return fail('bad_id_token');
  }
  const issuers = ['https://accounts.google.com', 'accounts.google.com'];
  if (claims.aud !== env.GOOGLE_CLIENT_ID) return fail('aud_mismatch');
  if (!issuers.includes(claims.iss)) return fail('iss_mismatch');
  if (typeof claims.exp === 'number' && claims.exp < now()) return fail('id_token_expired');
  if (!claims.sub) return fail('no_subject');

  const userId = await findOrCreateUser(env, {
    provider: 'google',
    subject: claims.sub,
    email: claims.email,
    name: claims.name,
    picture: claims.picture,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
  });

  const token = await createSession(env, userId);
  const headers = new Headers({ Location: '/?signed_in=1', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookieHeader(SESSION_COOKIE, token, { maxAge: SESSION_TTL_SECONDS, secure: isHttps(url) }));
  headers.append('Set-Cookie', cookieHeader(OAUTH_COOKIE, '', { maxAge: 0, secure: isHttps(url) }));
  return new Response(null, { status: 302, headers });
}

// ---------------------------------------------------------------------------
// Email one-time code
// ---------------------------------------------------------------------------

function validEmail(email) {
  return typeof email === 'string' && /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email) && email.length <= 254;
}

async function emailStart(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const email = (body.email || '').trim().toLowerCase();
  if (!validEmail(email)) return json({ error: 'invalid_email' }, 400);

  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    return json(
      { error: 'email_not_configured', message: 'RESEND_API_KEY secret and MAIL_FROM var are required for email sign-in.' },
      503
    );
  }

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO email_codes (email, code_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash,
                                      expires_at = excluded.expires_at,
                                      attempts = 0,
                                      created_at = excluded.created_at`
  )
    .bind(email, await sha256hex(code), ts + CODE_TTL_SECONDS, ts)
    .run();

  const sent = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [email],
      subject: `${code} is your Blackjack Trainer sign-in code`,
      text: `Your sign-in code is ${code}\n\nIt expires in 10 minutes. If you didn't request it, you can ignore this email.`,
    }),
  });
  if (!sent.ok) return json({ error: 'send_failed' }, 502);

  return json({ ok: true });
}

async function emailVerify(request, env, url) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const email = (body.email || '').trim().toLowerCase();
  const code = (body.code || '').trim();
  if (!validEmail(email) || !/^\d{6}$/.test(code)) return json({ error: 'invalid_input' }, 400);

  const row = await env.DB.prepare('SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ?')
    .bind(email)
    .first();
  if (!row) return json({ error: 'no_code' }, 400);
  if (row.expires_at <= now()) {
    await env.DB.prepare('DELETE FROM email_codes WHERE email = ?').bind(email).run();
    return json({ error: 'code_expired' }, 400);
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    await env.DB.prepare('DELETE FROM email_codes WHERE email = ?').bind(email).run();
    return json({ error: 'too_many_attempts' }, 429);
  }
  if ((await sha256hex(code)) !== row.code_hash) {
    await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
    return json({ error: 'bad_code' }, 400);
  }

  await env.DB.prepare('DELETE FROM email_codes WHERE email = ?').bind(email).run();

  const userId = await findOrCreateUser(env, {
    provider: 'email',
    subject: email,
    email,
    name: null,
    picture: null,
    emailVerified: true, // possession of the emailed code proves control of the address
  });

  const token = await createSession(env, userId);
  return json(
    { ok: true },
    200,
    { 'Set-Cookie': cookieHeader(SESSION_COOKIE, token, { maxAge: SESSION_TTL_SECONDS, secure: isHttps(url) }) }
  );
}

// ---------------------------------------------------------------------------
// User data — every query is scoped to the session-derived user_id
// ---------------------------------------------------------------------------

function entryKeyFor(e) {
  return [e.date, e.bankroll, e.peak, e.hands, e.region].join('|');
}

function sanitiseScore(e) {
  if (!e || typeof e !== 'object') return null;
  const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
  const entry = {
    date: typeof e.date === 'string' ? e.date.slice(0, 32) : '',
    bankroll: int(e.bankroll) ?? 0,
    peak: int(e.peak) ?? 0,
    hands: int(e.hands) ?? 0,
    bookAcc: e.bookAcc === null || e.bookAcc === undefined ? null : int(e.bookAcc),
    countAcc: e.countAcc === null || e.countAcc === undefined ? null : int(e.countAcc),
    region: typeof e.region === 'string' ? e.region.slice(0, 64) : '',
  };
  return entry;
}

async function readState(env, userId) {
  const prefRow = await env.DB.prepare('SELECT data, updated_at FROM user_preferences WHERE user_id = ?')
    .bind(userId)
    .first();

  const scores = await env.DB.prepare(
    `SELECT date, bankroll, peak, hands, book_acc, count_acc, region
       FROM high_scores
      WHERE user_id = ?
      ORDER BY peak DESC
      LIMIT ?`
  )
    .bind(userId, MAX_HIGH_SCORES)
    .all();

  let preferences = null;
  if (prefRow && prefRow.data) {
    try {
      preferences = JSON.parse(prefRow.data);
    } catch {
      preferences = null;
    }
  }

  return {
    preferences,
    preferences_updated_at: prefRow ? prefRow.updated_at : null,
    highscores: (scores.results || []).map((r) => ({
      date: r.date,
      bankroll: r.bankroll,
      peak: r.peak,
      hands: r.hands,
      bookAcc: r.book_acc,
      countAcc: r.count_acc,
      region: r.region,
    })),
  };
}

async function writeState(request, env, userId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const ts = now();

  // Preferences: last write wins.
  if (body.preferences && typeof body.preferences === 'object') {
    const serialised = JSON.stringify(body.preferences).slice(0, 8192);
    await env.DB.prepare(
      `INSERT INTO user_preferences (user_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    )
      .bind(userId, serialised, ts)
      .run();
  }

  // High scores: union-merge. A leaderboard would lose entries under plain
  // last-write-wins if two devices each recorded a session while offline.
  if (Array.isArray(body.highscores) && body.highscores.length) {
    const statements = [];
    for (const raw of body.highscores.slice(0, 100)) {
      const e = sanitiseScore(raw);
      if (!e) continue;
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO high_scores
             (id, user_id, entry_key, date, bankroll, peak, hands, book_acc, count_acc, region, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          'hs_' + randomToken(12),
          userId,
          entryKeyFor(e),
          e.date,
          e.bankroll,
          e.peak,
          e.hands,
          e.bookAcc,
          e.countAcc,
          e.region,
          ts
        )
      );
    }
    if (statements.length) await env.DB.batch(statements);

    // Keep only this user's top N.
    await env.DB.prepare(
      `DELETE FROM high_scores
        WHERE user_id = ?
          AND id NOT IN (
            SELECT id FROM high_scores WHERE user_id = ? ORDER BY peak DESC LIMIT ?
          )`
    )
      .bind(userId, userId, MAX_HIGH_SCORES)
      .run();
  }

  return json({ ok: true, state: await readState(env, userId) });
}

async function clearScores(env, userId) {
  await env.DB.prepare('DELETE FROM high_scores WHERE user_id = ?').bind(userId).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }

    if (!env.DB) {
      return json({ error: 'db_not_configured', message: 'D1 binding "DB" is missing.' }, 503);
    }

    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && !originAllowed(request, url)) {
      return json({ error: 'bad_origin' }, 403);
    }

    try {
      // --- auth (no session required) ---
      if (url.pathname === '/api/auth/google/start' && method === 'GET') return googleStart(request, env, url);
      if (url.pathname === '/api/auth/google/callback' && method === 'GET') return googleCallback(request, env, url);
      if (url.pathname === '/api/auth/email/start' && method === 'POST') return emailStart(request, env);
      if (url.pathname === '/api/auth/email/verify' && method === 'POST') return emailVerify(request, env, url);

      if (url.pathname === '/api/auth/session' && method === 'GET') {
        const user = await getSessionUser(request, env);
        return json({
          authenticated: !!user,
          user: user ? { id: user.id, email: user.email, name: user.name, picture: user.picture } : null,
          providers: {
            google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
            email: !!(env.RESEND_API_KEY && env.MAIL_FROM),
          },
        });
      }

      if (url.pathname === '/api/auth/logout' && method === 'POST') {
        const token = getCookie(request, SESSION_COOKIE);
        if (token) {
          await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256hex(token)).run();
        }
        return json({ ok: true }, 200, {
          'Set-Cookie': cookieHeader(SESSION_COOKIE, '', { maxAge: 0, secure: isHttps(url) }),
        });
      }

      // --- everything below requires a valid session ---
      const user = await getSessionUser(request, env);
      if (!user) return json({ error: 'unauthenticated' }, 401);

      if (url.pathname === '/api/state' && method === 'GET') return json(await readState(env, user.id));
      if (url.pathname === '/api/state' && (method === 'PUT' || method === 'POST')) {
        return writeState(request, env, user.id);
      }
      if (url.pathname === '/api/state/highscores' && method === 'DELETE') return clearScores(env, user.id);

      return json({ error: 'not_found' }, 404);
    } catch (err) {
      console.error('api_error', url.pathname, err && err.message);
      return json({ error: 'server_error' }, 500);
    }
  },
};
