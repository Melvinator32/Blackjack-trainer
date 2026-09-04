/*
 * Blackjack Trainer — account + cross-device sync.
 *
 * Deliberately standalone: the game's own code is untouched. This file hooks the
 * two localStorage keys the game already persists, mirrors them to the Worker
 * API, and injects a small account control.
 *
 * Signed out, the game behaves exactly as it always has — localStorage only, no
 * network. Signed in, D1 is the source of truth and localStorage becomes an
 * offline cache that re-syncs when connectivity returns.
 */
(function () {
  'use strict';

  var PREF_KEY = 'bj_audio_prefs';
  var SCORES_KEY = 'bjt_highscores';
  var SYNCED_KEYS = [PREF_KEY, SCORES_KEY];
  var OWNER_KEY = 'bj_sync_user';    // which user_id the cached data belongs to
  var PENDING_KEY = 'bj_sync_pending';
  var RELOAD_FLAG = 'bj_sync_reloaded';
  var MAX_SCORES = 15;

  var state = { user: null, providers: { google: false, email: false }, hydrated: false };
  var pushTimer = null;

  // --- storage helpers (never throw; Safari private mode etc.) ---------------
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) {} }
  function parse(raw, fallback) { try { return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; } }

  function api(path, options) {
    return fetch(path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {}));
  }

  // --- intercept the game's own writes --------------------------------------
  // Runs before the game script, so every save it makes is observed.
  var nativeSetItem = window.localStorage && window.localStorage.setItem;
  if (nativeSetItem) {
    try {
      window.localStorage.setItem = function (key, value) {
        nativeSetItem.call(window.localStorage, key, value);
        if (SYNCED_KEYS.indexOf(key) !== -1) onLocalChange();
      };
    } catch (e) { /* storage locked down; sync simply stays read-only */ }
  }

  function onLocalChange() {
    if (!state.user) return;         // anonymous play stays purely local
    lsSet(PENDING_KEY, '1');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 1200);   // debounce bursts of saves
  }

  function localPayload() {
    return {
      preferences: parse(lsGet(PREF_KEY), null),
      highscores: parse(lsGet(SCORES_KEY), []) || [],
    };
  }

  // --- push / pull ----------------------------------------------------------
  function push() {
    if (!state.user || !navigator.onLine) return Promise.resolve(false);
    var payload = localPayload();
    if (!payload.preferences && !payload.highscores.length) { lsDel(PENDING_KEY); return Promise.resolve(true); }

    return api('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('push failed: ' + res.status);
        return res.json();
      })
      .then(function (data) {
        lsDel(PENDING_KEY);
        if (data && data.state) applyServerState(data.state, false);
        return true;
      })
      .catch(function () { return false; });   // stays queued for the next attempt
  }

  function mergeScores(local, server) {
    var byKey = {};
    var add = function (e) {
      if (!e || typeof e !== 'object') return;
      byKey[[e.date, e.bankroll, e.peak, e.hands, e.region].join('|')] = e;
    };
    (server || []).forEach(add);
    (local || []).forEach(add);
    return Object.keys(byKey)
      .map(function (k) { return byKey[k]; })
      .sort(function (a, b) { return (b.peak || 0) - (a.peak || 0); })
      .slice(0, MAX_SCORES);
  }

  /** Writes server state into the local cache. Returns true if anything changed. */
  function applyServerState(server, allowReload) {
    var changed = false;

    if (server.preferences) {
      var next = JSON.stringify(server.preferences);
      if (next !== lsGet(PREF_KEY)) { lsSet(PREF_KEY, next); changed = true; }
    }

    var merged = mergeScores(parse(lsGet(SCORES_KEY), []), server.highscores || []);
    var mergedJson = JSON.stringify(merged);
    if (mergedJson !== lsGet(SCORES_KEY)) { lsSet(SCORES_KEY, mergedJson); changed = true; }

    // The game reads these once at startup. Rather than reach into its internals,
    // reload once so it initialises from the freshly synced cache.
    if (changed && allowReload && !sessionStorage.getItem(RELOAD_FLAG)) {
      try { sessionStorage.setItem(RELOAD_FLAG, '1'); } catch (e) {}
      location.reload();
      return true;
    }
    return changed;
  }

  function pull(allowReload) {
    return api('/api/state')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (server) {
        if (server) applyServerState(server, allowReload);
      })
      .catch(function () {});
  }

  // --- session bootstrap ----------------------------------------------------
  function clearCachedUserData() {
    SYNCED_KEYS.forEach(lsDel);
    lsDel(PENDING_KEY);
  }

  function bootstrap() {
    return api('/api/auth/session')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        state.providers = data.providers || state.providers;
        var previousOwner = lsGet(OWNER_KEY);

        if (!data.authenticated) {
          // Signed out (or session expired): drop cached data so the next person
          // on this device never sees the previous account's scores.
          if (previousOwner) { clearCachedUserData(); lsDel(OWNER_KEY); }
          state.user = null;
          renderAccountUI();
          return;
        }

        state.user = data.user;

        // Switching accounts on one device must not merge A's data into B's.
        if (previousOwner && previousOwner !== data.user.id) clearCachedUserData();
        lsSet(OWNER_KEY, data.user.id);

        renderAccountUI();

        // Anything queued offline goes up first so the pull can't clobber it.
        var pending = lsGet(PENDING_KEY);
        return (pending ? push() : Promise.resolve()).then(function () {
          return pull(true);
        });
      })
      .catch(function () {})
      .then(function () { state.hydrated = true; });
  }

  window.addEventListener('online', function () {
    if (state.user && lsGet(PENDING_KEY)) push();
  });

  // --- account UI -----------------------------------------------------------
  var STYLE = [
    '.bjacct{position:fixed;top:10px;right:14px;z-index:40;font:600 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.bjacct button{font:inherit;cursor:pointer;border-radius:999px;padding:7px 14px;border:1px solid #2c4a47;background:#2c4a47;color:#ece6da}',
    '.bjacct button:hover{background:#3d605b}',
    '.bjacct .who{display:flex;align-items:center;gap:8px;background:#f6f1e6;border:1px solid #d8cfbd;border-radius:999px;padding:4px 4px 4px 12px;color:#1f2623}',
    '.bjacct .who span{max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.bjacct .who button{padding:5px 11px;font-size:11px}',
    '.bjmodal{position:fixed;inset:0;z-index:60;background:rgba(31,38,35,.55);display:flex;align-items:center;justify-content:center;padding:18px}',
    '.bjcard{background:#f6f1e6;color:#1f2623;border-radius:14px;padding:22px;max-width:340px;width:100%;box-shadow:0 18px 50px rgba(0,0,0,.3);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.bjcard h3{margin:0 0 4px;font:700 18px/1.3 Georgia,serif}',
    '.bjcard p{margin:0 0 16px;color:#4f676d;font-size:13px}',
    '.bjcard input{width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:10px;border:1px solid #d8cfbd;border-radius:8px;font:14px inherit;background:#fff}',
    '.bjcard .btn{width:100%;padding:11px;border:0;border-radius:8px;cursor:pointer;font:600 14px inherit;margin-bottom:8px}',
    '.bjcard .primary{background:#2c4a47;color:#ece6da}',
    '.bjcard .ghost{background:transparent;color:#4f676d;border:1px solid #d8cfbd}',
    '.bjcard .sep{text-align:center;color:#4f676d;font-size:11px;letter-spacing:.08em;margin:12px 0}',
    '.bjcard .err{color:#b0503a;font-size:12px;margin-bottom:8px;min-height:16px}',
  ].join('');

  function ensureStyle() {
    if (document.getElementById('bjacct-style')) return;
    var s = document.createElement('style');
    s.id = 'bjacct-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function renderAccountUI() {
    if (!document.body) return;
    ensureStyle();
    var host = document.querySelector('.bjacct');
    if (!host) {
      host = document.createElement('div');
      host.className = 'bjacct';
      document.body.appendChild(host);
    }
    host.textContent = '';

    if (state.user) {
      var wrap = document.createElement('div');
      wrap.className = 'who';
      var label = document.createElement('span');
      label.textContent = state.user.name || state.user.email || 'Signed in';
      var out = document.createElement('button');
      out.type = 'button';
      out.textContent = 'Sign out';
      out.onclick = function () {
        api('/api/auth/logout', { method: 'POST' }).then(function () {
          clearCachedUserData();
          lsDel(OWNER_KEY);
          location.reload();
        });
      };
      wrap.appendChild(label);
      wrap.appendChild(out);
      host.appendChild(wrap);
    } else {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Sign in to sync';
      btn.onclick = openSignIn;
      host.appendChild(btn);
    }
  }

  function openSignIn() {
    ensureStyle();
    var overlay = document.createElement('div');
    overlay.className = 'bjmodal';
    var card = document.createElement('div');
    card.className = 'bjcard';
    overlay.appendChild(card);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

    var err = document.createElement('div');
    err.className = 'err';

    function heading(text, sub) {
      card.textContent = '';
      var h = document.createElement('h3');
      h.textContent = text;
      var p = document.createElement('p');
      p.textContent = sub;
      card.appendChild(h);
      card.appendChild(p);
      card.appendChild(err);
    }

    function chooser() {
      heading('Sync your progress', 'Sign in to keep your preferences and high scores on every device.');
      err.textContent = '';

      if (state.providers.google) {
        var g = document.createElement('button');
        g.className = 'btn primary';
        g.textContent = 'Continue with Google';
        g.onclick = function () { location.href = '/api/auth/google/start'; };
        card.appendChild(g);
      }
      if (state.providers.email) {
        if (state.providers.google) {
          var sep = document.createElement('div');
          sep.className = 'sep';
          sep.textContent = 'OR';
          card.appendChild(sep);
        }
        var e = document.createElement('button');
        e.className = 'btn ghost';
        e.textContent = 'Email me a sign-in code';
        e.onclick = emailStep;
        card.appendChild(e);
      }
      if (!state.providers.google && !state.providers.email) {
        err.textContent = 'No sign-in method is configured on this deployment yet.';
      }

      var cancel = document.createElement('button');
      cancel.className = 'btn ghost';
      cancel.textContent = 'Not now';
      cancel.onclick = function () { overlay.remove(); };
      card.appendChild(cancel);
    }

    function emailStep() {
      heading('Sign in by email', 'We’ll send a 6-digit code. No password needed.');
      var input = document.createElement('input');
      input.type = 'email';
      input.placeholder = 'you@example.com';
      input.autocomplete = 'email';
      card.appendChild(input);

      var send = document.createElement('button');
      send.className = 'btn primary';
      send.textContent = 'Send code';
      send.onclick = function () {
        var email = input.value.trim();
        if (!email) { err.textContent = 'Enter your email address.'; return; }
        send.disabled = true;
        send.textContent = 'Sending…';
        api('/api/auth/email/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email }),
        })
          .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
          .then(function (r) {
            if (!r.ok) throw new Error(r.body && r.body.message ? r.body.message : 'Could not send the code.');
            codeStep(email);
          })
          .catch(function (e2) {
            err.textContent = e2.message;
            send.disabled = false;
            send.textContent = 'Send code';
          });
      };
      card.appendChild(send);

      var back = document.createElement('button');
      back.className = 'btn ghost';
      back.textContent = 'Back';
      back.onclick = chooser;
      card.appendChild(back);
      input.focus();
    }

    function codeStep(email) {
      heading('Enter your code', 'Sent to ' + email + '. It expires in 10 minutes.');
      var input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.maxLength = 6;
      input.placeholder = '123456';
      card.appendChild(input);

      var go = document.createElement('button');
      go.className = 'btn primary';
      go.textContent = 'Sign in';
      go.onclick = function () {
        go.disabled = true;
        go.textContent = 'Checking…';
        api('/api/auth/email/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, code: input.value.trim() }),
        })
          .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
          .then(function (r) {
            if (!r.ok) throw new Error(r.body && r.body.error === 'bad_code' ? 'That code is not right.' : 'Sign-in failed.');
            try { sessionStorage.removeItem(RELOAD_FLAG); } catch (e3) {}
            location.reload();
          })
          .catch(function (e2) {
            err.textContent = e2.message;
            go.disabled = false;
            go.textContent = 'Sign in';
          });
      };
      card.appendChild(go);

      var back = document.createElement('button');
      back.className = 'btn ghost';
      back.textContent = 'Back';
      back.onclick = emailStep;
      card.appendChild(back);
      input.focus();
    }

    chooser();
    document.body.appendChild(overlay);
  }

  function start() {
    renderAccountUI();
    bootstrap();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
