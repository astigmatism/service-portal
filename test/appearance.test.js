#!/usr/bin/env node
'use strict';
/*
 * Zero-dependency test for the appearance IIFE in index.html:
 * wallpaper-slot navigation (prev/next re-roll, add/remove slot, delete,
 * multi-upload), the per-browser random wallpaper roll (seeded, so picks
 * are reproducible), per-wallpaper accent sampling, palette derivation,
 * live CSS-variable application, settings persistence, and the
 * server-side slot + wallpaper endpoints in server.js (including the
 * legacy single-wallpaper and flat-collection migrations).
 *
 *   node test/appearance.test.js
 *
 * The IIFE is extracted verbatim from index.html and run in a vm context
 * with minimal DOM/canvas/fetch stubs, so the real shipping code is what
 * gets exercised (no copy drift). Math.random is replaced with a seeded
 * LCG inside the sandbox so the random wallpaper rolls are deterministic.
 * Not shipped in the container image.
 */
const assert = require('assert');
const child = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ------------------------------------------------------------------ */
/* Reference color math — written from the CSS spec, independent of   */
/* the app's own implementation (used to cross-check its output).     */
/* ------------------------------------------------------------------ */
function refHslHex(hDeg, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hDeg / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
}
function refRgbHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0, s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return [h, s, l];
}
const hexTri = (hex) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',');
const relLum = (hex) =>
  (0.299 * parseInt(hex.slice(1, 3), 16) + 0.587 * parseInt(hex.slice(3, 5), 16) +
    0.114 * parseInt(hex.slice(5, 7), 16)) / 255;

/* ------------------------------------------------------------------ */
/* Extract the appearance IIFE verbatim from index.html.              */
/* ------------------------------------------------------------------ */
const marker = '/* ===== Appearance (wallpaper slots + glass)';
const start = html.indexOf(marker);
assert.ok(start !== -1, 'appearance block marker not found in index.html');
const fnStart = html.indexOf('(function () {', start);
const fnEnd = html.lastIndexOf('})();');
assert.ok(fnStart !== -1 && fnEnd > fnStart, 'appearance IIFE bounds not found');
const code = html.slice(fnStart, fnEnd + '})();'.length);

/* ------------------------------------------------------------------ */
/* Minimal DOM / canvas / fetch stubs.                                */
/* ------------------------------------------------------------------ */
function mkStyle() {
  const props = {};
  return {
    props,
    setProperty: (k, v) => { props[k] = String(v); },
    removeProperty: (k) => { delete props[k]; }
  };
}
function mkClassList() {
  const set = new Set();
  return {
    add: (...cs) => cs.forEach((c) => set.add(c)),
    remove: (...cs) => cs.forEach((c) => set.delete(c)),
    toggle: (c, force) => {
      const want = force === undefined ? !set.has(c) : !!force;
      want ? set.add(c) : set.delete(c);
      return want;
    },
    contains: (c) => set.has(c)
  };
}
function mkEl(id) {
  const el = {
    id,
    style: mkStyle(),
    classList: mkClassList(),
    attrs: {},
    listeners: {},
    value: '',
    disabled: false,
    files: []
  };
  let _text = '';
  Object.defineProperty(el, 'textContent', {
    get: () => _text,
    /* Real DOM: clearing textContent empties the element's children. */
    set: (v) => { _text = String(v); if (_text === '') el.children.length = 0; }
  });
  el.children = [];
  el.setAttribute = (k, v) => { el.attrs[k] = v; };
  el.removeAttribute = (k) => { delete el.attrs[k]; };
  el.toggleAttribute = (k, on) => { on ? el.setAttribute(k, '') : el.removeAttribute(k); };
  el.addEventListener = (type, fn) => { (el.listeners[type] = el.listeners[type] || []).push(fn); };
  el.click = () => {};
  el.appendChild = (c) => { el.children.push(c); return c; };
  el.removeChild = (c) => { el.children = el.children.filter((x) => x !== c); };
  return el;
}
function mkCanvas() {
  const canvas = { width: 0, height: 0 };
  canvas.getContext = (kind) => {
    if (kind !== '2d') return null;
    let pixels = null;
    return {
      drawImage(bmp, _dx, _dy, dw, dh) {
        const out = new Uint8ClampedArray(dw * dh * 4);
        for (let y = 0; y < dh; y++) {
          for (let x = 0; x < dw; x++) {
            const sx = Math.min(bmp.width - 1, Math.floor((x * bmp.width) / dw));
            const sy = Math.min(bmp.height - 1, Math.floor((y * bmp.height) / dh));
            const si = (sy * bmp.width + sx) * 4, di = (y * dw + x) * 4;
            out[di] = bmp.data[si]; out[di + 1] = bmp.data[si + 1];
            out[di + 2] = bmp.data[si + 2]; out[di + 3] = bmp.data[si + 3];
          }
        }
        pixels = out;
      },
      getImageData: () => ({ data: pixels }),
      toBlob() { throw new Error('toBlob not needed in tests'); }
    };
  };
  return canvas;
}
/* Synthetic bitmap: w×h RGBA, fill(x, y) → [r, g, b]. */
function makeBitmap(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data, close() {} };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

/* Seeded LCG so the IIFE's Math.random wallpaper rolls are reproducible.
   mkMath keeps every real Math member (floor, max, …) via the prototype
   and only swaps `random`. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const mkMath = (seed) => {
  const m = Object.create(Math);
  m.random = lcg(seed);
  return m;
};

/* Fetch stub emulating the server's wallpaper-slot protocol: the settings
   PUT carries sliders + the active-slot pointer only (the slots are owned
   by the slot/wallpaper endpoints), a drained slot is removed
   automatically, and deleting an active slot moves the pointer to the
   previous slot. */
function mkFetch(state) {
  const respond = (status, obj) => ({ ok: status < 400, status, json: async () => obj });
  const WP_ITEM = /^\/api\/appearance\/wallpapers\/([^/]+)$/;
  const SLOT_ITEM = /^\/api\/appearance\/slots\/([^/]+)$/;
  const SLOT_MOVE = /^\/api\/appearance\/slots\/([^/]+)\/move$/;
  const SLOT_WP = /^\/api\/appearance\/slots\/([^/]+)\/wallpapers$/;
  const mkWallpaper = (headers) => ({
    id: 'wp-' + String(state.nextId++).padStart(4, '0'),
    type: String(headers['Content-Type'] || '').split(';')[0],
    imageDark: headers['x-sp-image-dark'] === '1',
    accent: typeof headers['x-sp-accent'] === 'string' && /^#[0-9a-fA-F]{6}$/.test(headers['x-sp-accent'])
      ? headers['x-sp-accent'].toLowerCase() : '',
    accentTouched: true
  });
  const postWallpaper = (slot, headers, body) => {
    const wallpaper = mkWallpaper(headers);
    slot.wallpapers.push(wallpaper);
    state.blobs.set(wallpaper.id, {});
    return wallpaper;
  };
  return async (url, opts) => {
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};

    if (url === '/api/appearance' && method === 'GET')
      return respond(200, { settings: clone(state.settings) });

    if (url === '/api/appearance' && method === 'PUT') {
      const sent = JSON.parse(opts.body);
      state.putBodies.push(sent);
      // Mirrors the server merge: sliders are taken from the body, the slot
      // collection is ignored, and the active slot only moves when it is a
      // known id (null when no slot exists at all).
      if (sent.backgroundPosition !== undefined) state.settings.backgroundPosition = sent.backgroundPosition;
      state.settings.backgroundOpacity = sent.backgroundOpacity;
      state.settings.backgroundBlur = sent.backgroundBlur;
      state.settings.scrim = sent.scrim;
      state.settings.surfaceAlpha = sent.surfaceAlpha;
      state.settings.glassBlur = sent.glassBlur;
      if (state.settings.slots.length === 0) state.settings.activeSlotId = null;
      else if (typeof sent.activeSlotId === 'string' && state.settings.slots.some((s) => s.id === sent.activeSlotId))
        state.settings.activeSlotId = sent.activeSlotId;
      return respond(200, { ok: true, settings: clone(state.settings) });
    }

    if (url === '/api/appearance/slots' && method === 'POST') {
      state.slotPosts += 1;
      const slot = { id: 'slot-' + String(state.nextSlotId++).padStart(2, '0'), wallpapers: [] };
      state.settings.slots.push(slot);
      state.settings.activeSlotId = slot.id;
      return respond(200, { ok: true, settings: clone(state.settings) });
    }
    if (url === '/api/appearance/slots' && method === 'DELETE') {
      state.slotWipes += 1;
      state.settings.slots = [];
      state.settings.activeSlotId = null;
      return respond(200, { ok: true, settings: clone(state.settings) });
    }

    const mm = String(url).match(SLOT_MOVE);
    if (mm) {
      if (method === 'POST') {
        const body = JSON.parse(opts.body);
        const delta = body && body.delta;
        const idx = state.settings.slots.findIndex((s) => s.id === mm[1]);
        if (idx === -1) return respond(404, {});
        if (delta !== -1 && delta !== 1) return respond(400, {});
        const target = idx + delta;
        if (target < 0 || target >= state.settings.slots.length) return respond(422, {});
        state.slotMoves.push({ slotId: mm[1], delta: delta });
        const slots = state.settings.slots;
        const [moved] = slots.splice(idx, 1);
        slots.splice(target, 0, moved);
        return respond(200, { ok: true, settings: clone(state.settings) });
      }
      return respond(405, {});
    }

    const sm = String(url).match(SLOT_ITEM);
    if (sm) {
      if (method === 'DELETE') {
        const idx = state.settings.slots.findIndex((s) => s.id === sm[1]);
        if (idx === -1) return respond(404, {});
        state.slotDeletes.push(sm[1]);
        const wasActive = state.settings.activeSlotId === sm[1];
        state.settings.slots = state.settings.slots.filter((s) => s.id !== sm[1]);
        if (wasActive) state.settings.activeSlotId = state.settings.slots.length
          ? state.settings.slots[Math.max(0, idx - 1)].id : null;
        return respond(200, { ok: true, settings: clone(state.settings) });
      }
      return respond(405, {});
    }

    const spm = String(url).match(SLOT_WP);
    if (spm) {
      if (method === 'POST') {
        const slot = state.settings.slots.find((s) => s.id === spm[1]);
        if (!slot) return respond(404, {});
        state.slotWpPosts.push({
          slotId: spm[1],
          type: headers['Content-Type'],
          dark: headers['x-sp-image-dark'],
          accent: headers['x-sp-accent'],
          bytes: (opts.body || {}).size || 0
        });
        const wallpaper = postWallpaper(slot, headers, opts.body);
        state.settings.activeSlotId = slot.id;
        return respond(200, { ok: true, wallpaper: clone(wallpaper), settings: clone(state.settings) });
      }
      return respond(405, {});
    }

    if (url === '/api/appearance/wallpapers' && method === 'POST') {
      // Legacy endpoint: append to the active slot, or mint a slot first.
      state.posts.push({
        type: headers['Content-Type'],
        dark: headers['x-sp-image-dark'],
        accent: headers['x-sp-accent'],
        bytes: (opts.body || {}).size || 0
      });
      let slot = state.settings.slots.find((s) => s.id === state.settings.activeSlotId);
      if (!slot) {
        slot = { id: 'slot-' + String(state.nextSlotId++).padStart(2, '0'), wallpapers: [] };
        state.settings.slots.push(slot);
        state.settings.activeSlotId = slot.id;
      }
      const wallpaper = postWallpaper(slot, headers, opts.body);
      return respond(200, { ok: true, wallpaper: clone(wallpaper), settings: clone(state.settings) });
    }

    if (url === '/api/appearance/wallpapers' && method === 'DELETE') {
      state.deletesAll += 1;
      state.settings.slots = [];
      state.settings.activeSlotId = null;
      return respond(200, { ok: true, settings: clone(state.settings) });
    }

    const m = String(url).match(WP_ITEM);
    if (m) {
      const id = m[1];
      let slotIdx = -1, wpIdx = -1;
      for (let si = 0; si < state.settings.slots.length; si++) {
        const wi = state.settings.slots[si].wallpapers.findIndex((w) => w.id === id);
        if (wi !== -1) { slotIdx = si; wpIdx = wi; break; }
      }
      if (method === 'GET') {
        if (slotIdx === -1) return respond(404, {});
        return { ok: true, status: 200, blob: async () => state.blobs.get(id) || {} };
      }
      if (method === 'PUT') {
        if (slotIdx === -1) return respond(404, {});
        const sent = JSON.parse(opts.body);
        state.metaPuts.push({ id, body: sent });
        const e = state.settings.slots[slotIdx].wallpapers[wpIdx];
        if (typeof sent.imageDark === 'boolean') e.imageDark = sent.imageDark;
        if (typeof sent.accent === 'string')
          e.accent = /^#[0-9a-fA-F]{6}$/.test(sent.accent) ? sent.accent.toLowerCase() : '';
        if (typeof sent.accentTouched === 'boolean') e.accentTouched = sent.accentTouched;
        return respond(200, { ok: true, wallpaper: clone(e), settings: clone(state.settings) });
      }
      if (method === 'DELETE') {
        if (slotIdx === -1) return respond(404, {});
        state.deletes.push(id);
        const slot = state.settings.slots[slotIdx];
        slot.wallpapers = slot.wallpapers.filter((w) => w.id !== id);
        if (slot.wallpapers.length === 0) {
          const wasActive = state.settings.activeSlotId === slot.id;
          state.settings.slots = state.settings.slots.filter((s) => s.id !== slot.id);
          if (wasActive) state.settings.activeSlotId = state.settings.slots.length
            ? state.settings.slots[Math.max(0, slotIdx - 1)].id : null;
        }
        return respond(200, { ok: true, settings: clone(state.settings) });
      }
      return respond(405, {});
    }

    return respond(404, {});
  };
}

const SERVER_DEFAULTS = {
  slots: [], activeSlotId: null, backgroundPosition: { x: 50, y: 50 },
  backgroundOpacity: 1, backgroundBlur: 0, scrim: 0, surfaceAlpha: 1,
  glassBlur: 0
};

/* Default RNG seed so every roll in the suite is reproducible. */
const DEFAULT_SEED = 20240101;

function boot(bitmapFactory, serverSettings, preLS, seed) {
  const elements = {};
  const getEl = (id) => (elements[id] = elements[id] || mkEl(id));
  const body = getEl('body');
  const documentStub = {
    body,
    getElementById: getEl,
    createElement: (tag) => (tag === 'canvas' ? mkCanvas() : mkEl('anon')),
    addEventListener: () => {}
  };
  const ss = serverSettings || {};
  const fetchState = {
    settings: {
      ...SERVER_DEFAULTS,
      ...ss,
      slots: Array.isArray(ss.slots) ? clone(ss.slots) : []
    },
    blobs: new Map(),
    putBodies: [], posts: [], deletes: [], deletesAll: 0, metaPuts: [],
    slotPosts: 0, slotWipes: 0, slotDeletes: [], slotMoves: [], slotWpPosts: [],
    nextId: 1, nextSlotId: 1
  };
  const sandbox = {
    document: documentStub,
    Math: mkMath(seed === undefined ? DEFAULT_SEED : seed),
    localStorage: {
      _s: {},
      getItem(k) { return k in this._s ? this._s[k] : null; },
      setItem(k, v) { this._s[k] = String(v); },
      removeItem(k) { delete this._s[k]; }
    },
    fetch: mkFetch(fetchState),
    indexedDB: { open() { throw new Error('indexedDB should not be hit by the tested flows'); } },
    createImageBitmap: async () => bitmapFactory(),
    setTimeout, clearTimeout,
    console,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    navigator: {}
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  if (preLS) for (const [k, v] of Object.entries(preLS)) sandbox.localStorage.setItem(k, v);
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { elements, body, fetchState, localStorage: sandbox.localStorage };
}

/* Fire the file input's change listener with the given fake file(s). */
function upload(elements, ...files) {
  const input = elements.spFile;
  input.files = files;
  const l = input.listeners.change;
  assert.ok(l && l.length, 'file input has a change listener');
  l[0]();
}
function click(elements, id) {
  const l = elements[id].listeners.click;
  assert.ok(l && l.length, id + ' has a click listener');
  l[0]();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Static sanity: the CSS consumes the theme variables and the new    */
/* collection controls are present in the markup.                     */
/* ------------------------------------------------------------------ */
for (const needle of [
  '--panel-rgb:21,28,46', '--panel-2-rgb:28,39,64',
  '--header-a-rgb:20,27,45', '--header-b-rgb:16,22,38',
  '--head-rgb:24,34,58', '--hover-rgb:27,39,69', '--selftag-line:#2e4a75',
  '.tablewrap{', 'background:rgba(var(--panel-rgb),var(--sp-list-alpha,1))',
  'background:rgba(var(--head-rgb),var(--sp-list-alpha,1))',
  '#sidebar{', 'align-self:flex-start', 'max-height:100%',
  'List background <output id="spListOpacityOut">100%</output>',
  'rgb(var(--header-a-rgb))', 'rgb(var(--panel-2-rgb))', 'rgb(var(--hover-rgb))',
  'border:1px solid var(--selftag-line)',
  'id="spNav"', 'id="spPrev"', 'id="spNext"', 'id="spNavCount"',
  'id="bgPrev"', 'id="bgNext"', '.seg-arrow{',
  '.sp-nav{', 'accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple>',
  'id="spPosGrid"', 'id="spPos-br"', '.sp-pos{', '.sp-pos:disabled{', 'id="spPosX"', 'id="spPosY"',
  'background-position:var(--sp-bg-position,50% 50%)',
  "const POS_LS_KEY = 'sp-wallpaper-positions'",
  'id="spAddSlot"', 'id="spRemoveSlot"', 'id="spThumbsWrap"', 'id="spThumbs"',
  '.sp-thumb-item{', '.sp-thumb-item.current{', '.sp-thumb-del{',
  'const SLOTS_URL = \'/api/appearance/slots\'',
  'Previous slot (re-rolls a random wallpaper of it)'
]) {
  assert.ok(html.includes(needle), 'index.html missing: ' + needle);
}

/* ------------------------------------------------------------------ */
/* Real-server helper (used by the protocol + migration scenarios).   */
/* ------------------------------------------------------------------ */
async function waitUp(base) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start on ' + base);
}
function spawnServer(dataDir, port) {
  const proc = child.spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SELF_NAME: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  proc.failOutput = () => out;
  return proc;
}

(async () => {
  /* ---------------- Scenario 1: first upload mints a slot ----------------
     A first upload against an empty portal creates the slot to upload into
     and lands the wallpaper in it; that slot becomes active, the rolled
     pick (the slot's only wallpaper here) is displayed, the sampled accent
     + palette follow it, and the active slot is persisted. */
  {
    // 75% red / 25% blue → hue bucket 0 must win, re-normalized to S=.5 L=.46
    const t = boot(() => makeBitmap(64, 64, (_x, y) => (y < 48 ? [255, 60, 60] : [60, 60, 255])));
    await sleep(30); // let the startup fetch settle
    upload(t.elements, { type: 'image/png', size: 123 });
    await sleep(500); // settle

    assert.strictEqual(t.fetchState.slotPosts, 1, 'empty portal mints a slot for the first upload');
    assert.strictEqual(t.fetchState.slotWpPosts.length, 1, 'wallpaper uploaded exactly once');
    assert.strictEqual(t.fetchState.slotWpPosts[0].type, 'image/png', 'image content type sent');
    assert.strictEqual(t.fetchState.slotWpPosts[0].accent, '#b03b3b', 'sampled accent sent with the upload');
    const st = t.fetchState.settings;
    assert.strictEqual(st.slots.length, 1, 'the slot holds the new wallpaper');
    assert.strictEqual(t.fetchState.slotWpPosts[0].slotId, st.slots[0].id, 'upload landed in the minted slot');
    const wp = st.slots[0].wallpapers[0];
    assert.strictEqual(wp.accent, '#b03b3b', 'entry keeps the re-normalized dominant red');
    assert.strictEqual(wp.accentTouched, true, 'accent marked decided on upload');
    assert.strictEqual(st.activeSlotId, st.slots[0].id, 'the slot holding the upload is active');
    const lastPut = t.fetchState.putBodies[t.fetchState.putBodies.length - 1];
    assert.strictEqual(lastPut.activeSlotId, st.slots[0].id, 'active slot persisted');

    const s = t.body.style.props;
    assert.strictEqual(s['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + wp.id + '")', 'background points at the wallpaper endpoint');
    assert.strictEqual(s['--accent'], '#b03b3b');
    const [h, sat, l] = refRgbHsl(176 / 255, 59 / 255, 59 / 255);
    assert.ok(Math.abs(h) < 1e-9, 'accent hue is red');
    assert.ok(Math.abs(l - 0.46) < 0.005, 'accent lightness re-normalized to 0.46');
    // The full derived family must match the reference HSL math at the
    // documented ratios (harness: bg .10 / panel .16 / input .21 / border .34).
    assert.strictEqual(s['--bg'], refHslHex(h, sat * .35, .10), 'background derived from accent');
    assert.strictEqual(s['--panel'], refHslHex(h, sat * .35, .16), 'panel derived from accent');
    assert.strictEqual(s['--panel-2'], refHslHex(h, sat * .35, .21), 'input surface derived from accent');
    assert.strictEqual(s['--line'], refHslHex(h, sat * .25, .34), 'border derived from accent');
    assert.strictEqual(s['--selftag-line'], refHslHex(h, sat * .45, .32), 'pill line derived from accent');
    // RGB-triple twins of the hex colors, for the alpha-variant CSS.
    assert.strictEqual(s['--panel-rgb'], hexTri(s['--panel']));
    assert.strictEqual(s['--panel-2-rgb'], hexTri(s['--panel-2']));
    assert.strictEqual(s['--header-a-rgb'], hexTri(refHslHex(h, sat * .35, .13)));
    assert.strictEqual(s['--header-b-rgb'], hexTri(refHslHex(h, sat * .35, .07)));
    assert.strictEqual(s['--head-rgb'], hexTri(refHslHex(h, sat * .35, .19)));
    assert.strictEqual(s['--hover-rgb'], hexTri(refHslHex(h, sat * .35, .24)));
    // Lightness steps apart, darkest first; text stays stock.
    assert.ok(relLum(s['--bg']) < relLum(s['--panel']) && relLum(s['--panel']) < relLum(s['--panel-2']) &&
      relLum(s['--panel-2']) < relLum(s['--line']), 'bg < panel < input < border lightness');
    assert.strictEqual(s['--text'], undefined, 'text color is left untouched');
    assert.ok('data-sp-theme' in t.body.attrs, 'themed flag set on body');
    // First and only slot, single wallpaper: neither nav button shows, the
    // counter reads 1 of 1, and the wallpaper gets a thumbnail in the slot.
    assert.ok(!t.elements.spNav.classList.contains('hidden'), 'nav row visible');
    assert.ok(t.elements.spPrev.classList.contains('hidden'), 'previous hidden on the first');
    assert.ok(t.elements.spNext.classList.contains('hidden'), 'next hidden on the last');
    assert.strictEqual(t.elements.spNavCount.textContent, '1 of 1');
    assert.ok(!t.elements.spThumbsWrap.classList.contains('hidden'), 'thumb strip shown for a non-empty slot');
    assert.strictEqual(t.elements.spThumbs.children.length, 1, 'one thumbnail for the slot wallpaper');
    console.log('  ok 1. red upload → slot minted, pick rolled for display, accent #b03b3b, palette applied and persisted');
  }

  /* ---------------- Scenario 2: blue-only wallpaper ---------------- */
  {
    const t = boot(() => makeBitmap(64, 64, () => [60, 60, 255]));
    await sleep(30);
    upload(t.elements, { type: 'image/jpeg', size: 123 });
    await sleep(500);
    const s = t.body.style.props;
    assert.strictEqual(s['--accent'], '#3b3bb0', 'blue-dominant image yields a blue accent (hsl 240 50% 46%)');
    assert.strictEqual(s['--bg'], refHslHex(240, 0.5 * .35, .10));
    console.log('  ok 2. blue-dominant upload → blue accent + blue-tinted surfaces');
  }

  /* ---------------- Scenario 3: hueless (gray) wallpaper ---------------- */
  {
    const t = boot(() => makeBitmap(64, 64, () => [128, 128, 128]));
    await sleep(30);
    upload(t.elements, { type: 'image/png', size: 123 });
    await sleep(500);
    const st = t.fetchState.settings;
    assert.strictEqual(st.slots.length, 1, 'gray wallpaper is still added to a slot');
    assert.strictEqual(st.slots[0].wallpapers.length, 1, 'the slot holds the wallpaper');
    assert.strictEqual(st.slots[0].wallpapers[0].accent, '', 'no usable hue → empty accent');
    assert.strictEqual(t.body.style.props['--accent'], undefined, 'theme variables cleared');
    assert.strictEqual(t.body.style.props['--bg'], undefined, 'bg variable cleared');
    assert.ok(!('data-sp-theme' in t.body.attrs), 'themed flag removed');
    assert.ok(t.elements.spResetColors.disabled, 'reset colors disabled for a hueless wallpaper');
    console.log('  ok 3. gray upload → wallpaper applied, stock palette kept');
  }

  /* ---------- Scenario 4: remove deletes the displayed wallpaper --------
     Deleting the only wallpaper of the only slot drains the slot, which is
     removed too — leaving no slots at all and a cleared theme. */
  {
    const t = boot(() => makeBitmap(64, 64, (_x, y) => (y < 48 ? [255, 60, 60] : [60, 60, 255])));
    await sleep(30);
    upload(t.elements, { type: 'image/png', size: 123 });
    await sleep(500);
    assert.strictEqual(t.body.style.props['--accent'], '#b03b3b', 'theme active after upload');
    const id = t.fetchState.settings.slots[0].wallpapers[0].id;
    click(t.elements, 'spRemove');
    await sleep(500);
    assert.deepStrictEqual(t.fetchState.deletes, [id], 'DELETE sent for the displayed wallpaper');
    assert.strictEqual(t.fetchState.deletesAll, 0, 'not the delete-all endpoint');
    assert.strictEqual(t.fetchState.slotDeletes.length, 0, 'slot removed by drain, not the slot endpoint');
    assert.strictEqual(t.fetchState.settings.slots.length, 0, 'drained slot removed, no slots left');
    assert.strictEqual(t.fetchState.settings.activeSlotId, null);
    assert.strictEqual(t.body.style.props['--sp-bg-image'], 'none', 'background cleared');
    assert.strictEqual(t.body.style.props['--bg'], undefined, 'stock palette restored');
    assert.ok(t.elements.spNav.classList.contains('hidden'), 'nav row hidden with no slots');
    assert.ok(t.elements.spThumbsWrap.classList.contains('hidden'), 'thumb strip hidden again');
    assert.strictEqual(t.fetchState.putBodies[t.fetchState.putBodies.length - 1].activeSlotId, null,
      'cleared pointer persisted');
    console.log('  ok 4. removing the displayed wallpaper drains and removes its slot, back to stock');
  }

  /* ---------- Scenario 5: legacy wallpaper gets its theme adopted ---------- */
  {
    // Server already holds a wallpaper whose accent was never decided
    // (uploaded before the auto color scheme existed).
    const legacyId = 'deadbeef-0000-4000-8000-000000000001';
    const t = boot(
      () => makeBitmap(64, 64, (_x, y) => (y < 48 ? [255, 60, 60] : [60, 60, 255])),
      { slots: [{ id: 'slot-legacy', wallpapers: [{ id: legacyId, type: 'image/png', imageDark: false, accent: '', accentTouched: false }] }],
        activeSlotId: 'slot-legacy' }
    );
    t.fetchState.blobs.set(legacyId, {}); // any object: createImageBitmap is stubbed
    await sleep(600); // startup fetch + wallpaper fetch + sample + meta PUT
    assert.strictEqual(t.fetchState.metaPuts.length, 1, 'exactly one adoption meta PUT');
    assert.strictEqual(t.fetchState.metaPuts[0].id, legacyId);
    assert.strictEqual(t.fetchState.metaPuts[0].body.accent, '#b03b3b', 'legacy wallpaper sampled and themed');
    assert.strictEqual(t.fetchState.metaPuts[0].body.accentTouched, true, 'marker stored so this never re-fires');
    assert.strictEqual(t.body.style.props['--accent'], '#b03b3b', 'theme live after adoption');
    console.log('  ok 5. pre-existing wallpaper adopts its theme on first load');
  }

  /* ---------- Scenario 6: reset colors keeps wallpaper, clears theme ---------- */
  {
    const t = boot(() => makeBitmap(64, 64, (_x, y) => (y < 48 ? [255, 60, 60] : [60, 60, 255])));
    await sleep(30);
    upload(t.elements, { type: 'image/png', size: 123 });
    await sleep(500);
    assert.strictEqual(t.body.style.props['--accent'], '#b03b3b', 'theme active after upload');
    click(t.elements, 'spResetColors');
    await sleep(500);
    assert.strictEqual(t.fetchState.metaPuts.length, 1, 'theme cleared via the wallpaper meta endpoint');
    assert.strictEqual(t.fetchState.metaPuts[0].body.accent, '', 'theme cleared');
    assert.strictEqual(t.fetchState.metaPuts[0].body.accentTouched, true, 'clearance marked deliberate');
    const st = t.fetchState.settings;
    assert.strictEqual(st.slots.length, 1, 'slot kept');
    assert.strictEqual(st.slots[0].wallpapers.length, 1, 'wallpaper kept');
    assert.strictEqual(st.slots[0].wallpapers[0].accentTouched, true, 'entry remembers the deliberate reset');
    assert.strictEqual(t.fetchState.deletes.length + t.fetchState.deletesAll, 0, 'no DELETE sent');
    assert.strictEqual(t.body.style.props['--bg'], undefined, 'stock palette restored');
    console.log('  ok 6. reset colors drops the theme, keeps the wallpaper');
  }

  /* ---- Scenario 7: a deliberately cleared theme is not re-adopted ---- */
  {
    const legacyId = 'deadbeef-0000-4000-8000-000000000002';
    const t = boot(
      () => makeBitmap(64, 64, (_x, y) => (y < 48 ? [255, 60, 60] : [60, 60, 255])),
      { slots: [{ id: 'slot-cleared', wallpapers: [{ id: legacyId, type: 'image/png', imageDark: false, accent: '', accentTouched: true }] }],
        activeSlotId: 'slot-cleared' }
    );
    t.fetchState.blobs.set(legacyId, {});
    await sleep(600);
    assert.strictEqual(t.fetchState.metaPuts.length, 0, 'no adoption for a touched accent');
    assert.strictEqual(t.body.style.props['--accent'], undefined, 'cleared theme stays cleared');
    console.log('  ok 7. deliberately cleared theme survives a page reload');
  }

  /* -------- Scenario 8: list-background opacity is live + saved -------- */
  {
    const t = boot(() => makeBitmap(1, 1, () => [128, 128, 128]), { surfaceAlpha: 0.42 });
    await sleep(30);
    assert.strictEqual(t.body.style.props['--sp-list-alpha'], '0.42', 'saved opacity applied to both list layouts');
    assert.strictEqual(t.elements.spListOpacity.value, '42', 'slider reflects saved opacity');
    assert.strictEqual(t.elements.spListOpacityOut.textContent, '42%', 'output reflects saved opacity');

    t.elements.spListOpacity.value = '35';
    const input = t.elements.spListOpacity.listeners.input;
    assert.ok(input && input.length, 'list opacity slider wired');
    input[0]();
    assert.strictEqual(t.body.style.props['--sp-list-alpha'], '0.35', 'dragging updates the list live');
    assert.strictEqual(t.elements.spListOpacityOut.textContent, '35%');
    await sleep(400);
    assert.strictEqual(t.fetchState.putBodies[t.fetchState.putBodies.length - 1].surfaceAlpha, 0.35,
      'list opacity persisted with appearance settings');
    console.log('  ok 8. list-background opacity applies live and persists');
  }

  /* ---------- Scenario 9: slot navigation re-rolls the pick ----------
     Two single-wallpaper slots: the stepper switches the active slot,
     re-rolls its displayed wallpaper (each slot's only wallpaper shows),
     the theme follows the displayed wallpaper, and the active slot is
     persisted immediately. */
  {
    const mkSlot = (id, accent) => ({
      id, wallpapers: [{ id: id + '-wp', type: 'image/png', imageDark: true, accent, accentTouched: true }]
    });
    const slotA = mkSlot('slot-a', '#b03b3b');
    const slotB = mkSlot('slot-b', '#3b3bb0');
    const t = boot(() => makeBitmap(1, 1, () => [128, 128, 128]),
      { slots: [slotA, slotB], activeSlotId: slotB.id });
    t.fetchState.blobs.set(slotA.wallpapers[0].id, {});
    t.fetchState.blobs.set(slotB.wallpapers[0].id, {});
    await sleep(30);
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + slotB.wallpapers[0].id + '")', 'boots onto the active slot pick');
    assert.strictEqual(t.body.style.props['--accent'], '#3b3bb0', 'theme follows the displayed wallpaper');
    assert.strictEqual(t.elements.spNavCount.textContent, '2 of 2');
    assert.ok(!t.elements.spPrev.classList.contains('hidden'), 'previous visible off the first');
    assert.ok(t.elements.spNext.classList.contains('hidden'), 'next hidden on the last');

    click(t.elements, 'spPrev');
    await sleep(400);
    assert.strictEqual(t.fetchState.settings.activeSlotId, slotA.id, 'previous moves to the previous slot');
    assert.strictEqual(t.body.style.props['--accent'], '#b03b3b', 'theme switched to the previous slot pick');
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + slotA.wallpapers[0].id + '")', 'background switched to the previous slot');
    assert.strictEqual(t.elements.spNavCount.textContent, '1 of 2');
    assert.ok(t.elements.spPrev.classList.contains('hidden'), 'previous hidden on the first');
    assert.ok(!t.elements.spNext.classList.contains('hidden'), 'next visible off the first');
    // The switch is a structural change: persisted immediately (no debounce).
    assert.strictEqual(t.fetchState.putBodies[t.fetchState.putBodies.length - 1].activeSlotId, slotA.id,
      'active slot persisted right away');

    click(t.elements, 'spNext');
    await sleep(400);
    assert.strictEqual(t.fetchState.settings.activeSlotId, slotB.id, 'next moves forward');
    assert.strictEqual(t.body.style.props['--accent'], '#3b3bb0', 'theme switched back to blue');
    assert.strictEqual(t.elements.spNavCount.textContent, '2 of 2');
    console.log('  ok 9. prev/next walks the slots, re-rolls the display, persists the active slot');
  }

  /* ---------- Scenario 10: thumbnail × removes one wallpaper ----------
     The × on a thumbnail removes just that wallpaper of the active slot;
     the slot survives its remaining wallpapers, the pointer stays put,
     and the strip re-renders without the removed item. */
  {
    const t = boot(() => makeBitmap(64, 64, () => [128, 128, 128]));
    await sleep(30);
    upload(t.elements, { type: 'image/png', size: 1 }, { type: 'image/png', size: 2 }, { type: 'image/png', size: 3 });
    await sleep(700);
    const st = t.fetchState.settings;
    assert.strictEqual(st.slots.length, 1, 'all three uploads share the single slot');
    assert.strictEqual(st.slots[0].wallpapers.length, 3, 'three wallpapers in the slot');
    const middle = st.slots[0].wallpapers[1].id;
    const keepA = st.slots[0].wallpapers[0].id;
    const keepC = st.slots[0].wallpapers[2].id;
    const items = t.elements.spThumbs.children;
    assert.strictEqual(items.length, 3, 'three thumbnails rendered');
    const del = items[1].children[1]; // each thumbnail: [img, × button]
    assert.strictEqual(del.className, 'sp-thumb-del', 'second child is the delete button');
    del.listeners.click[0]({ stopPropagation() {} });
    await sleep(500);
    assert.deepStrictEqual(t.fetchState.deletes, [middle], 'only the middle wallpaper was deleted');
    const st2 = t.fetchState.settings;
    assert.strictEqual(st2.slots.length, 1, 'the slot survives its remaining wallpapers');
    assert.deepStrictEqual(st2.slots[0].wallpapers.map((w) => w.id),
      [keepA, keepC], 'slot order closed the gap');
    assert.strictEqual(st2.activeSlotId, st.slots[0].id, 'pointer stayed on the slot');
    assert.strictEqual(t.elements.spThumbs.children.length, 2, 'strip re-rendered without the removed item');
    console.log('  ok 10. the thumbnail × removes one wallpaper of the slot and keeps the rest');
  }

  /* ---------- Scenario 11: multi-file upload fills the slot ---------- */
  {
    const t = boot(() => makeBitmap(64, 64, () => [128, 128, 128]));
    await sleep(30);
    upload(t.elements, { type: 'image/png', size: 1 }, { type: 'image/png', size: 2 });
    await sleep(700);
    assert.strictEqual(t.fetchState.slotPosts, 1, 'one slot minted for the whole batch');
    assert.strictEqual(t.fetchState.slotWpPosts.length, 2, 'each file uploaded exactly once');
    const st = t.fetchState.settings;
    assert.strictEqual(st.slots.length, 1, 'both files share the same slot');
    assert.strictEqual(st.slots[0].wallpapers.length, 2, 'both files became wallpapers');
    assert.strictEqual(st.activeSlotId, st.slots[0].id, 'the filled slot is active');
    assert.strictEqual(t.elements.spNavCount.textContent, '1 of 1');
    assert.strictEqual(t.elements.spThumbs.children.length, 2, 'both wallpapers get thumbnails');
    console.log('  ok 11. a multi-file upload lands every file in the active slot');
  }

  /* ---------- Scenario 12: real server — slot protocol ---------- */
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-appearance-test-'));
    const port = 18931;
    const proc = spawnServer(dataDir, port);
    const base = 'http://127.0.0.1:' + port;
    try {
      await waitUp(base);
      const get = async () => (await (await fetch(base + '/api/appearance')).json()).settings;
      const put = async (obj) => (await (await fetch(base + '/api/appearance', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj)
      })).json()).settings;
      const postSlot = async () => (await (await fetch(base + '/api/appearance/slots', { method: 'POST' })).json()).settings;
      const postSlotWp = async (slotId, bytes, extra) => (await (await fetch(
        base + '/api/appearance/slots/' + slotId + '/wallpapers', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'x-sp-image-dark': '0', 'x-sp-accent': '', ...(extra || {}) },
        body: bytes
      })).json()).wallpaper;

      let s = await get();
      assert.deepStrictEqual(s.slots, [], 'fresh server has no slots');
      assert.strictEqual(s.activeSlotId, null, 'fresh server has no active slot');

      // Origin point round-trip: free points persist, legacy anchor strings
      // migrate onto the grid, and out-of-range values are clamped.
      assert.deepStrictEqual(s.backgroundPosition, { x: 50, y: 50 }, 'fresh server defaults the origin to center');
      s = await put({ backgroundPosition: { x: 12, y: 88 } });
      assert.deepStrictEqual(s.backgroundPosition, { x: 12, y: 88 }, 'free origin point persists');
      s = await put({ backgroundPosition: 'bottom' });
      assert.deepStrictEqual(s.backgroundPosition, { x: 50, y: 100 }, 'legacy anchor string migrates server-side');
      s = await put({ backgroundPosition: { x: 400, y: -5 } });
      assert.deepStrictEqual(s.backgroundPosition, { x: 100, y: 0 }, 'out-of-range origin clamped to the crop');
      s = await put({ scrim: 0.3 });
      assert.deepStrictEqual(s.backgroundPosition, { x: 100, y: 0 }, 'origin survives a slider-only PUT');
      s = await put({ backgroundPosition: { x: 50, y: 50 } });

      s = await postSlot();
      assert.strictEqual(s.slots.length, 1, 'add-slot appends an empty slot');
      const slot1 = s.slots[0];
      assert.match(slot1.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'server mints a uuid slot id');
      assert.deepStrictEqual(slot1.wallpapers, [], 'the new slot is empty');
      assert.strictEqual(s.activeSlotId, slot1.id, 'add-slot activates the new slot');

      const a = await postSlotWp(slot1.id, Buffer.from('img-a'));
      s = await get();
      assert.strictEqual(s.slots.length, 1);
      assert.strictEqual(s.slots[0].wallpapers.length, 1, 'the slot holds the upload');
      assert.strictEqual(s.slots[0].wallpapers[0].id, a.id);
      assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'server mints a uuid wallpaper id');
      assert.strictEqual(s.activeSlotId, slot1.id, 'the upload keeps its slot active');

      const r = await fetch(base + '/api/appearance/wallpapers/' + a.id);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get('content-type'), 'image/png', 'stored content type served back');
      assert.strictEqual(Buffer.from(await r.arrayBuffer()).toString(), 'img-a', 'bytes round-trip');

      const b = await postSlotWp(slot1.id, Buffer.from('img-b'), { 'x-sp-accent': '#AB12CD', 'x-sp-image-dark': '1' });
      s = await get();
      assert.strictEqual(s.slots[0].wallpapers.length, 2, 'second upload appended to the same slot');
      const bEntry = s.slots[0].wallpapers.find((w) => w.id === b.id);
      assert.strictEqual(bEntry.accent, '#ab12cd', 'accent header stored and lowercased');
      assert.strictEqual(bEntry.imageDark, true, 'darkness header stored');
      assert.strictEqual(bEntry.accentTouched, true, 'server records the client-decided accent');

      s = await put({ activeSlotId: 'bogus', scrim: 0.1 });
      assert.strictEqual(s.activeSlotId, slot1.id, 'a bogus active slot is ignored');
      assert.strictEqual(s.scrim, 0.1, 'sliders still saved');

      const m = await (await fetch(base + '/api/appearance/wallpapers/' + b.id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accent: '', accentTouched: true })
      })).json();
      assert.strictEqual(m.wallpaper.accent, '', 'meta PUT clears the accent');
      assert.strictEqual(m.wallpaper.accentTouched, true, 'meta PUT records the deliberate reset');

      // Deleting a wallpaper that is not the slot's last leaves the slot.
      s = (await (await fetch(base + '/api/appearance/wallpapers/' + a.id, { method: 'DELETE' })).json()).settings;
      assert.strictEqual(s.slots.length, 1, 'slot survives a non-draining delete');
      assert.strictEqual(s.slots[0].wallpapers.length, 1, 'the other wallpaper stays');
      assert.strictEqual(s.activeSlotId, slot1.id, 'active slot untouched');
      assert.strictEqual((await fetch(base + '/api/appearance/wallpapers/' + a.id)).status, 404, 'deleted wallpaper 404s');

      // Legacy GET background serves the active slot's first wallpaper.
      const lg = await fetch(base + '/api/appearance/background');
      assert.strictEqual(Buffer.from(await lg.arrayBuffer()).toString(), 'img-b',
        'legacy endpoint serves the active slot first wallpaper');

      // Legacy POST wallpaper appends to the active slot (no new slot).
      const c = (await (await fetch(base + '/api/appearance/wallpapers', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'x-sp-image-dark': '0', 'x-sp-accent': '' },
        body: Buffer.from('img-c')
      })).json()).wallpaper;
      s = await get();
      assert.strictEqual(s.slots.length, 1, 'legacy upload did not mint a slot');
      assert.strictEqual(s.slots[0].wallpapers.length, 2, 'legacy upload appended to the active slot');
      assert.strictEqual(s.slots[0].wallpapers.find((w) => w.id === c.id).type, 'image/png');

      // Legacy POST background replaces the active slot first wallpaper in
      // place (same id, new bytes) — not an append.
      const bg = (await (await fetch(base + '/api/appearance/background', {
        method: 'POST',
        headers: { 'Content-Type': 'image/webp', 'x-sp-image-dark': '1', 'x-sp-accent': '' },
        body: Buffer.from('bg-bytes')
      })).json()).settings;
      assert.strictEqual(bg.slots.length, 1, 'background replace did not add a slot');
      assert.strictEqual(bg.slots[0].wallpapers.length, 2, 'background replace did not add a wallpaper');
      assert.strictEqual(bg.slots[0].wallpapers[0].type, 'image/webp', 'in-place replace carried the new MIME');
      assert.strictEqual(bg.slots[0].wallpapers[1].id, c.id, 'the other slot wallpaper was left alone');
      const bgAgain = await fetch(base + '/api/appearance/background');
      assert.strictEqual(Buffer.from(await bgAgain.arrayBuffer()).toString(), 'bg-bytes', 'replace is served back');

      // DELETE slot <id>: removes the slot and all its wallpapers; the
      // active slot falls back to the previous slot.
      s = await postSlot(); // slot2 (empty), now active
      const slot2 = s.slots[1];
      await postSlotWp(slot2.id, Buffer.from('img-d'));
      s = (await (await fetch(base + '/api/appearance/slots/' + slot2.id, { method: 'DELETE' })).json()).settings;
      assert.strictEqual(s.slots.length, 1, 'delete-slot removes the slot');
      assert.strictEqual(s.activeSlotId, slot1.id, 'active falls back to the previous slot');
      assert.strictEqual((await fetch(base + '/api/appearance/wallpapers/' + slot2.id, { method: 'GET' })).status, 404);

      s = (await (await fetch(base + '/api/appearance/wallpapers', { method: 'DELETE' })).json()).settings;
      assert.deepStrictEqual(s.slots, [], 'delete-all empties the slots');
      assert.strictEqual(s.activeSlotId, null);
      assert.strictEqual((await fetch(base + '/api/appearance/background')).status, 404,
        'legacy endpoint 404s with no wallpaper');
      assert.strictEqual(
        (await fetch(base + '/api/appearance/wallpapers/00000000-0000-4000-0000-000000000000', { method: 'DELETE' })).status,
        404, 'unknown wallpaper 404s');
      console.log('  ok 12. real server: slot add/upload/switch/delete + legacy wallpaper protocol');
    } finally {
      proc.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  /* ---------- Scenario 13: real server — legacy background.bin migration ---------- */
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-appearance-migrate-'));
    fs.writeFileSync(path.join(dataDir, 'background.bin'), Buffer.from('legacy-bytes'));
    fs.writeFileSync(path.join(dataDir, 'background.json'), JSON.stringify({ type: 'image/webp' }));
    fs.writeFileSync(path.join(dataDir, 'appearance.json'), JSON.stringify({
      backgroundImage: 'server', imageDark: true, accent: '#AB12CD', accentTouched: true, scrim: 0.5
    }));
    const port = 18932;
    const proc = spawnServer(dataDir, port);
    const base = 'http://127.0.0.1:' + port;
    try {
      await waitUp(base);
      const s = (await (await fetch(base + '/api/appearance')).json()).settings;
      assert.strictEqual(s.slots.length, 1, 'legacy wallpaper migrated into its own slot');
      assert.strictEqual(s.slots[0].wallpapers.length, 1);
      assert.strictEqual(s.slots[0].wallpapers[0].type, 'image/webp', 'legacy MIME type carried over');
      assert.strictEqual(s.slots[0].wallpapers[0].imageDark, true, 'legacy darkness carried over');
      assert.strictEqual(s.slots[0].wallpapers[0].accent, '#ab12cd', 'legacy sampled accent carried over');
      assert.strictEqual(s.slots[0].wallpapers[0].accentTouched, true, 'legacy touched marker carried over');
      assert.strictEqual(s.activeSlotId, s.slots[0].id, 'migrated slot is active');
      assert.strictEqual(s.scrim, 0.5, 'global sliders carried over');
      const r = await fetch(base + '/api/appearance/wallpapers/' + s.slots[0].wallpapers[0].id);
      assert.strictEqual(Buffer.from(await r.arrayBuffer()).toString(), 'legacy-bytes', 'legacy image bytes served');
      assert.ok(!fs.existsSync(path.join(dataDir, 'background.bin')), 'legacy file consumed');
      console.log('  ok 13. real server: legacy background.bin migrates into a slot on boot');
    } finally {
      proc.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  /* ---- Scenario 14: header stepper — walks the slots, dims at the ends,
     no-op on empty. The header arrows stay mounted at all times; only
     their disabled state tracks the active slot. ---- */
  {
    const mk = (id, accent) => ({
      id, wallpapers: [{ id: id + '-wp', type: 'image/png', imageDark: true, accent, accentTouched: true }]
    });
    const slots = [
      mk('11111111-1111-4111-8111-111111111111', '#b03b3b'),
      mk('22222222-2222-4222-8222-222222222222', '#3b3bb0'),
      mk('33333333-3333-4333-8333-333333333333', '#3bb05e')
    ];
    const t = boot(() => makeBitmap(1, 1, () => [128, 128, 128]),
      { slots, activeSlotId: slots[1].id });
    await sleep(30); // let the startup fetch settle
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + slots[1].wallpapers[0].id + '")', 'boots on the middle slot pick');
    assert.ok(!t.elements.bgPrev.disabled, 'header previous enabled in the middle');
    assert.ok(!t.elements.bgNext.disabled, 'header next enabled in the middle');

    click(t.elements, 'bgPrev');
    await sleep(400);
    assert.strictEqual(t.fetchState.settings.activeSlotId, slots[0].id, 'header previous steps back a slot');
    assert.strictEqual(t.body.style.props['--accent'], '#b03b3b', 'theme follows the header step');
    assert.ok(t.elements.bgPrev.disabled, 'header previous dimmed on the first');
    assert.ok(!t.elements.bgNext.disabled, 'header next still enabled on the first');
    assert.strictEqual(t.fetchState.putBodies[t.fetchState.putBodies.length - 1].activeSlotId, slots[0].id,
      'header step persisted immediately');

    click(t.elements, 'bgNext');
    await sleep(400);
    click(t.elements, 'bgNext');
    await sleep(400);
    assert.strictEqual(t.fetchState.settings.activeSlotId, slots[2].id, 'header next steps forward to the last');
    assert.ok(!t.elements.bgPrev.disabled, 'header previous enabled off the last');
    assert.ok(t.elements.bgNext.disabled, 'header next dimmed on the last');

    // No slots: both arrows stay mounted and dimmed, and clicking a dimmed
    // arrow changes nothing.
    const t2 = boot(() => makeBitmap(1, 1, () => [128, 128, 128]));
    await sleep(30);
    assert.ok(t2.elements.bgPrev.disabled, 'header previous dimmed with no slots');
    assert.ok(t2.elements.bgNext.disabled, 'header next dimmed with no slots');
    click(t2.elements, 'bgNext');
    await sleep(300);
    assert.strictEqual(t2.fetchState.settings.activeSlotId, null, 'clicking a dimmed arrow changes nothing');
    console.log('  ok 14. header arrows walk the slots and dim at the ends (and when empty)');
  }

  /* ---------- Scenario 15: position — per wallpaper, per client ---------
     The position is a (x, y) origin point on 0–100 per axis, stored in
     localStorage per wallpaper id and never sent to the server. A one-time
     migration hands the legacy global value to every wallpaper in every
     slot, each wallpaper keeps its own origin when you switch slots, the
     sliders keep their magnetic snap + hysteresis, and the controls dim
     when no wallpaper is displayed (pruning the map with it). */
  {
    const mkSlot = (slotId, wpId) => ({
      id: slotId, wallpapers: [{ id: wpId, type: 'image/png', imageDark: false, accent: '', accentTouched: true }]
    });
    const slot1 = mkSlot('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111112');
    const slot2 = mkSlot('22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222223');
    const wps = [slot1.wallpapers[0], slot2.wallpapers[0]];
    const t = boot(() => makeBitmap(1, 1, () => [128, 128, 128]),
      { slots: [slot1, slot2], activeSlotId: slot2.id, backgroundPosition: 'top' });
    await sleep(30); // let the startup fetch settle
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '50% 0%',
      'the legacy global "top" migrates onto the active wallpaper');
    let map = JSON.parse(t.localStorage.getItem('sp-wallpaper-positions'));
    assert.deepStrictEqual(map[wps[0].id], { x: 50, y: 0 }, 'the other slot wallpaper was migrated too');
    assert.strictEqual(t.localStorage.getItem('sp-wallpaper-positions-migrated'), '1', 'the migration is one-shot');
    assert.strictEqual(t.elements.spPosX.value, '50', 'horizontal slider reflects the migrated origin');
    assert.strictEqual(t.elements.spPosY.value, '0', 'vertical slider reflects the migrated origin');
    assert.strictEqual(t.elements['spPos-tc'].attrs['aria-pressed'], 'true', 'top-center cell pressed');
    assert.ok(!t.elements.spPosX.disabled, 'controls enabled while a wallpaper is active');

    click(t.elements, 'spPos-br');
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '100% 100%', 'corner anchor applied live');
    map = JSON.parse(t.localStorage.getItem('sp-wallpaper-positions'));
    assert.deepStrictEqual(map[wps[1].id], { x: 100, y: 100 }, 'the active wallpaper stores its origin locally');
    assert.deepStrictEqual(map[wps[0].id], { x: 50, y: 0 }, 'the other wallpaper is untouched');

    // A settings PUT (driven by any slider) no longer carries the position.
    const oIn = t.elements.spOpacity.listeners.input;
    t.elements.spOpacity.value = '90';
    oIn[0]();
    await sleep(400);
    const lastPut = t.fetchState.putBodies[t.fetchState.putBodies.length - 1];
    assert.ok('backgroundOpacity' in lastPut && !('backgroundPosition' in lastPut),
      'the position no longer rides the settings PUT');
    t.elements.spOpacity.value = '100';
    oIn[0]();

    // The sliders carry the free offset, with the magnetic snap + hysteresis.
    const yIn = t.elements.spPosY.listeners.input;
    t.elements.spPosY.value = '63';
    yIn[0]();
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '100% 63%', 'off-detent offset applied live');
    t.elements.spPosY.value = '53';
    yIn[0]();
    assert.strictEqual(t.elements.spPosY.value, '50', 'magnetized onto the detent');
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '100% 50%', 'snapped onto the right-edge anchor');
    t.elements.spPosY.value = '49';
    yIn[0]();
    assert.strictEqual(t.elements.spPosY.value, '49', 'can step out of a detent one step at a time');
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '100% 49%', 'free value held next to the anchor');

    // Switching slot switches the origin with it (each wallpaper's own).
    click(t.elements, 'spPrev');
    await sleep(400);
    assert.strictEqual(t.fetchState.settings.activeSlotId, slot1.id, 'previous moved to the other slot');
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '50% 0%', 'the previous slot wallpaper keeps its own origin');
    assert.strictEqual(t.elements['spPos-tc'].attrs['aria-pressed'], 'true', 'its own anchor is pressed');

    // Keyboard anchor: numpad 7 jumps to top-left.
    const kd = t.elements.spPosGrid.listeners.keydown;
    kd[0]({ key: '7', preventDefault() {} });
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '0% 0%', 'numpad 7 jumps to top-left');
    map = JSON.parse(t.localStorage.getItem('sp-wallpaper-positions'));
    assert.deepStrictEqual(map[wps[0].id], { x: 0, y: 0 }, 'the keyboard anchor lands in the local map');

    // Removing the displayed wallpaper: it drains its slot (auto-removed),
    // the pointer falls back to the other slot, whose wallpaper keeps its
    // own origin. Removing the last one dims the controls and prunes the
    // map.
    click(t.elements, 'spRemove');
    await sleep(400); // removes wps[0] → slot1 drained → slot2 active again
    assert.strictEqual(t.fetchState.settings.slots.length, 1, 'the drained slot was removed');
    assert.strictEqual(t.fetchState.settings.activeSlotId, slot2.id, 'pointer fell back to the previous slot');
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '100% 49%', 'the surviving wallpaper keeps its own origin');
    click(t.elements, 'spRemove');
    await sleep(400); // removes wps[1]; no slots left
    assert.strictEqual(t.fetchState.settings.slots.length, 0, 'no slots left');
    assert.strictEqual(t.fetchState.settings.activeSlotId, null, 'no active slot');
    assert.ok(t.elements.spPosX.disabled, 'horizontal slider disabled with no wallpaper');
    assert.ok(t.elements.spPosY.disabled, 'vertical slider disabled with no wallpaper');
    assert.ok(t.elements['spPos-tl'].disabled, 'the grid is disabled with no wallpaper');
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '50% 50%', 'the origin falls back to center');
    map = JSON.parse(t.localStorage.getItem('sp-wallpaper-positions'));
    assert.deepStrictEqual(map, {}, 'orphaned positions are pruned');
    console.log('  ok 15. position: per-wallpaper and per-client (local map, one-time migration)');
  }

  /* ---------- Scenario 16: the migration is not fooled by stale cache ----
     A pre-rollout local cache (old flat wallpaper list + the old global
     position) must not burn the one-time migration flag before the
     server's real collection is seen. */
  {
    const oldId = '99999999-9999-4999-8999-999999999999';
    const newId = '33333333-3333-4333-8333-333333333333';
    const staleCache = {
      wallpapers: [{ id: oldId, type: 'image/png', imageDark: false, accent: '', accentTouched: true }],
      activeWallpaperId: oldId,
      backgroundPosition: { x: 50, y: 0 },
      backgroundOpacity: 1, backgroundBlur: 0, scrim: 0, surfaceAlpha: 1, glassBlur: 0
    };
    const t = boot(
      () => makeBitmap(1, 1, () => [128, 128, 128]),
      { slots: [{ id: 'slot-fresh', wallpapers: [{ id: newId, type: 'image/png', imageDark: false, accent: '', accentTouched: true }] }],
        activeSlotId: 'slot-fresh', backgroundPosition: { x: 100, y: 100 } },
      { 'sp-appearance': JSON.stringify(staleCache) }
    );
    await sleep(30); // let the startup fetch settle
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '100% 100%',
      'the server-side value wins the migration');
    const map = JSON.parse(t.localStorage.getItem('sp-wallpaper-positions'));
    assert.deepStrictEqual(map[newId], { x: 100, y: 100 }, 'the real wallpaper got the legacy origin');
    assert.strictEqual(map[oldId], undefined, 'the stale cache id was not seeded');
    assert.strictEqual(t.localStorage.getItem('sp-wallpaper-positions-migrated'), '1',
      'migration flagged only once the server state was seen');
    console.log('  ok 16. one-time migration ignores a stale local cache');
  }

  /* ---------- Scenario 17: the roll is a uniform pick, re-rolled per slot
     With a seeded RNG the exact pick is predictable: every slot navigation
     draws a fresh uniform wallpaper of the newly active slot, independently
     of the previous slot's pick. */
  {
    const seed = 777;
    const rng = lcg(seed);
    const pick = (n) => Math.floor(rng() * n);
    const mkWp = (id, accent) => ({ id, type: 'image/png', imageDark: true, accent, accentTouched: true });
    const slotA = { id: 'slot-a', wallpapers: [
      mkWp('a1', '#b03b3b'), mkWp('a2', '#3b3bb0'), mkWp('a3', '#3bb05e')
    ] };
    const slotB = { id: 'slot-b', wallpapers: [
      mkWp('b1', '#b0b03b'), mkWp('b2', '#b03bb0')
    ] };
    const t = boot(() => makeBitmap(1, 1, () => [128, 128, 128]),
      { slots: [slotA, slotB], activeSlotId: slotA.id }, undefined, seed);
    t.fetchState.blobs.set('a1', {}); t.fetchState.blobs.set('a2', {}); t.fetchState.blobs.set('a3', {});
    t.fetchState.blobs.set('b1', {}); t.fetchState.blobs.set('b2', {});
    await sleep(30);

    // Startup roll: one uniform draw from slot A's three wallpapers.
    const firstPick = pick(slotA.wallpapers.length);
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + slotA.wallpapers[firstPick].id + '")',
      'the startup roll picked the seeded wallpaper of the active slot');
    assert.strictEqual(t.body.style.props['--accent'], slotA.wallpapers[firstPick].accent,
      'the theme follows the rolled pick');

    // Next slot: a fresh independent draw from slot B's two wallpapers.
    click(t.elements, 'spNext');
    await sleep(400);
    const secondPick = pick(slotB.wallpapers.length);
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + slotB.wallpapers[secondPick].id + '")',
      'navigating to a slot re-rolls one of its wallpapers');
    assert.strictEqual(t.body.style.props['--accent'], slotB.wallpapers[secondPick].accent);
    assert.ok(t.elements.spThumbsWrap.classList.contains('hidden') === false, 'thumb strip shows the new slot wallpapers');
    assert.strictEqual(t.elements.spThumbs.children.length, slotB.wallpapers.length, 'strip holds the new slot wallpapers');

    // Back to slot A: yet another fresh draw — it may repeat, it is not
    // memory of the first visit.
    click(t.elements, 'spPrev');
    await sleep(400);
    const thirdPick = pick(slotA.wallpapers.length);
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + slotA.wallpapers[thirdPick].id + '")',
      'returning to a slot draws again, independently of the first visit');
    console.log('  ok 17. the displayed wallpaper is a seeded-uniform roll, re-drawn on every slot switch');
  }

  /* ---------- Scenario 18: Add / Remove slot buttons ---------- */
  {
    const t = boot(() => makeBitmap(64, 64, () => [255, 60, 60]));
    await sleep(30);
    assert.ok(t.elements.spRemoveSlot.disabled, 'remove slot dimmed with no slot');
    assert.ok(t.elements.spReset.disabled, 'reset dimmed while default');

    // Add slot → one empty slot, active; nothing to display yet.
    click(t.elements, 'spAddSlot');
    await sleep(400);
    let st = t.fetchState.settings;
    assert.strictEqual(t.fetchState.slotPosts, 1, 'add-slot called the create endpoint once');
    assert.strictEqual(st.slots.length, 1, 'one empty slot appended');
    assert.strictEqual(st.activeSlotId, st.slots[0].id, 'the new slot is active');
    const bgImg = t.body.style.props['--sp-bg-image'];
    assert.ok(!bgImg || bgImg === 'none', 'an empty slot displays no wallpaper');
    assert.ok(t.elements.spThumbsWrap.classList.contains('hidden'), 'thumb strip hidden for an empty slot');
    assert.ok(t.elements.spRemove.disabled, 'remove wallpaper dimmed for an empty slot');
    assert.ok(!t.elements.spRemoveSlot.disabled, 'remove slot enabled now that a slot exists');
    assert.strictEqual(t.elements.spNavCount.textContent, '1 of 1');

    // Upload into the active slot.
    upload(t.elements, { type: 'image/png', size: 1 });
    await sleep(500);
    st = t.fetchState.settings;
    assert.strictEqual(st.slots.length, 1, 'the upload did not mint a second slot');
    assert.strictEqual(st.slots[0].wallpapers.length, 1, 'the upload filled the active slot');

    // Add a second slot → jump to it; it is empty, so nothing shows.
    click(t.elements, 'spAddSlot');
    await sleep(400);
    st = t.fetchState.settings;
    assert.strictEqual(st.slots.length, 2, 'second slot appended');
    assert.strictEqual(st.activeSlotId, st.slots[1].id, 'the second slot is active');
    assert.strictEqual(t.body.style.props['--sp-bg-image'], 'none', 'jumping to an empty slot clears the image');
    assert.strictEqual(t.elements.spNavCount.textContent, '2 of 2');

    // Remove slot → the active (second) slot and its wallpapers are gone;
    // the pointer lands on the previous slot with its wallpaper intact.
    click(t.elements, 'spRemoveSlot');
    await sleep(400);
    st = t.fetchState.settings;
    assert.deepStrictEqual(t.fetchState.slotDeletes, ['slot-02'], 'remove-slot deleted the active slot');
    assert.strictEqual(st.slots.length, 1, 'the other slot survived');
    assert.strictEqual(st.activeSlotId, 'slot-01', 'pointer moved to the previous slot');
    assert.strictEqual(st.slots[0].wallpapers.length, 1, 'the previous slot wallpaper survived');
    assert.notStrictEqual(t.body.style.props['--sp-bg-image'], 'none', 'the surviving slot wallpaper is displayed');
    assert.strictEqual(t.elements.spNavCount.textContent, '1 of 1');
    console.log('  ok 18. Add slot / Remove slot manage the collection and move the pointer');
  }

  /* ---------- Scenario 19: deleting a slot's last wallpaper auto-removes
     the slot and lands the pointer on the previous one. */
  {
    const mkSlot = (id, accent) => ({
      id, wallpapers: [{ id: id + '-wp', type: 'image/png', imageDark: true, accent, accentTouched: true }]
    });
    const slotA = mkSlot('slot-a', '#b03b3b');
    const slotB = mkSlot('slot-b', '#3b3bb0');
    const t = boot(() => makeBitmap(1, 1, () => [128, 128, 128]),
      { slots: [slotA, slotB], activeSlotId: slotB.id });
    await sleep(30);
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + slotB.wallpapers[0].id + '")', 'boots on the second slot pick');

    click(t.elements, 'spRemove'); // deletes slot B's only wallpaper
    await sleep(500);
    const st = t.fetchState.settings;
    assert.deepStrictEqual(t.fetchState.deletes, [slotB.wallpapers[0].id], 'the displayed wallpaper was deleted');
    assert.strictEqual(st.slots.length, 1, 'the drained slot was auto-removed');
    assert.strictEqual(st.activeSlotId, slotA.id, 'the pointer landed on the previous slot');
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + slotA.wallpapers[0].id + '")', 'the previous slot wallpaper is now displayed');
    assert.strictEqual(t.body.style.props['--accent'], '#b03b3b', 'the theme follows the fallback pick');
    assert.strictEqual(t.elements.spNavCount.textContent, '1 of 1');
    assert.ok(t.elements.spPrev.classList.contains('hidden'), 'previous dimmed on the (new) first slot');
    console.log('  ok 19. removing a slot last wallpaper auto-removes the slot and falls back to the previous one');
  }

  /* ---------- Scenario 20: real server — old flat appearance.json -------
     A pre-slot deployment stored a flat wallpaper array; on boot it must
     migrate so each wallpaper becomes its own slot, and the old active
     wallpaper's slot becomes active. */
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-appearance-flat-'));
    fs.mkdirSync(path.join(dataDir, 'wallpapers'));
    const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    fs.writeFileSync(path.join(dataDir, 'wallpapers', idA), Buffer.from('flat-a'));
    fs.writeFileSync(path.join(dataDir, 'wallpapers', idB), Buffer.from('flat-b'));
    fs.writeFileSync(path.join(dataDir, 'appearance.json'), JSON.stringify({
      wallpapers: [
        { id: idA, type: 'image/png', imageDark: false, accent: '#b03b3b', accentTouched: true },
        { id: idB, type: 'image/jpeg', imageDark: true, accent: '', accentTouched: false }
      ],
      activeWallpaperId: idB,
      scrim: 0.25
    }));
    const port = 18933;
    const proc = spawnServer(dataDir, port);
    const base = 'http://127.0.0.1:' + port;
    try {
      await waitUp(base);
      const s = (await (await fetch(base + '/api/appearance')).json()).settings;
      assert.strictEqual(s.slots.length, 2, 'each flat wallpaper became its own slot');
      assert.strictEqual(s.slots[0].wallpapers[0].id, idA, 'slot order preserved');
      assert.strictEqual(s.slots[1].wallpapers[0].id, idB);
      assert.strictEqual(s.activeSlotId, s.slots[1].id, 'the old active wallpaper slot is active');
      assert.strictEqual(s.scrim, 0.25, 'global sliders survived the migration');
      const r = await fetch(base + '/api/appearance/wallpapers/' + idA);
      assert.strictEqual(Buffer.from(await r.arrayBuffer()).toString(), 'flat-a', 'migrated wallpaper bytes served');
      console.log('  ok 20. real server: a flat appearance.json migrates to one-slot-per-wallpaper on boot');
    } finally {
      proc.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  /* ---------- Scenario 21: Move slot buttons reorder the navigation ---------- */
  {
    // A fresh boot (no slots) dims both move buttons.
    const t0 = boot(() => makeBitmap(1, 1, () => [128, 128, 128]));
    await sleep(30);
    assert.ok(t0.elements.spMoveUp.disabled, 'move up dimmed with no slot');
    assert.ok(t0.elements.spMoveDown.disabled, 'move down dimmed with no slot');

    // Three slots, active in the middle. Seeded so the startup roll is
    // known: draw1 of seed 777 lands on b2 of slot B's three wallpapers —
    // any accidental re-roll on a move would draw again (draw2 → b3).
    const seed = 777;
    const rng = lcg(seed);
    const pick = (n) => Math.floor(rng() * n);
    const mkWp = (id, accent) => ({ id, type: 'image/png', imageDark: true, accent, accentTouched: true });
    const slotA = { id: 'slot-a', wallpapers: [mkWp('a1', '#b03b3b')] };
    const slotB = { id: 'slot-b', wallpapers: [
      mkWp('b1', '#b0b03b'), mkWp('b2', '#b03bb0'), mkWp('b3', '#3bb05e')
    ] };
    const slotC = { id: 'slot-c', wallpapers: [mkWp('c1', '#3b54b0')] };
    const t = boot(() => makeBitmap(1, 1, () => [128, 128, 128]),
      { slots: [slotA, slotB, slotC], activeSlotId: slotB.id }, undefined, seed);
    t.fetchState.blobs.set('a1', {}); t.fetchState.blobs.set('b1', {}); t.fetchState.blobs.set('b2', {});
    t.fetchState.blobs.set('b3', {}); t.fetchState.blobs.set('c1', {});
    await sleep(30);

    const startupPick = pick(slotB.wallpapers.length);
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + slotB.wallpapers[startupPick].id + '")',
      'the startup roll of the active (middle) slot');
    assert.ok(!t.elements.spMoveUp.disabled, 'move up enabled in the middle');
    assert.ok(!t.elements.spMoveDown.disabled, 'move down enabled in the middle');
    assert.strictEqual(t.elements.spNavCount.textContent, '2 of 3');

    // Move right: B travels after C. The pointer follows B by id and the
    // displayed pick survives — a re-roll would have drawn b3 instead.
    click(t.elements, 'spMoveDown');
    await sleep(400);
    assert.deepStrictEqual(t.fetchState.slotMoves, [{ slotId: 'slot-b', delta: 1 }],
      'the move endpoint was called for the active slot');
    let st = t.fetchState.settings;
    assert.deepStrictEqual(st.slots.map((s) => s.id), ['slot-a', 'slot-c', 'slot-b'],
      'B moved one position later, the others kept their relative order');
    assert.strictEqual(st.activeSlotId, 'slot-b', 'the active pointer rides along by id');
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + slotB.wallpapers[startupPick].id + '")',
      'the displayed pick survives the move (no re-roll)');
    assert.strictEqual(t.body.style.props['--accent'], slotB.wallpapers[startupPick].accent);
    assert.strictEqual(t.elements.spNavCount.textContent, '3 of 3');
    assert.ok(t.elements.spMoveDown.disabled, 'move down dimmed at the end');
    assert.ok(!t.elements.spMoveUp.disabled, 'move up still available');
    assert.strictEqual(t.elements.spThumbs.children.length, 3, 'B travels with its wallpapers');

    // Move left twice: B walks back to the front.
    click(t.elements, 'spMoveUp');
    await sleep(400);
    assert.deepStrictEqual(t.fetchState.settings.slots.map((s) => s.id),
      ['slot-a', 'slot-b', 'slot-c'], 'B back in the middle');
    click(t.elements, 'spMoveUp');
    await sleep(400);
    st = t.fetchState.settings;
    assert.deepStrictEqual(st.slots.map((s) => s.id), ['slot-b', 'slot-a', 'slot-c'],
      'B back at the front');
    assert.deepStrictEqual(t.fetchState.slotMoves.map((m) => m.delta), [1, -1, -1]);
    assert.strictEqual(t.elements.spNavCount.textContent, '1 of 3');
    assert.ok(t.elements.spMoveUp.disabled, 'move up dimmed at the front');
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + slotB.wallpapers[startupPick].id + '")',
      'the pick is stable across the whole walk');
    console.log('  ok 21. move slot buttons reorder the navigation; the pointer and pick ride along');
  }

  /* ---------- Scenario 22: real server: slot move semantics ---------- */
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-appearance-move-'));
    const port = 18934;
    const proc = spawnServer(dataDir, port);
    const base = 'http://127.0.0.1:' + port;
    try {
      await waitUp(base);
      const postSlot = async () => (await (await fetch(base + '/api/appearance/slots', { method: 'POST' })).json()).slot.id;
      const sA = await postSlot();
      const sB = await postSlot();
      const sC = await postSlot();
      const move = (id, delta) => fetch(base + '/api/appearance/slots/' + id + '/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta })
      });
      const ids = (s) => s.slots.map((x) => x.id);

      // C is active (last created). Two left steps walk it to the front.
      assert.strictEqual((await (await fetch(base + '/api/appearance')).json()).settings.activeSlotId, sC);
      let r = await move(sC, -1);
      assert.strictEqual(r.status, 200);
      let s = (await r.json()).settings;
      assert.deepStrictEqual(ids(s), [sA, sC, sB], 'C swapped with its left neighbor');
      assert.strictEqual(s.activeSlotId, sC, 'the active pointer follows the moved slot');
      r = await move(sC, -1);
      assert.strictEqual(r.status, 200);
      s = (await r.json()).settings;
      assert.deepStrictEqual(ids(s), [sC, sA, sB], 'C walked to the front');
      r = await move(sC, -1);
      assert.strictEqual(r.status, 422, 'C is already at the front');

      // A (middle) moves to the end, then is refused again.
      r = await move(sA, 1);
      assert.strictEqual(r.status, 200);
      s = (await r.json()).settings;
      assert.deepStrictEqual(ids(s), [sC, sB, sA], 'A moved to the end');
      r = await move(sA, 1);
      assert.strictEqual(r.status, 422, 'A is already at the end');

      // Validation: unknown slot 404, bad delta 400, wrong method 405.
      r = await move('00000000-0000-4000-8000-000000000000', -1);
      assert.strictEqual(r.status, 404, 'unknown slot is a 404');
      r = await move(sB, 0);
      assert.strictEqual(r.status, 400, 'delta 0 is a 400');
      r = await move(sB, 2);
      assert.strictEqual(r.status, 400, 'delta 2 is a 400');
      r = await fetch(base + '/api/appearance/slots/' + sB + '/move');
      assert.strictEqual(r.status, 405, 'GET on the move route is a 405');

      // The reorder is persisted and survives a settings PUT.
      const after = (await (await fetch(base + '/api/appearance')).json()).settings;
      assert.deepStrictEqual(ids(after), [sC, sB, sA], 'the reorder is on disk');
      r = await fetch(base + '/api/appearance', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scrim: 0.3, activeSlotId: sB })
      });
      assert.strictEqual(r.status, 200);
      s = (await r.json()).settings;
      assert.deepStrictEqual(ids(s), [sC, sB, sA], 'a PUT does not disturb the order');
      assert.strictEqual(s.activeSlotId, sB, 'the PUT can still steer the pointer by id');
      console.log('  ok 22. real server: slot move reorders, rides the pointer, and validates');
    } finally {
      proc.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  console.log('all appearance tests passed');
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
