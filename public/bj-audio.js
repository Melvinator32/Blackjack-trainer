/*!
 * bj-audio.js — premium blackjack table sound system
 * Everything is synthesized. Each generator is context-agnostic
 * (ac, dest, t, opts) so the exact same code can play live or be
 * rendered offline into audio assets.
 *
 * Palette: crisp cards on felt, ceramic/clay chip impacts, soft felt and
 * padded-leather taps, short warm low accents. Fast attack, short decay,
 * minimal stereo movement, natural variation on every repeat.
 */
var BJAudio = (function () {
"use strict";

/* ---------------- variation ---------------- */
var lastIdx = {};
function pick(key, n) {                 // never the same variation twice running
  var i = Math.floor(Math.random() * n);
  if (lastIdx[key] === i) i = (i + 1 + Math.floor(Math.random() * (n - 1))) % n;
  lastIdx[key] = i;
  return i;
}
function vp() { return 0.98 + Math.random() * 0.04; }   // pitch  +/-2%
function vg() { return 0.95 + Math.random() * 0.10; }   // volume +/-5%
function rnd(a, b) { return a + Math.random() * (b - a); }

/* ---------------- primitives ---------------- */
function noiseBuf(ac, dur) {
  var n = Math.max(1, Math.ceil(ac.sampleRate * dur));
  var b = ac.createBuffer(1, n, ac.sampleRate);
  var d = b.getChannelData(0);
  for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
// filtered noise burst: fast attack, exponential decay
function nz(ac, dest, t, dur, type, f0, f1, q, lvl, atk) {
  if (lvl <= 0 || dur <= 0) return;
  var s = ac.createBufferSource(); s.buffer = noiseBuf(ac, dur + 0.02);
  var f = ac.createBiquadFilter(); f.type = type; f.Q.value = q || 1;
  f.frequency.setValueAtTime(Math.max(30, f0), t);
  if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
  var g = ac.createGain();
  var a = (atk == null ? 0.002 : atk);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, lvl), t + a);
  g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
  s.connect(f); f.connect(g); g.connect(dest);
  s.start(t); s.stop(t + dur + 0.02);
}
// pitched body: sine/triangle with optional glide
function tone(ac, dest, t, f0, f1, dur, lvl, type, atk) {
  if (lvl <= 0 || dur <= 0) return;
  var o = ac.createOscillator(); o.type = type || "sine";
  o.frequency.setValueAtTime(Math.max(20, f0), t);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  var g = ac.createGain();
  var a = (atk == null ? 0.004 : atk);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, lvl), t + a);
  g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
  o.connect(g); g.connect(dest);
  o.start(t); o.stop(t + dur + 0.03);
}
// soft bell for the restrained tonal accents (warm, few partials)
function bell(ac, dest, t, f0, dur, lvl) {
  var parts = [[1, 1, dur], [2.01, 0.22, dur * 0.6], [3.86, 0.07, dur * 0.35]];
  for (var i = 0; i < parts.length; i++) {
    var o = ac.createOscillator();
    o.type = "sine";
    o.frequency.value = f0 * parts[i][0];
    var g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, lvl * parts[i][1]), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0004, t + parts[i][2]);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + parts[i][2] + 0.05);
  }
}
function panTo(ac, dest, p) {
  if (!p || !ac.createStereoPanner) return dest;
  var n = ac.createStereoPanner();
  n.pan.value = Math.max(-1, Math.min(1, p));
  n.connect(dest);
  return n;
}
// glue for a panner that travels (chip sweep on a loss)
function panMove(ac, dest, p0, p1, t, dur) {
  if (!ac.createStereoPanner) return dest;
  var n = ac.createStereoPanner();
  n.pan.setValueAtTime(p0, t);
  n.pan.linearRampToValueAtTime(p1, t + dur);
  n.connect(dest);
  return n;
}

/* ---------------- composite textures ---------------- */
// a single ceramic/clay chip meeting felt
function chipHit(ac, dest, t, o) {
  o = o || {};
  var v = pick("chip", 5), P = vp(), G = vg() * (o.gain == null ? 1 : o.gain);
  var body = (o.heavy ? 880 : 1240) + v * 85;
  nz(ac, dest, t, 0.009 + v * 0.002, "bandpass", (3300 + v * 380) * P, 0, 2.4, 0.130 * G, 0.0012);
  tone(ac, dest, t, body * P, body * 0.55 * P, 0.030, 0.078 * G, "triangle", 0.0015);
  nz(ac, dest, t + 0.002, 0.055, "lowpass", (300 + v * 25) * P, 170, 0.7, (o.heavy ? 0.120 : 0.085) * G, 0.002);
  if (o.heavy) tone(ac, dest, t, 108 * P, 68 * P, 0.10, 0.070 * G, "sine", 0.004);
}
// picking a chip back up: lighter, brighter, almost no felt thud
function chipLift(ac, dest, t, o) {
  o = o || {};
  var v = pick("lift", 4), P = vp(), G = vg() * (o.gain == null ? 1 : o.gain);
  nz(ac, dest, t, 0.008, "bandpass", (3900 + v * 320) * P, 0, 2.6, 0.085 * G, 0.001);
  tone(ac, dest, t, (1500 + v * 80) * P, 980 * P, 0.022, 0.048 * G, "triangle", 0.0012);
}
// 2-3 chips settling into a stack: organized, tight timing
function chipStack(ac, dest, t, o) {
  o = o || {};
  var n = o.count || (2 + Math.floor(Math.random() * 2));
  var tt = 0;
  for (var i = 0; i < n; i++) {
    chipHit(ac, dest, t + tt, { heavy: o.heavy, gain: (o.gain == null ? 1 : o.gain) * (1 - i * 0.07) });
    tt += rnd(0.026, 0.045);
  }
  return tt + 0.09;
}
// the felt-brush + precise stop that ends a card slide
function cardStop(ac, dest, t, P, lvl, heavy) {
  nz(ac, dest, t, 0.055, "lowpass", 430 * P, 240 * P, 0.7, 0.075 * lvl, 0.002);
  tone(ac, dest, t, (heavy ? 95 : 150) * P, (heavy ? 46 : 78) * P,
       heavy ? 0.13 : 0.075, (heavy ? 0.085 : 0.045) * lvl, "sine", 0.003);
}

/* ---------------- named sounds ---------------- */
var S = {};

/* card sliding across felt and stopping. who: player|dealer, hole, sharp */
S.card_deal = function (ac, dest, t, o) {
  o = o || {};
  var v = pick("card", 5), P = vp(), G = vg();
  var dealer = (o.who === "dealer");
  var hole = !!o.hole;
  // player cards sit closer and wider; dealer cards farther and centred
  var d = panTo(ac, dest, dealer ? rnd(-0.05, 0.05) : rnd(-0.17, 0.17));
  var lvl = G * (dealer ? 0.72 : 1.0) * (hole ? 0.62 : 1.0);
  // faint paper snap off the shoe
  nz(ac, d, t, 0.010, "highpass", ((o.sharp ? 7000 : 5500) + v * 260) * P, 0, 0.9,
     (o.sharp ? 0.070 : 0.050) * lvl, 0.0012);
  // felt brush during the slide (shorter and quieter for a hole card)
  var slide = hole ? rnd(0.085, 0.105) : rnd(0.155, 0.215);
  nz(ac, d, t + 0.004, slide, "bandpass", (2500 + v * 150) * P, (1180 + v * 70) * P, 0.85,
     (hole ? 0.048 : 0.072) * lvl, 0.010);
  // precise stop
  cardStop(ac, d, t + 0.004 + slide, P, lvl, hole);
  return 0.004 + slide + (hole ? 0.16 : 0.10);
};
S.card_deal_player = function (ac, d, t, o) { return S.card_deal(ac, d, t, Object.assign({ who: "player" }, o || {})); };
S.card_deal_dealer = function (ac, d, t, o) { return S.card_deal(ac, d, t, Object.assign({ who: "dealer" }, o || {})); };
S.card_hole       = function (ac, d, t, o) { return S.card_deal(ac, d, t, Object.assign({ who: "dealer", hole: true }, o || {})); };
S.card_hit        = function (ac, d, t, o) { return S.card_deal(ac, d, t, Object.assign({ who: "player", sharp: true }, o || {})); };

/* card turned over: paper flick then a clean felt tap */
S.card_flip = function (ac, dest, t, o) {
  o = o || {};
  var v = pick("flip", 4), P = vp(), G = vg();
  var d = panTo(ac, dest, rnd(-0.08, 0.08));
  var bright = o.reveal ? 1.22 : 1.0;
  nz(ac, d, t, 0.020, "bandpass", (3900 * bright + v * 300) * P, (2600 * bright) * P, 1.5,
     (o.reveal ? 0.120 : 0.092) * G, o.reveal ? 0.0010 : 0.0018);
  nz(ac, d, t + 0.028, 0.050, "lowpass", 420 * P, 250 * P, 0.7, 0.100 * G, 0.002);
  tone(ac, d, t + 0.028, 165 * P, 88 * P, 0.070, 0.056 * G, "sine", 0.003);
  return 0.11;
};
S.card_flip_reveal = function (ac, d, t, o) { return S.card_flip(ac, d, t, Object.assign({ reveal: true }, o || {})); };

/* chips */
S.chip_place       = function (ac, d, t, o) { chipHit(ac, d, t, o); return 0.13; };
S.chip_place_small = function (ac, d, t, o) { chipHit(ac, d, t, Object.assign({}, o)); return 0.13; };
S.chip_place_large = function (ac, d, t, o) { chipHit(ac, d, t, Object.assign({ heavy: true }, o)); return 0.17; };
S.chip_stack       = function (ac, d, t, o) { return chipStack(ac, d, t, o); };

/* bet up / down: physical first, a whisper of tone underneath */
S.bet_increase = function (ac, dest, t, o) {
  o = o || {};
  chipHit(ac, dest, t, { heavy: !!o.heavy });
  tone(ac, dest, t + 0.012, 520 * vp(), 700 * vp(), 0.16, 0.016, "sine", 0.020);
  return 0.20;
};
S.bet_decrease = function (ac, dest, t) {
  chipLift(ac, dest, t);
  tone(ac, dest, t + 0.010, 660 * vp(), 470 * vp(), 0.16, 0.014, "sine", 0.020);
  return 0.19;
};
/* committing the bet: firm stack + warm low accent */
S.bet_confirm = function (ac, dest, t, o) {
  o = o || {};
  var d = chipStack(ac, dest, t, { count: 3, heavy: true });
  tone(ac, dest, t + 0.02, 84 * vp(), 56 * vp(), 0.26, 0.060, "sine", 0.006);
  return Math.max(d, 0.30);
};

/* decisions */
S.stand = function (ac, dest, t) {                 // hand settling on felt / soft table knock
  var v = pick("stand", 4), P = vp(), G = vg();
  var d = panTo(ac, dest, rnd(-0.06, 0.06));
  tone(ac, d, t, (215 + v * 12) * P, (120 + v * 6) * P, 0.085, 0.110 * G, "triangle", 0.002);
  nz(ac, d, t, 0.055, "lowpass", (380 + v * 30) * P, 200, 0.7, 0.110 * G, 0.002);
  return 0.13;
};
S.double_down = function (ac, dest, t) {            // firm chip, pause, then the card lands
  chipHit(ac, dest, t, { heavy: true });
  tone(ac, dest, t + 0.02, 90 * vp(), 58 * vp(), 0.22, 0.050, "sine", 0.006);
  S.card_deal(ac, dest, t + 0.50, { who: "player", sharp: true });
  return 0.95;
};
S.split = function (ac, dest, t) {                  // one hand becomes two: cards apart, then two chips
  S.card_deal(ac, panTo(ac, dest, -0.26), t, { who: "player" });
  S.card_deal(ac, panTo(ac, dest, 0.26), t + 0.13, { who: "player" });
  chipHit(ac, panTo(ac, dest, -0.16), t + 0.42, {});
  chipHit(ac, panTo(ac, dest, 0.16), t + 0.50, {});
  return 0.68;
};

/* outcomes */
S.blackjack_reward = function (ac, dest, t) {       // reveal -> chip shimmer -> short warm flourish
  S.card_flip(ac, dest, t, { reveal: true });
  chipHit(ac, dest, t + 0.16, {});
  chipHit(ac, dest, t + 0.205, { gain: 0.9 });
  bell(ac, dest, t + 0.30, 587.33, 0.42, 0.075);    // D5
  bell(ac, dest, t + 0.40, 880.00, 0.46, 0.055);    // A5
  tone(ac, dest, t + 0.30, 110, 82, 0.36, 0.035, "sine", 0.010);
  return 0.90;
};
S.player_win = function (ac, dest, t, o) {          // controlled payout, then a warm resolve
  o = o || {};
  var size = o.size || "medium";
  var n = size === "large" ? 6 : (size === "small" ? 3 : 4);
  var tt = 0;
  for (var i = 0; i < n; i++) {
    chipHit(ac, panTo(ac, dest, rnd(-0.12, 0.12)), t + tt, { gain: 0.92 - i * 0.05 });
    tt += rnd(0.045, 0.075);
  }
  bell(ac, dest, t + tt + 0.05, 440, 0.40, size === "large" ? 0.070 : 0.055);
  if (size === "large") bell(ac, dest, t + tt + 0.14, 659.25, 0.36, 0.045);
  tone(ac, dest, t + tt + 0.05, 110, 88, 0.30, 0.030, "sine", 0.010);
  return tt + 0.50;
};
S.push = function (ac, dest, t) {                   // one chip out, one back: nothing gained or lost
  chipHit(ac, panMove(ac, dest, 0, -0.22, t, 0.12), t, { gain: 0.9 });
  chipHit(ac, panMove(ac, dest, -0.18, 0.02, t + 0.17, 0.12), t + 0.17, { gain: 0.9 });
  tone(ac, dest, t + 0.20, 329.63, 329.63, 0.34, 0.040, "sine", 0.014);   // unresolved
  return 0.56;
};
S.loss = function (ac, dest, t) {                   // chips swept away, muted scrape, soft low ending
  var mv = panMove(ac, dest, 0, -0.5, t, 0.34);
  for (var i = 0; i < 3; i++) chipHit(ac, mv, t + i * 0.055, { gain: 0.62 - i * 0.14 });
  nz(ac, mv, t + 0.05, 0.26, "bandpass", 1500, 620, 0.9, 0.045, 0.020);
  tone(ac, dest, t + 0.26, 92, 58, 0.28, 0.045, "sine", 0.008);
  return 0.56;
};
S.bust = function (ac, dest, t) {                   // conclusive, dry, not harsh
  nz(ac, dest, t, 0.05, "lowpass", 400, 230, 0.7, 0.055, 0.002);
  tone(ac, dest, t + 0.01, 104, 52, 0.20, 0.080, "sine", 0.004);
  nz(ac, dest, t + 0.01, 0.10, "lowpass", 190, 120, 0.6, 0.040, 0.003);
  return 0.28;
};
S.dealer_bust = function (ac, dest, t) {            // lighter than a bust, then a restrained payout
  nz(ac, dest, t, 0.045, "lowpass", 480, 280, 0.7, 0.045, 0.002);
  tone(ac, dest, t + 0.01, 130, 78, 0.16, 0.055, "sine", 0.004);
  chipHit(ac, dest, t + 0.20, { gain: 0.85 });
  chipHit(ac, dest, t + 0.255, { gain: 0.78 });
  bell(ac, dest, t + 0.30, 493.88, 0.34, 0.050);
  return 0.66;
};
S.insurance_offer = function (ac, dest, t) {        // card-edge tap + quiet neutral chime
  nz(ac, dest, t, 0.014, "bandpass", 3200, 2400, 1.8, 0.045, 0.0012);
  bell(ac, dest, t + 0.06, 880, 0.40, 0.038);
  return 0.48;
};

/* table / UI */
S.table_button_press = function (ac, dest, t) {     // fingertip on padded leather
  var v = pick("btn", 4), P = vp(), G = vg();
  nz(ac, dest, t, 0.032, "lowpass", (520 + v * 40) * P, 300, 0.8, 0.078 * G, 0.0015);
  tone(ac, dest, t, (190 + v * 10) * P, (120 + v * 6) * P, 0.045, 0.046 * G, "sine", 0.002);
  return 0.07;
};
S.button_hover = function (ac, dest, t) {           // barely-there felt brush
  nz(ac, dest, t, 0.016, "bandpass", 2600 * vp(), 1900, 1.2, 0.012, 0.003);
  return 0.03;
};
S.invalid_action = function (ac, dest, t) {         // dry wooden double-tap
  var P = vp();
  for (var i = 0; i < 2; i++) {
    var tt = t + i * 0.085;
    tone(ac, dest, tt, 250 * P, 175 * P, 0.045, 0.045, "triangle", 0.0015);
    nz(ac, dest, tt, 0.022, "bandpass", 1250 * P, 800, 1.4, 0.030, 0.0015);
  }
  return 0.18;
};

/* shoe shuffle: gather -> square -> riffle -> bridge -> back into the shoe */
S.shoe_shuffle = function (ac, dest, t) {
  var P = vp();
  // gather the decks in
  for (var i = 0; i < 5; i++) {
    nz(ac, panTo(ac, dest, rnd(-0.2, 0.2)), t + i * 0.085 + rnd(0, 0.02), rnd(0.10, 0.16),
       "bandpass", rnd(1700, 2400) * P, rnd(900, 1300), 0.8, 0.045, 0.012);
  }
  // square the deck: edges tapped on felt
  var sq = t + 0.55;
  for (var j = 0; j < 3; j++) {
    nz(ac, dest, sq + j * 0.11, 0.045, "lowpass", 620 * P, 320, 0.8, 0.060, 0.0018);
    tone(ac, dest, sq + j * 0.11, 190 * P, 110 * P, 0.055, 0.035, "sine", 0.003);
  }
  // riffle: a dense run of card edges, accelerating then easing off
  var r = t + 0.95, tt = 0;
  for (var k = 0; k < 34; k++) {
    var prog = k / 34;
    var gap = 0.030 - 0.014 * Math.sin(prog * Math.PI);       // fastest in the middle
    nz(ac, panTo(ac, dest, (prog - 0.5) * 0.20), r + tt, 0.012,
       "bandpass", (2500 + Math.random() * 1500) * P, 1500, 2.0,
       0.038 * (0.65 + 0.35 * Math.sin(prog * Math.PI)), 0.0010);
    tt += gap;
  }
  // bridge cascading down
  var br = r + tt + 0.05;
  nz(ac, dest, br, 0.20, "bandpass", 2100 * P, 1100, 1.1, 0.050, 0.015);
  // squared again and slid home into the shoe
  nz(ac, dest, br + 0.24, 0.045, "lowpass", 600 * P, 320, 0.8, 0.055, 0.002);
  nz(ac, dest, br + 0.33, 0.20, "bandpass", 1900 * P, 900, 0.9, 0.055, 0.012);
  nz(ac, dest, br + 0.54, 0.055, "lowpass", 380 * P, 220, 0.7, 0.070, 0.002);
  tone(ac, dest, br + 0.54, 105 * P, 58 * P, 0.16, 0.060, "sine", 0.004);
  return (br + 0.75) - t;
};

/* table reset between rounds: cards collected, chips settle, one edge tap */
S.new_round = function (ac, dest, t) {
  var P = vp();
  nz(ac, panTo(ac, dest, -0.12), t, 0.17, "bandpass", 2000 * P, 1000, 0.85, 0.045, 0.014);
  chipHit(ac, panTo(ac, dest, 0.10), t + 0.16, { gain: 0.6 });
  chipHit(ac, panTo(ac, dest, 0.14), t + 0.205, { gain: 0.5 });
  nz(ac, dest, t + 0.30, 0.030, "bandpass", 2900 * P, 2100, 1.7, 0.040, 0.0012);
  return 0.42;
};

/* ---------------- engine ---------------- */
var API = { enabled: true, volume: 0.55, sounds: S };
var live = null, bus = null;

function makeBus(ac) {
  // gentle glue compression, then a fast limiter so nothing spikes
  var comp = ac.createDynamicsCompressor();
  comp.threshold.value = -20; comp.knee.value = 14; comp.ratio.value = 3;
  comp.attack.value = 0.003; comp.release.value = 0.18;
  var warm = ac.createBiquadFilter();          // keep long sessions comfortable
  warm.type = "highshelf"; warm.frequency.value = 7200; warm.gain.value = -2.5;
  var makeup = ac.createGain(); makeup.gain.value = 4.2;   // bring the mix up to a usable level
  var lim = ac.createDynamicsCompressor();
  lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20;
  lim.attack.value = 0.001; lim.release.value = 0.06;
  var out = ac.createGain();
  comp.connect(warm); warm.connect(makeup); makeup.connect(lim); lim.connect(out);
  return { input: comp, out: out };
}
function ensureLive() {
  if (!live) {
    live = (typeof ZenAudio !== "undefined" && ZenAudio.context)
      ? ZenAudio.context()
      : new (window.AudioContext || window.webkitAudioContext)();
    bus = makeBus(live);
    bus.out.gain.value = API.volume;
    bus.out.connect(live.destination);
  }
  if (live.state === "suspended") live.resume();
  return live;
}

API.play = function (name, o) {
  if (!API.enabled) return 0;
  var fn = S[name];
  if (!fn) return 0;
  var ac = ensureLive();
  return fn(ac, bus.input, o && o.when ? o.when : ac.currentTime, o) || 0;
};
API.at = function (name, when, o) {              // schedule at an explicit context time
  if (!API.enabled) return 0;
  var fn = S[name]; if (!fn) return 0;
  ensureLive();
  return fn(live, bus.input, when, o) || 0;
};
API.now = function () { return ensureLive().currentTime; };
API.setVolume = function (v) { API.volume = v; if (bus) bus.out.gain.value = v; };
API.unlock = function () {
  var ac = ensureLive();
  var b = ac.createBuffer(1, 1, 22050), s = ac.createBufferSource();
  s.buffer = b; s.connect(ac.destination); s.start(0);
  return ac;
};

/* ---------------- offline render / asset export ---------------- */
API.render = function (name, o, seconds, sampleRate) {
  var sr = sampleRate || 48000;
  var secs = seconds || 4;
  var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  var ac = new OC(2, Math.ceil(sr * secs), sr);
  var b = makeBus(ac);
  b.out.gain.value = API.volume;
  b.out.connect(ac.destination);
  var fn = S[name];
  if (!fn) return Promise.reject(new Error("unknown sound: " + name));
  fn(ac, b.input, 0.02, o || {});
  return ac.startRendering();
};
API.toWav = function (buf, bits) {
  bits = bits || 24;
  var ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  var bytes = bits / 8, dataLen = len * ch * bytes;
  var ab = new ArrayBuffer(44 + dataLen), v = new DataView(ab), p = 0;
  function s(str) { for (var i = 0; i < str.length; i++) v.setUint8(p++, str.charCodeAt(i)); }
  function u32(x) { v.setUint32(p, x, true); p += 4; }
  function u16(x) { v.setUint16(p, x, true); p += 2; }
  s("RIFF"); u32(36 + dataLen); s("WAVE");
  s("fmt "); u32(16); u16(1); u16(ch); u32(sr);
  u32(sr * ch * bytes); u16(ch * bytes); u16(bits);
  s("data"); u32(dataLen);
  var chans = [];
  for (var c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  var peak = bits === 24 ? 8388607 : 32767;
  for (var i = 0; i < len; i++) {
    for (var c2 = 0; c2 < ch; c2++) {
      var x = Math.max(-1, Math.min(1, chans[c2][i]));
      var n = Math.round(x * peak);
      if (bits === 24) { v.setUint8(p++, n & 255); v.setUint8(p++, (n >> 8) & 255); v.setUint8(p++, (n >> 16) & 255); }
      else { v.setInt16(p, n, true); p += 2; }
    }
  }
  return new Blob([ab], { type: "audio/wav" });
};
// the asset list, with the descriptive filenames from the brief
API.assetList = function () {
  var L = [], i;
  for (i = 1; i <= 4; i++) L.push(["card_deal_player_0" + i, "card_deal_player", {}, 1.0]);
  for (i = 1; i <= 4; i++) L.push(["card_deal_dealer_0" + i, "card_deal_dealer", {}, 1.0]);
  L.push(["card_deal_hole", "card_hole", {}, 1.0]);
  L.push(["card_deal_hit", "card_hit", {}, 1.0]);
  L.push(["card_flip", "card_flip", {}, 1.0]);
  L.push(["card_flip_reveal", "card_flip_reveal", {}, 1.0]);
  for (i = 1; i <= 4; i++) L.push(["chip_place_small_0" + i, "chip_place_small", {}, 0.6]);
  for (i = 1; i <= 4; i++) L.push(["chip_place_large_0" + i, "chip_place_large", {}, 0.6]);
  L.push(["chip_stack", "chip_stack", {}, 0.8]);
  L.push(["bet_increase", "bet_increase", {}, 0.8]);
  L.push(["bet_decrease", "bet_decrease", {}, 0.8]);
  L.push(["bet_confirm", "bet_confirm", {}, 1.0]);
  L.push(["table_stand", "stand", {}, 0.6]);
  L.push(["double_down", "double_down", {}, 1.6]);
  L.push(["split_hand", "split", {}, 1.4]);
  L.push(["blackjack_reward", "blackjack_reward", {}, 1.6]);
  L.push(["player_win_small", "player_win", { size: "small" }, 1.6]);
  L.push(["player_win_medium", "player_win", { size: "medium" }, 1.6]);
  L.push(["player_win_large", "player_win", { size: "large" }, 1.8]);
  L.push(["push_result", "push", {}, 1.2]);
  L.push(["player_loss", "loss", {}, 1.2]);
  L.push(["player_bust", "bust", {}, 1.0]);
  L.push(["dealer_bust", "dealer_bust", {}, 1.4]);
  L.push(["insurance_offer", "insurance_offer", {}, 1.0]);
  for (i = 1; i <= 4; i++) L.push(["table_button_press_0" + i, "table_button_press", {}, 0.4]);
  L.push(["button_hover", "button_hover", {}, 0.3]);
  L.push(["invalid_action", "invalid_action", {}, 0.6]);
  L.push(["shoe_shuffle", "shoe_shuffle", {}, 4.0]);
  L.push(["new_round", "new_round", {}, 1.0]);
  return L;
};
API.renderAll = function (onOne) {
  var list = API.assetList(), out = [];
  return list.reduce(function (chain, item) {
    return chain.then(function () {
      return API.render(item[1], item[2], item[3]).then(function (buf) {
        var rec = { name: item[0], buffer: buf };
        out.push(rec);
        if (onOne) onOne(rec);
      });
    });
  }, Promise.resolve()).then(function () { return out; });
};
API.exportAll = function () {                     // browser download of every asset
  return API.renderAll(function (rec) {
    var url = URL.createObjectURL(API.toWav(rec.buffer));
    var a = document.createElement("a");
    a.href = url; a.download = rec.name + ".wav";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  });
};

return API;
})();
