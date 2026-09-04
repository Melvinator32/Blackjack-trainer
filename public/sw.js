const CACHE_VERSION = 'bj-trainer-v2';

// Precache './' rather than './index.html': Cloudflare serves the app at '/' and
// 307-redirects '/index.html' to it, so precaching the redirecting URL would
// store an entry that later navigation requests never match.
const PRECACHE_URLS = [
  './',
  './bj-audio.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './sound-assets/bet_confirm.wav',
  './sound-assets/bet_decrease.wav',
  './sound-assets/bet_increase.wav',
  './sound-assets/blackjack_reward.wav',
  './sound-assets/button_hover.wav',
  './sound-assets/card_deal_dealer_01.wav',
  './sound-assets/card_deal_dealer_02.wav',
  './sound-assets/card_deal_dealer_03.wav',
  './sound-assets/card_deal_dealer_04.wav',
  './sound-assets/card_deal_hit.wav',
  './sound-assets/card_deal_hole.wav',
  './sound-assets/card_deal_player_01.wav',
  './sound-assets/card_deal_player_02.wav',
  './sound-assets/card_deal_player_03.wav',
  './sound-assets/card_deal_player_04.wav',
  './sound-assets/card_flip.wav',
  './sound-assets/card_flip_reveal.wav',
  './sound-assets/chip_place_large_01.wav',
  './sound-assets/chip_place_large_02.wav',
  './sound-assets/chip_place_large_03.wav',
  './sound-assets/chip_place_large_04.wav',
  './sound-assets/chip_place_small_01.wav',
  './sound-assets/chip_place_small_02.wav',
  './sound-assets/chip_place_small_03.wav',
  './sound-assets/chip_place_small_04.wav',
  './sound-assets/chip_stack.wav',
  './sound-assets/dealer_bust.wav',
  './sound-assets/double_down.wav',
  './sound-assets/insurance_offer.wav',
  './sound-assets/invalid_action.wav',
  './sound-assets/new_round.wav',
  './sound-assets/player_bust.wav',
  './sound-assets/player_loss.wav',
  './sound-assets/player_win_large.wav',
  './sound-assets/player_win_medium.wav',
  './sound-assets/player_win_small.wav',
  './sound-assets/push_result.wav',
  './sound-assets/shoe_shuffle.wav',
  './sound-assets/split_hand.wav',
  './sound-assets/table_button_press_01.wav',
  './sound-assets/table_button_press_02.wav',
  './sound-assets/table_button_press_03.wav',
  './sound-assets/table_button_press_04.wav',
  './sound-assets/table_stand.wav',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(PRECACHE_URLS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_VERSION; })
          .map(function (key) { return caches.delete(key); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: try the network first so updates show up, fall back to cache offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(function (cache) { cache.put('./', copy); });
        return res;
      }).catch(function () {
        return caches.match('./');
      })
    );
    return;
  }

  // Everything else: cache-first, then network, and cache what we fetch.
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      });
    })
  );
});
