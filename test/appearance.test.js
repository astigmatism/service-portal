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
// The appearance IIFE ends right before the power-panel block that follows it.
const powerMarker = html.indexOf('/* ---- Power / efficiency panel');
const fnEnd = html.lastIndexOf('})();', powerMarker === -1 ? html.length : powerMarker);
assert.ok(fnStart !== -1 && fnEnd > fnStart, 'appearance IIFE bounds not found');
const code = html.slice(fnStart, fnEnd + '})();'.length);

/* ------------------------------------------------------------------ */
/* Minimal DOM / canvas / fetch stubs.                                */
/* ------------------------------------------------------------------ */
function mkStyle() {
  const props = {};
  const writes = [];
  return {
    props, writes,
    setProperty: (k, v) => { props[k] = String(v); writes.push(k); },
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
    contains: (c) => set.has(c),
    toString: () => [...set].join(' '),
    set: (value) => { set.clear(); String(value).split(/\s+/).filter(Boolean).forEach((c) => set.add(c)); }
  };
}
/* Which stub element last received focus() (reset on every boot) — the
   header slot menu moves real focus between its items. */
const FOCUS = { last: null };
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
  Object.defineProperty(el, 'className', {
    get: () => el.classList.toString(), set: (v) => el.classList.set(v)
  });
  let _src;
  el.srcWrites = 0;
  Object.defineProperty(el, 'src', {
    get: () => _src, set: (v) => { _src = v; el.srcWrites++; }
  });
  Object.defineProperty(el, 'textContent', {
    get: () => _text,
    /* Real DOM: clearing textContent empties the element's children. */
    set: (v) => { _text = String(v); if (_text === '') el.children.length = 0; }
  });
  el.children = [];
  el.setAttribute = (k, v) => { el.attrs[k] = v; };
  el.removeAttribute = (k) => { delete el.attrs[k]; if (k === 'src') _src = undefined; };
  el.toggleAttribute = (k, on) => { on ? el.setAttribute(k, '') : el.removeAttribute(k); };
  el.addEventListener = (type, fn) => { (el.listeners[type] = el.listeners[type] || []).push(fn); };
  el.click = () => {};
  el.appendChild = (c) => { el.children.push(c); return c; };
  el.insertBefore = (c, before) => {
    el.children = el.children.filter((x) => x !== c);
    const i = before ? el.children.indexOf(before) : el.children.length;
    el.children.splice(i, 0, c);
    return c;
  };
  el.removeChild = (c) => { el.children = el.children.filter((x) => x !== c); };
  el.focus = () => { FOCUS.last = el; };
  el.blur = () => { if (FOCUS.last === el) FOCUS.last = null; };
  el.contains = (x) => x === el || el.children.some((c) => c && typeof c.contains === 'function' && c.contains(x));
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
      const slot = { id: 'slot-' + String(state.nextSlotId++).padStart(2, '0'), name: '', wallpapers: [] };
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
      if (method === 'PUT') {
        // Rename: records what the client sent (it normalizes before
        // sending), stores it, and leaves the pointer and order alone.
        const slot = state.settings.slots.find((s) => s.id === sm[1]);
        if (!slot) return respond(404, {});
        if (state.failSlotPut) return respond(500, { error: 'boom' });
        const sent = JSON.parse(opts.body);
        if (!sent || typeof sent.name !== 'string') return respond(400, {});
        state.slotRenames.push({ slotId: sm[1], name: sent.name });
        slot.name = sent.name.replace(/\s+/g, ' ').trim().slice(0, 60);
        return respond(200, { ok: true, slot: clone(slot), settings: clone(state.settings) });
      }
      return respond(405, {});
    }

    const spm = String(url).match(SLOT_WP);
    if (spm) {
      if (method === 'POST') {
        const slot = state.settings.slots.find((s) => s.id === spm[1]);
        if (!slot) return respond(404, {});
        const attempt = state.slotWpPosts.length;
        state.slotWpPosts.push({
          slotId: spm[1],
          type: headers['Content-Type'],
          dark: headers['x-sp-image-dark'],
          accent: headers['x-sp-accent'],
          bytes: (opts.body || {}).size || 0
        });
        // Tests can make the N-th upload attempt fail (0-based) to exercise
        // the per-file failure handling of a batch.
        if (state.failWpPostAt === attempt) return respond(413, { error: 'payload too large' });
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
        slot = { id: 'slot-' + String(state.nextSlotId++).padStart(2, '0'), name: '', wallpapers: [] };
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

function boot(bitmapFactory, serverSettings, preLS, seed, options = {}) {
  const elements = {};
  const getEl = (id) => (elements[id] = elements[id] || mkEl(id));
  const body = getEl('body');
  const docListeners = {};
  FOCUS.last = null;
  const documentStub = {
    body,
    visibilityState: 'visible',
    getElementById: getEl,
    createElement: (tag) => (tag === 'canvas' ? mkCanvas() : mkEl('anon')),
    addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); }
  };
  const ss = serverSettings || {};
  const fetchState = {
    settings: {
      ...SERVER_DEFAULTS,
      ...ss,
      // Same shape the real server returns: every slot carries a name.
      slots: Array.isArray(ss.slots)
        ? clone(ss.slots).map((s) => ({ id: s.id, name: typeof s.name === 'string' ? s.name : '', wallpapers: s.wallpapers }))
        : []
    },
    blobs: new Map(),
    putBodies: [], posts: [], deletes: [], deletesAll: 0, metaPuts: [],
    slotPosts: 0, slotWipes: 0, slotDeletes: [], slotMoves: [], slotWpPosts: [], slotRenames: [],
    nextId: 1, nextSlotId: 1
  };
  fetchState.confirmResult = true;
  fetchState.confirmations = [];
  const baseFetch = mkFetch(fetchState);
  const frames = new Map();
  let frameId = 0;
  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const entry of pending) { clearTimeout(entry.timer); entry.callback(); }
  };
  const sandbox = {
    document: documentStub,
    Math: mkMath(seed === undefined ? DEFAULT_SEED : seed),
    localStorage: {
      _s: {},
      writes: [],
      getItem(k) { return k in this._s ? this._s[k] : null; },
      setItem(k, v) { this._s[k] = String(v); this.writes.push(k); },
      removeItem(k) { delete this._s[k]; }
    },
    fetch: options.fetch ? (...args) => options.fetch(baseFetch, ...args) : baseFetch,
    confirm: (message) => { fetchState.confirmations.push(message); return fetchState.confirmResult; },
    requestAnimationFrame(callback) {
      const id = ++frameId;
      frames.set(id, { callback, timer: setTimeout(() => {
        frames.delete(id);
        callback();
      }, 16) });
      return id;
    },
    cancelAnimationFrame(id) {
      const entry = frames.get(id);
      if (entry) clearTimeout(entry.timer);
      frames.delete(id);
    },
    indexedDB: { open() { throw new Error('indexedDB should not be hit by the tested flows'); } },
    createImageBitmap: async () => bitmapFactory(),
    setTimeout, clearTimeout,
    console,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    navigator: {},
    // The zip reader uses these web platform globals (Node ships them all).
    Blob, Response, DecompressionStream, TextDecoder
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  /* Opt-in fake clock for the timed wallpaper rotation (intervals are ≥ 5
     min): timers of a minute or more go to a manual scheduler driven by
     clock.advance(), shorter ones (debounces, frames, preload timeouts)
     stay real, and the sandbox's Date.now() reads the fake time. */
  const clock = { now: Date.now(), timers: new Map(), nextId: 1 };
  clock.advance = (ms) => {
    const target = clock.now + ms;
    for (;;) {
      let due = null;
      for (const [id, t] of clock.timers) if (t.at <= target && (!due || t.at < due[1].at)) due = [id, t];
      if (!due) break;
      clock.timers.delete(due[0]);
      clock.now = due[1].at;
      due[1].fn();
    }
    clock.now = target;
  };
  clock.skip = (ms) => { clock.now += ms; }; // time passes, nothing fires (throttled tab / sleep)
  clock.pending = () => [...clock.timers.values()].map((t) => t.ms);
  if (options.fakeClock) {
    const LONG_MS = 60000;
    sandbox.setTimeout = (fn, ms, ...args) => {
      if (!(ms >= LONG_MS)) return setTimeout(fn, ms, ...args);
      const id = 'long-' + clock.nextId++;
      clock.timers.set(id, { fn: () => fn(...args), at: clock.now + ms, ms });
      return id;
    };
    sandbox.clearTimeout = (id) => {
      if (clock.timers.has(id)) clock.timers.delete(id);
      else clearTimeout(id);
    };
    sandbox.Date = class extends Date { static now() { return clock.now; } };
  }
  if (options.Image) sandbox.Image = options.Image;
  getEl('appearancePanel').classList.add('hidden');
  getEl('bgSlotMenu').classList.add('hidden'); // as in the markup: the menu starts closed
  if (preLS) for (const [k, v] of Object.entries(preLS)) sandbox.localStorage.setItem(k, v);
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { elements, body, fetchState, localStorage: sandbox.localStorage, flushFrames, frames, docListeners, focus: FOCUS,
    clock, document: documentStub };
}

/* Fire every listener of `type` on a stub element with a minimal event. */
function fire(el, type, ev) {
  for (const fn of el.listeners[type] || []) fn(ev || {});
}
/* Fire a keydown on a stub element; the returned event records whether
   the handlers prevented the default or stopped propagation. */
function key(el, k) {
  const ev = {
    key: k, defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; }
  };
  fire(el, 'keydown', ev);
  return ev;
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
/* Tiny zip writer (independent of the app's reader): local headers + */
/* central directory + EOCD, STORE or DEFLATE per entry. Node < 21.2  */
/* lacks DecompressionStream('deflate-raw'), so deflated entries are   */
/* only produced when the runtime can inflate them.                    */
/* ------------------------------------------------------------------ */
const zlib = require('zlib');
const CAN_INFLATE_RAW = (() => { try { new DecompressionStream('deflate-raw'); return true; } catch (e) { return false; } })();
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/* entries: [{ name, data?: Buffer|string, deflate?: bool, encrypted?: bool, dataDescriptor?: bool }] */
function makeZip(entries, { comment = '' } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '', 'utf8');
    const deflate = !!e.deflate && CAN_INFLATE_RAW;
    const payload = deflate ? zlib.deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const flags = (e.encrypted ? 1 : 0) | (e.dataDescriptor ? 8 : 0) | 0x800;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    // With a data descriptor the local header carries zeros — the reader
    // must trust the central directory instead.
    local.writeUInt32LE(e.dataDescriptor ? 0 : crc, 14);
    local.writeUInt32LE(e.dataDescriptor ? 0 : payload.length, 18);
    local.writeUInt32LE(e.dataDescriptor ? 0 : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const descriptor = e.dataDescriptor ? (() => {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(crc, 4);
      d.writeUInt32LE(payload.length, 8); d.writeUInt32LE(data.length, 12);
      return d;
    })() : Buffer.alloc(0);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));
    parts.push(local, name, payload, descriptor);
    offset += local.length + name.length + payload.length + descriptor.length;
  }
  const cdir = Buffer.concat(central);
  const commentBuf = Buffer.from(comment, 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);
  return Buffer.concat([...parts, cdir, eocd, commentBuf]);
}
/* A File-like zip for the sandbox: a real Blob (the reader calls
   .arrayBuffer()) carrying the name the picker would attach. */
function zipFile(bytes, name, type = 'application/zip') {
  return Object.assign(new Blob([bytes], { type }), { name });
}

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
  'id="bgSlotPick"', 'id="bgSlot"', 'id="bgSlotLabel"', 'id="bgSlotMenu"', 'id="bgSlotList"', 'id="bgSlotManage"',
  'aria-haspopup="menu"', 'role="menu"', '.slot-menu{', '.slot-opt{', '.slot-btn-name.unnamed',
  '.slot-opt[aria-checked=true] .slot-opt-check::before{',
  'id="bgShuffle"', '.seg-arrow{', 'header{position:relative;z-index:20;',
  'id="spSlotName"', '.sp-input{', 'maxlength="60"',
  '.sp-nav{', 'accept="image/jpeg,image/png,image/webp,image/gif,image/avif,application/zip,application/x-zip-compressed,.zip" multiple>',
  'Drop images or a .zip of images here, or', "new DecompressionStream('deflate-raw')",
  'id="spPosGrid"', 'id="spPos-br"', '.sp-pos{', '.sp-pos:disabled{', 'id="spPosX"', 'id="spPosY"',
  'id="spPosApplySlot"', 'id="spPosResetSlot"', 'id="spPosSlotHint"', '.sp-pos-slot{', '.sp-pos-slot-hint:empty{',
  'background-position:var(--sp-bg-position,50% 50%)',
  "const POS_LS_KEY = 'sp-wallpaper-positions'",
  'id="spAddSlot"', 'id="spRemoveSlot"', 'id="spThumbsWrap"', 'id="spThumbs"',
  '.sp-thumb-item{', '.sp-thumb-item.current{', '.sp-thumb-del{',
  'class="sp-panel appearance-panel', '.sp-ap-body{', '.sp-ap-controls{', '.sp-ap-gallery{',
  'id="spThumbsLabel"', 'id="spThumbsCount"', 'id="spThumbsEmpty"', '.sp-thumb-dl{', '@media (max-width:760px)',
  "const downloadUrl = (id) => wallpaperUrl(id) + '?download=1'",
  'const SLOTS_URL = \'/api/appearance/slots\'',
  'Previous slot (re-rolls a random wallpaper of it)'
]) {
  assert.ok(html.includes(needle), 'index.html missing: ' + needle);
}
for (const gone of ['id="bgPrev"', 'id="bgNext"']) {
  assert.ok(!html.includes(gone), 'the header slot arrows are replaced by the slot menu: ' + gone);
}
/* Timed rotation: the panel's Rotate select offers exactly the supported
   intervals (minutes, 0 = off) and the Rotation group sits between Slots
   and Effects. */
for (const needle of ['id="spRotate"', 'id="spRotateHint"', '<label class="sp-field-label" for="spRotate">Rotate</label>',
  "const ROTATE_LS_KEY = 'sp-wallpaper-rotate'", 'const ROTATE_CHOICES = [0, 5, 10, 15, 30, 60, 120, 180, 360]',
  '.seg-arrow.rotating{', '.sp-rotate{', '#spRotateHint:empty{display:none}']) {
  assert.ok(html.includes(needle), 'index.html missing: ' + needle);
}
{
  const sel = html.slice(html.indexOf('<select id="spRotate"'), html.indexOf('</select>', html.indexOf('<select id="spRotate"')));
  assert.deepStrictEqual([...sel.matchAll(/<option value="(\d+)">/g)].map((m) => m[1]),
    ['0', '5', '10', '15', '30', '60', '120', '180', '360'], 'rotate intervals: off, 5 min … 6 h');
  const rotation = html.indexOf('<span class="sp-label">Rotation</span>');
  assert.ok(html.indexOf('id="spNav"') < rotation && rotation < html.indexOf('id="spRotate"') &&
    html.indexOf('id="spRotateHint"') < html.indexOf('<span class="sp-label">Effects</span>'),
    'the Rotation group sits between Slots and Effects');
}
assert.ok(html.indexOf('id="bgSlot"') < html.indexOf('id="bgShuffle"') &&
  html.indexOf('id="bgShuffle"') < html.indexOf('id="bgSlotMenu"'),
  'the slot menu button and shuffle share one group; the menu sits after it');
assert.ok(html.indexOf('<span class="sp-label">Slots</span>') < html.indexOf('id="spSlotName"') &&
  html.indexOf('id="spSlotName"') < html.indexOf('id="spAddSlot"'),
  'the Name field heads the Slots group');
assert.ok(html.indexOf('id="spPosY"') < html.indexOf('id="spPosApplySlot"') &&
  html.indexOf('id="spPosApplySlot"') < html.indexOf('id="spPosResetSlot"') &&
  html.indexOf('id="spPosResetSlot"') < html.indexOf('<span class="sp-label">This wallpaper</span>'),
  'the slot-wide position actions sit under the sliders, inside Position');
{
  const controls = html.indexOf('class="sp-ap-controls"');
  const gallery = html.indexOf('class="sp-ap-gallery"');
  assert.ok(controls !== -1 && gallery > controls, 'the gallery column follows the controls column');
  for (const needle of ['id="spDropZone"', '<span class="sp-label">This wallpaper</span>', 'id="spSlotName"',
    '<span class="sp-label">Effects</span>', 'id="spReset"', 'id="spStatus"']) {
    const at = html.indexOf(needle);
    assert.ok(at > controls && at < gallery, 'controls column holds ' + needle);
  }
  for (const needle of ['id="spThumbsLabel"', 'id="spThumbsCount"', 'id="spThumbsEmpty"', 'id="spThumbsWrap"', 'id="spThumbs"']) {
    assert.ok(html.indexOf(needle) > gallery, 'gallery column holds ' + needle);
  }
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
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SELF_NAME: 'test', POWER_SAMPLER: 'off' },
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
    // First and only slot, single wallpaper: neither nav button is enabled
    // (both stay visible, dimmed), the counter reads 1 of 1, and the
    // wallpaper gets a thumbnail in the slot.
    assert.ok(!t.elements.spNav.classList.contains('hidden'), 'nav row visible');
    assert.ok(!t.elements.spPrev.classList.contains('hidden'), 'previous stays visible on the first');
    assert.ok(t.elements.spPrev.disabled, 'previous disabled on the first');
    assert.ok(!t.elements.spNext.classList.contains('hidden'), 'next stays visible on the last');
    assert.ok(t.elements.spNext.disabled, 'next disabled on the last');
    assert.strictEqual(t.elements.spNavCount.textContent, '1 of 1');
    assert.ok(!t.elements.spThumbsWrap.classList.contains('hidden'), 'thumb strip shown for a non-empty slot');
    assert.strictEqual(t.elements.spThumbs.children.length, 1, 'one thumbnail for the slot wallpaper');
    assert.strictEqual(t.elements.spThumbsCount.textContent, '1 wallpaper', 'gallery count is singular for one');
    assert.ok(t.elements.spThumbsEmpty.classList.contains('hidden'), 'empty note hidden for a non-empty slot');
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
    assert.ok(!t.elements.spThumbsEmpty.classList.contains('hidden'), 'empty note shown with nothing to list');
    assert.strictEqual(t.elements.spThumbsCount.textContent, '', 'no count with nothing to list');
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
    t.flushFrames();
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
    assert.ok(!t.elements.spPrev.disabled, 'previous enabled off the first');
    assert.ok(t.elements.spNext.disabled, 'next disabled on the last');

    click(t.elements, 'spPrev');
    await sleep(400);
    assert.strictEqual(t.fetchState.settings.activeSlotId, slotA.id, 'previous moves to the previous slot');
    assert.strictEqual(t.body.style.props['--accent'], '#b03b3b', 'theme switched to the previous slot pick');
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + slotA.wallpapers[0].id + '")', 'background switched to the previous slot');
    assert.strictEqual(t.elements.spNavCount.textContent, '1 of 2');
    assert.ok(t.elements.spPrev.disabled, 'previous disabled on the first');
    assert.ok(!t.elements.spNext.disabled, 'next enabled off the first');
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
    assert.strictEqual(t.elements.spThumbsCount.textContent, '3 wallpapers', 'gallery head counts the slot');
    // Each tile's third child downloads the original: a real link to the
    // ?download=1 variant (server names the file), and clicking it neither
    // shows that wallpaper nor talks to the API.
    st.slots[0].wallpapers.forEach((w, i) => {
      const dl = items[i].children[2];
      assert.strictEqual(dl.className, 'sp-thumb-dl', 'third child is the download link');
      assert.strictEqual(dl.href, '/api/appearance/wallpapers/' + encodeURIComponent(w.id) + '?download=1',
        'download points at the original, not the thumbnail');
      assert.strictEqual(dl.attrs.download, '', 'empty download attribute defers naming to the server');
    });
    const currentBefore = items.findIndex((item) => item.classList.contains('current'));
    const other = currentBefore === 0 ? 1 : 0;
    const fetchesBefore = t.fetchState.posts.length + t.fetchState.deletes.length + t.fetchState.putBodies.length + t.fetchState.metaPuts.length;
    let stopped = false;
    items[other].children[2].listeners.click[0]({ stopPropagation() { stopped = true; } });
    await sleep(30);
    assert.ok(stopped, 'download click does not bubble to the tile');
    assert.strictEqual(items.findIndex((item) => item.classList.contains('current')), currentBefore,
      'downloading does not switch the displayed wallpaper');
    assert.strictEqual(t.fetchState.posts.length + t.fetchState.deletes.length + t.fetchState.putBodies.length + t.fetchState.metaPuts.length,
      fetchesBefore, 'downloading sends no API request');
    const del = items[1].children[1]; // each thumbnail: [img, × button, download link]
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

  /* ---- Scenario 14: header slot menu — names the active slot (unnamed:
     "Slot N"), lists every slot with thumbnail + count, jumps straight to
     any slot (skipping the ones between), re-rolls and persists right away,
     is keyboard-driven, closes on Esc / outside click without closing the
     Appearance panel, and is inert with no slots. ---- */
  {
    const mk = (id, name, accent) => ({
      id, name, wallpapers: [{ id: id + '-wp', type: 'image/png', imageDark: true, accent, accentTouched: true }]
    });
    const slots = [
      mk('11111111-1111-4111-8111-111111111111', 'Sunsets', '#b03b3b'),
      mk('22222222-2222-4222-8222-222222222222', '', '#3b3bb0'),
      mk('33333333-3333-4333-8333-333333333333', 'Forest', '#3bb05e')
    ];
    const t = boot(() => makeBitmap(1, 1, () => [128, 128, 128]),
      { slots, activeSlotId: slots[1].id });
    await sleep(30); // let the startup fetch settle
    const E = t.elements;
    const menuOpen = () => !E.bgSlotMenu.classList.contains('hidden');
    const lastPut = () => t.fetchState.putBodies[t.fetchState.putBodies.length - 1];
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + slots[1].wallpapers[0].id + '")', 'boots on the middle slot pick');
    assert.strictEqual(E.bgSlotLabel.textContent, 'Slot 2', 'an unnamed slot reads as "Slot N"');
    assert.ok(E.bgSlotLabel.classList.contains('unnamed'), 'the fallback label is styled as a placeholder');
    assert.ok(!E.bgSlot.disabled, 'the menu button is live with slots');
    assert.ok(E.bgShuffle.disabled, 'shuffle dimmed for a single-wallpaper slot');
    assert.ok(!menuOpen(), 'the menu starts closed');
    assert.strictEqual(E.bgSlotList.children.length, 0, 'a closed menu builds no rows (and loads no thumbnails)');

    // Open: every slot in order, the active one checked, thumbnails + counts.
    click(E, 'bgSlot');
    assert.ok(menuOpen(), 'clicking the button opens the menu');
    assert.strictEqual(E.bgSlot.attrs['aria-expanded'], 'true');
    let rows = E.bgSlotList.children;
    assert.strictEqual(rows.length, 3, 'one row per slot');
    assert.deepStrictEqual(rows.map((r) => r.children[2].textContent), ['Sunsets', 'Slot 2', 'Forest'], 'names, with the fallback');
    assert.ok(rows[1].children[2].className.includes('unnamed') && !rows[0].children[2].className.includes('unnamed'));
    assert.deepStrictEqual(rows.map((r) => r.attrs.role), ['menuitemradio', 'menuitemradio', 'menuitemradio']);
    assert.deepStrictEqual(rows.map((r) => r.attrs['aria-checked']), ['false', 'true', 'false'], 'the active slot is checked');
    assert.deepStrictEqual(rows.map((r) => r.children[0].className), ['slot-opt-check', 'slot-opt-check', 'slot-opt-check'],
      'every row has the check cell (CSS draws it on the checked one)');
    assert.deepStrictEqual(rows.map((r) => r.children[3].textContent), ['1', '1', '1'], 'wallpaper counts');
    rows.forEach((r, i) => assert.strictEqual(r.children[1].children[0].src,
      '/api/appearance/wallpapers/' + slots[i].wallpapers[0].id + '/thumbnail', 'row ' + i + ' previews its slot'));
    assert.strictEqual(t.focus.last, rows[1], 'opening focuses the active slot');

    // Picking the slot you are on: closes, saves nothing, keeps the pick.
    const putsBefore = t.fetchState.putBodies.length;
    rows[1].listeners.click[0]();
    await sleep(50);
    assert.ok(!menuOpen(), 'picking closes the menu');
    assert.strictEqual(E.bgSlot.attrs['aria-expanded'], 'false');
    assert.strictEqual(t.focus.last, E.bgSlot, 'focus returns to the button');
    assert.strictEqual(t.fetchState.putBodies.length, putsBefore, 'picking the current slot is a no-op');

    // Jump straight from slot 2 to slot 1, then (by keyboard) to slot 3.
    click(E, 'bgSlot');
    E.bgSlotList.children[0].listeners.click[0]();
    await sleep(400);
    assert.strictEqual(t.fetchState.settings.activeSlotId, slots[0].id, 'the picked slot becomes active');
    assert.strictEqual(t.body.style.props['--accent'], '#b03b3b', 'theme follows the pick');
    assert.strictEqual(lastPut().activeSlotId, slots[0].id, 'the switch is persisted immediately');
    assert.strictEqual(E.bgSlotLabel.textContent, 'Sunsets', 'the button names the new slot');
    assert.ok(!E.bgSlotLabel.classList.contains('unnamed'));
    assert.ok(!menuOpen(), 'the menu closed after the pick');

    // Keyboard: ↓ on the button opens on the active slot; ↓/↑ wrap through
    // the slots and "Name & manage slots…"; Home/End jump; Enter picks.
    key(E.bgSlot, 'ArrowDown');
    assert.ok(menuOpen(), 'arrow down opens the menu');
    rows = E.bgSlotList.children;
    assert.strictEqual(t.focus.last, rows[0], 'focus starts on the active slot');
    key(E.bgSlotMenu, 'ArrowDown');
    key(E.bgSlotMenu, 'ArrowDown');
    assert.strictEqual(t.focus.last, rows[2]);
    key(E.bgSlotMenu, 'ArrowDown');
    assert.strictEqual(t.focus.last, E.bgSlotManage, 'the manage item follows the slots');
    key(E.bgSlotMenu, 'ArrowDown');
    assert.strictEqual(t.focus.last, rows[0], 'arrow down wraps to the top');
    key(E.bgSlotMenu, 'ArrowUp');
    assert.strictEqual(t.focus.last, E.bgSlotManage, 'arrow up wraps to the bottom');
    key(E.bgSlotMenu, 'Home');
    assert.strictEqual(t.focus.last, rows[0]);
    key(E.bgSlotMenu, 'End');
    key(E.bgSlotMenu, 'ArrowUp');
    assert.strictEqual(t.focus.last, rows[2]);
    const enter = key(E.bgSlotMenu, 'Enter');
    assert.ok(enter.defaultPrevented);
    await sleep(400);
    assert.strictEqual(t.fetchState.settings.activeSlotId, slots[2].id, 'Enter picks the focused slot');
    assert.strictEqual(t.body.style.props['--accent'], '#3bb05e');
    assert.strictEqual(E.bgSlotLabel.textContent, 'Forest');
    assert.ok(!menuOpen());

    // Esc closes without switching and without closing the Appearance panel.
    click(E, 'appearanceBtn');
    assert.ok(!E.appearancePanel.classList.contains('hidden'), 'panel open');
    key(E.bgSlot, 'ArrowDown');
    key(E.bgSlotMenu, 'Home');
    const esc = key(E.bgSlotMenu, 'Escape');
    assert.ok(esc.propagationStopped, 'Esc stops at the menu, so the panel stays open');
    assert.ok(!menuOpen(), 'Esc closes the menu');
    assert.strictEqual(t.focus.last, E.bgSlot, 'Esc returns focus to the button');
    assert.strictEqual(t.fetchState.settings.activeSlotId, slots[2].id, 'Esc does not switch');

    // A click inside the picker keeps the menu; one outside closes it; the
    // button toggles it.
    click(E, 'bgSlot');
    for (const fn of t.docListeners.pointerdown) fn({ target: E.bgSlotPick });
    assert.ok(menuOpen(), 'a click inside the picker keeps the menu open');
    for (const fn of t.docListeners.pointerdown) fn({ target: E.rows });
    assert.ok(!menuOpen(), 'a click outside closes the menu');
    click(E, 'bgSlot');
    click(E, 'bgSlot');
    assert.ok(!menuOpen(), 'the button toggles the menu closed');

    // "Name & manage slots…" opens the panel on the Name field.
    click(E, 'appearanceClose');
    assert.ok(E.appearancePanel.classList.contains('hidden'));
    click(E, 'bgSlot');
    E.bgSlotManage.listeners.click[0]();
    assert.ok(!menuOpen(), 'manage closes the menu');
    assert.ok(!E.appearancePanel.classList.contains('hidden'), 'manage opens the Appearance panel');
    assert.strictEqual(t.focus.last, E.spSlotName, 'manage puts the cursor in the Name field');

    // No slots: the button is dimmed, says so, and opens nothing.
    const t2 = boot(() => makeBitmap(1, 1, () => [128, 128, 128]));
    await sleep(30);
    assert.ok(t2.elements.bgSlot.disabled, 'menu button dimmed with no slots');
    assert.strictEqual(t2.elements.bgSlotLabel.textContent, 'No slots');
    assert.ok(t2.elements.bgShuffle.disabled, 'shuffle dimmed with no slots');
    click(t2.elements, 'bgSlot');
    key(t2.elements.bgSlot, 'ArrowDown');
    assert.ok(t2.elements.bgSlotMenu.classList.contains('hidden'), 'nothing opens without slots');
    await sleep(300);
    assert.strictEqual(t2.fetchState.settings.activeSlotId, null, 'clicking the dimmed button changes nothing');
    console.log('  ok 14. header slot menu names the slot, jumps straight to any slot, keyboard + dismiss');
  }

  /* ---- Scenario 14b: header shuffle picks a different wallpaper from
     the current slot uniformly, without walking slots or writing settings. */
  {
    const seed = 12345;
    const rng = lcg(seed);
    const mkWp = (id, accent) => ({ id, type: 'image/png', imageDark: true, accent, accentTouched: true });
    const slot = { id: 'slot-shuffle', wallpapers: [
      mkWp('shuffle-a', '#b03b3b'), mkWp('shuffle-b', '#3b3bb0'),
      mkWp('shuffle-c', '#3bb05e'), mkWp('shuffle-d', '#b0b03b')
    ] };
    const t = boot(() => makeBitmap(1, 1, () => [128, 128, 128]),
      { slots: [slot], activeSlotId: slot.id }, undefined, seed);
    await sleep(30);
    assert.ok(!t.elements.bgShuffle.disabled, 'shuffle enabled with multiple wallpapers');
    const first = Math.floor(rng() * slot.wallpapers.length);
    let current = slot.wallpapers[first];
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + current.id + '")');
    const putsBefore = t.fetchState.putBodies.length;
    const seen = new Set([current.id]);
    for (let i = 0; i < 8; i++) {
      const choices = slot.wallpapers.filter((w) => w.id !== current.id);
      current = choices[Math.floor(rng() * choices.length)];
      click(t.elements, 'bgShuffle');
      seen.add(current.id);
      assert.strictEqual(t.body.style.props['--sp-bg-image'],
        'url("/api/appearance/wallpapers/' + current.id + '")', 'shuffle follows a random draw among the other wallpapers');
      assert.strictEqual(t.body.style.props['--accent'], current.accent, 'theme follows the shuffled wallpaper');
      assert.strictEqual(t.elements.spThumbs.children.filter((item) => item.className.includes('current')).length, 1,
        'thumbnail strip marks one current wallpaper');
    }
    assert.ok(seen.size > 2, 'shuffle reaches more than a pair of wallpapers');
    assert.strictEqual(t.fetchState.settings.activeSlotId, slot.id, 'shuffle keeps the same active slot');
    assert.strictEqual(t.fetchState.putBodies.length, putsBefore, 'shuffle does not save a shared setting');
    console.log('  ok 14b. header shuffle randomly selects another wallpaper in the current slot');
  }

  /* ---- Scenario 14c: naming a slot from the panel's Name field — saved
     on change (Enter / leaving the field) through the slot endpoint,
     normalized, no settings PUT; Esc reverts; a draft survives repaints;
     switching slots swaps in that slot's name; an empty name falls back to
     "Slot N"; a failed save reverts and reports. ---- */
  {
    const mkWp = (id, accent) => ({ id, type: 'image/png', imageDark: true, accent, accentTouched: true });
    const slotA = { id: 'slot-a', name: '', wallpapers: [mkWp('a1', '#b03b3b')] };
    const slotB = { id: 'slot-b', name: 'Blues', wallpapers: [mkWp('b1', '#3b3bb0')] };
    const t = boot(() => makeBitmap(1, 1, () => [128, 128, 128]),
      { slots: [slotA, slotB], activeSlotId: slotA.id });
    await sleep(30);
    const E = t.elements;
    const field = E.spSlotName;
    const edit = (value) => { field.focus(); fire(field, 'focus'); field.value = value; };
    const leave = () => { fire(field, 'change'); fire(field, 'blur'); field.blur(); };
    assert.ok(!field.disabled, 'the Name field is live with a slot');
    assert.strictEqual(field.value, '', 'an unnamed slot shows an empty field');
    assert.strictEqual(field.placeholder, 'Slot 1', 'with its fallback as the placeholder');
    const putsBefore = t.fetchState.putBodies.length;

    // Type and leave: saved normalized; the header follows; no settings PUT.
    edit('  Red \t  carpet  ');
    leave();
    await sleep(100);
    assert.deepStrictEqual(t.fetchState.slotRenames, [{ slotId: 'slot-a', name: 'Red carpet' }],
      'the rename went to the slot endpoint, trimmed and collapsed');
    assert.strictEqual(t.fetchState.settings.slots[0].name, 'Red carpet', 'stored on the server');
    assert.strictEqual(field.value, 'Red carpet', 'the field shows the saved name');
    assert.strictEqual(E.bgSlotLabel.textContent, 'Red carpet', 'the header names the slot');
    assert.ok(!E.bgSlotLabel.classList.contains('unnamed'));
    assert.strictEqual(t.fetchState.putBodies.length, putsBefore, 'a rename sends no settings PUT');
    assert.strictEqual(t.fetchState.settings.activeSlotId, 'slot-a', 'the pointer is untouched');
    assert.strictEqual(JSON.parse(t.localStorage.getItem('sp-appearance')).slots[0].name, 'Red carpet',
      'the offline cache carries the name');

    // An unchanged (after normalization) value is not re-sent.
    edit('Red carpet ');
    leave();
    await sleep(50);
    assert.strictEqual(t.fetchState.slotRenames.length, 1, 'no request for an unchanged name');

    // Enter commits by leaving the field.
    edit('Evening');
    const enter = key(field, 'Enter');
    assert.ok(enter.defaultPrevented, 'Enter is consumed');
    assert.notStrictEqual(t.focus.last, field, 'Enter leaves the field');
    leave(); // the browser follows up with change + blur
    await sleep(100);
    assert.deepStrictEqual(t.fetchState.slotRenames[1], { slotId: 'slot-a', name: 'Evening' });
    assert.strictEqual(E.bgSlotLabel.textContent, 'Evening');

    // Esc reverts the draft without saving and keeps the panel open.
    click(E, 'appearanceBtn');
    edit('Oops');
    const esc = key(field, 'Escape');
    assert.ok(esc.propagationStopped, 'the first Esc stays in the field (the panel stays open)');
    assert.strictEqual(field.value, 'Evening', 'Esc restores the stored name');
    fire(field, 'blur');
    await sleep(50);
    assert.strictEqual(t.fetchState.slotRenames.length, 2, 'Esc saves nothing');
    assert.ok(!E.appearancePanel.classList.contains('hidden'));

    // A repaint while typing leaves the draft alone…
    edit('Draft in progress');
    click(E, 'spPos-tl'); // setAnchor → commitLocal → syncPanel
    assert.strictEqual(field.value, 'Draft in progress', 'a repaint does not clobber the draft');
    // …but a slot switch underneath it (e.g. from another tab — a real click
    // on › would blur and save first) swaps in that slot's name.
    click(E, 'spNext');
    await sleep(400);
    assert.strictEqual(t.fetchState.settings.activeSlotId, 'slot-b');
    assert.strictEqual(field.value, 'Blues', 'the field follows the active slot');
    assert.strictEqual(field.placeholder, 'Slot 2');
    assert.strictEqual(E.bgSlotLabel.textContent, 'Blues');
    leave();
    await sleep(50);
    assert.strictEqual(t.fetchState.slotRenames.length, 2, 'the abandoned draft was not saved anywhere');

    // Clearing a name falls back to "Slot N".
    edit('   ');
    leave();
    await sleep(100);
    assert.deepStrictEqual(t.fetchState.slotRenames[2], { slotId: 'slot-b', name: '' }, 'a blank name clears it');
    assert.strictEqual(E.bgSlotLabel.textContent, 'Slot 2', 'the header falls back to "Slot N"');
    assert.ok(E.bgSlotLabel.classList.contains('unnamed'));
    assert.strictEqual(field.value, '');

    // A failed save reports and restores the stored name.
    t.fetchState.failSlotPut = true;
    edit('Nope');
    leave();
    await sleep(100);
    assert.match(E.spStatus.textContent, /rename failed \(HTTP 500\)/, 'the failure is reported');
    assert.strictEqual(field.value, '', 'the field falls back to the stored name');
    assert.strictEqual(t.fetchState.settings.slots[1].name, '', 'nothing was stored');
    assert.strictEqual(E.bgSlotLabel.textContent, 'Slot 2');
    t.fetchState.failSlotPut = false;

    // The menu lists the names it was given.
    click(E, 'bgSlot');
    assert.deepStrictEqual(E.bgSlotList.children.map((r) => r.children[2].textContent), ['Evening', 'Slot 2']);
    key(E.bgSlotMenu, 'Escape');

    // No slot: the field is disabled and empty.
    const t2 = boot(() => makeBitmap(1, 1, () => [128, 128, 128]));
    await sleep(30);
    assert.ok(t2.elements.spSlotName.disabled, 'Name disabled with no slot');
    assert.strictEqual(t2.elements.spSlotName.placeholder, 'No slot');
    assert.strictEqual(t2.elements.spSlotName.value, '');
    console.log('  ok 14c. the panel Name field renames the active slot (normalized, Esc reverts, failures revert)');
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
    t.flushFrames();
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '100% 63%', 'off-detent offset applied live');
    t.elements.spPosY.value = '53';
    yIn[0]();
    t.flushFrames();
    assert.strictEqual(t.elements.spPosY.value, '50', 'magnetized onto the detent');
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '100% 50%', 'snapped onto the right-edge anchor');
    t.elements.spPosY.value = '49';
    yIn[0]();
    t.flushFrames();
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
    assert.ok(t.elements.spPosApplySlot.disabled, 'apply-to-slot disabled with no wallpaper');
    assert.ok(t.elements.spPosResetSlot.disabled, 'reset-slot disabled with no wallpaper');
    assert.strictEqual(t.elements.spPosSlotHint.textContent, '', 'no slot hint with no wallpaper');
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
    assert.match(t.fetchState.confirmations[0], /also remove the slot/);
    await sleep(500);
    const st = t.fetchState.settings;
    assert.deepStrictEqual(t.fetchState.deletes, [slotB.wallpapers[0].id], 'the displayed wallpaper was deleted');
    assert.strictEqual(st.slots.length, 1, 'the drained slot was auto-removed');
    assert.strictEqual(st.activeSlotId, slotA.id, 'the pointer landed on the previous slot');
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + slotA.wallpapers[0].id + '")', 'the previous slot wallpaper is now displayed');
    assert.strictEqual(t.body.style.props['--accent'], '#b03b3b', 'the theme follows the fallback pick');
    assert.strictEqual(t.elements.spNavCount.textContent, '1 of 1');
    assert.ok(t.elements.spPrev.disabled, 'previous dimmed on the (new) first slot');
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

  /* ---------- Scenario 23: a .zip upload unpacks into one wallpaper per image ----------
     The archive mixes stored and deflated entries, a data-descriptor entry,
     a directory, a text file, macOS metadata and a hidden file. Only the
     images survive, sorted by path (natural order: 2 before 10), each
     uploaded through the same per-image path as a directly picked file. */
  {
    const zip = makeZip([
      { name: 'pack/wall-10.jpg', data: 'JPEG-TEN', deflate: true },
      { name: 'pack/', data: '' },
      { name: 'pack/notes.txt', data: 'not an image' },
      { name: '__MACOSX/pack/._wall-10.jpg', data: 'apple double' },
      { name: 'pack/.DS_Store', data: 'finder' },
      { name: 'pack/wall-2.PNG', data: 'PNG-TWO', dataDescriptor: true },
      { name: 'pack/nested.zip', data: 'zip in zip' },
      { name: 'pack/empty.gif', data: '' },
      { name: 'other/cover.webp', data: 'WEBP', deflate: true }
    ], { comment: 'made by the test' });
    const t = boot(() => makeBitmap(64, 64, () => [128, 128, 128]));
    await sleep(30);
    upload(t.elements, zipFile(zip, 'pack.zip'));
    await sleep(900);
    assert.strictEqual(t.fetchState.slotPosts, 1, 'one slot minted for the archive');
    const posts = t.fetchState.slotWpPosts;
    assert.deepStrictEqual(posts.map((p) => p.type), ['image/webp', 'image/png', 'image/jpeg'],
      'only the images were uploaded, in natural path order');
    assert.deepStrictEqual(posts.map((p) => p.bytes), ['WEBP'.length, 'PNG-TWO'.length, 'JPEG-TEN'.length],
      'each entry was unpacked to its original bytes (stored, data-descriptor and deflated alike)');
    const st = t.fetchState.settings;
    assert.strictEqual(st.slots.length, 1, 'the archive fills a single slot');
    assert.strictEqual(st.slots[0].wallpapers.length, 3, 'three wallpapers from the archive');
    assert.strictEqual(st.activeSlotId, st.slots[0].id, 'the filled slot is active');
    assert.strictEqual(t.elements.spThumbs.children.length, 3, 'every unpacked image gets a thumbnail');
    assert.strictEqual(t.elements.spStatus.textContent, '', 'a clean run clears the status line');
    console.log('  ok 23. a .zip upload unpacks into one wallpaper per image (' + (CAN_INFLATE_RAW ? 'deflate + store' : 'store only — no deflate-raw in this Node') + ')');
  }

  /* ---------- Scenario 24: images and archives mix in one selection ----------
     Picker order is kept: a plain image first, then the archive's images. A
     `.zip` with an empty MIME type (common on Linux/Windows pickers) is
     still recognised by its name. */
  {
    const zip = makeZip([{ name: 'b.png', data: 'B' }, { name: 'a.jpg', data: 'A' }]);
    const t = boot(() => makeBitmap(64, 64, () => [128, 128, 128]));
    await sleep(30);
    upload(t.elements, { type: 'image/gif', size: 5 }, zipFile(zip, 'pics.zip', ''), { type: 'text/plain', size: 9 });
    await sleep(900);
    assert.deepStrictEqual(t.fetchState.slotWpPosts.map((p) => p.type), ['image/gif', 'image/jpeg', 'image/png'],
      'the plain image leads, the archive expands in place, non-images are ignored');
    assert.strictEqual(t.fetchState.settings.slots[0].wallpapers.length, 3);
    console.log('  ok 24. images and a .zip (even with an empty MIME type) mix in one upload');
  }

  /* ---------- Scenario 25: archives with nothing to upload mint nothing ----------
     An image-less archive, bytes that are not a zip, and a Zip64 marker all
     end in a status message — and no slot is created for them. */
  {
    const t = boot(() => makeBitmap(64, 64, () => [128, 128, 128]));
    await sleep(30);
    upload(t.elements, zipFile(makeZip([{ name: 'readme.txt', data: 'hi' }]), 'docs.zip'));
    await sleep(300);
    assert.strictEqual(t.fetchState.slotPosts, 0, 'no slot for an image-less archive');
    assert.strictEqual(t.fetchState.slotWpPosts.length, 0);
    assert.match(t.elements.spStatus.textContent, /Nothing uploaded: docs\.zip \(no supported images\)/);

    upload(t.elements, zipFile(Buffer.from('definitely not a zip file at all'), 'bogus.zip'));
    await sleep(300);
    assert.strictEqual(t.fetchState.slotPosts, 0, 'no slot for a non-archive');
    assert.match(t.elements.spStatus.textContent, /bogus\.zip \(not a zip archive\)/);

    const z64 = makeZip([{ name: 'x.png', data: 'X' }]);
    z64.writeUInt16LE(0xffff, z64.length - 22 + 10); // entry count marker → Zip64
    upload(t.elements, zipFile(z64, 'huge.zip'));
    await sleep(300);
    assert.strictEqual(t.fetchState.slotPosts, 0, 'no slot for a Zip64 archive');
    assert.match(t.elements.spStatus.textContent, /huge\.zip \(Zip64 archives are not supported\)/);

    const enc = makeZip([{ name: 'secret.png', data: 'S', encrypted: true }]);
    upload(t.elements, zipFile(enc, 'locked.zip'));
    await sleep(300);
    assert.strictEqual(t.fetchState.slotPosts, 0, 'no slot when every entry is encrypted');
    assert.match(t.elements.spStatus.textContent, /locked\.zip\/secret\.png \(encrypted\)/);
    console.log('  ok 25. image-less, non-zip, Zip64 and encrypted archives report and mint nothing');
  }

  /* ---------- Scenario 26: one failing file does not sink the batch ----------
     The second of three uploads is refused by the server; the other two
     land and the status line names the casualty. */
  {
    const zip = makeZip([{ name: 'a.png', data: 'A' }, { name: 'b.png', data: 'B' }, { name: 'c.png', data: 'C' }]);
    const t = boot(() => makeBitmap(64, 64, () => [128, 128, 128]));
    t.fetchState.failWpPostAt = 1;
    await sleep(30);
    upload(t.elements, zipFile(zip, 'trio.zip'));
    await sleep(900);
    assert.strictEqual(t.fetchState.slotWpPosts.length, 3, 'every file was attempted');
    assert.strictEqual(t.fetchState.settings.slots[0].wallpapers.length, 2, 'the two good files became wallpapers');
    assert.strictEqual(t.elements.spStatus.textContent, 'Uploaded 2 of 3 — failed: b.png (upload failed (HTTP 413))');
    console.log('  ok 26. a failing upload is reported and the rest of the batch still lands');
  }

  /* Performance regression: populated slots must not add work to dragging. */
  {
    const wallpapers = Array.from({ length: 30 }, (_, i) => ({
      id: 'perf-' + i, type: 'image/png', imageDark: false, accent: '#b03b3b', accentTouched: true
    }));
    const t = boot(() => makeBitmap(1, 1, () => [0, 0, 0]), {
      slots: [{ id: 'perf-slot', wallpapers }], activeSlotId: 'perf-slot'
    });
    await sleep(30);
    const nodes = t.elements.spThumbs.children.slice();
    const images = nodes.map((node) => node.children[0]);
    assert.ok(images.every((img) => !img.src), 'closed panel does not load previews');
    assert.ok(!t.elements.spThumb.src, 'closed panel does not load the current preview');
    click(t.elements, 'appearanceBtn');
    assert.ok(images.every((img) => img.src.endsWith('/thumbnail') && img.loading === 'lazy' && img.decoding === 'async'));
    assert.ok(t.elements.spThumb.src.endsWith('/thumbnail'));
    const initialStorageWrites = t.localStorage.writes.length;
    const initialCssWrites = t.body.style.writes.length;
    for (let i = 0; i < 100; i++) {
      t.elements.spOpacity.value = String(i);
      t.elements.spOpacity.listeners.input[0]();
      t.elements.spBlur.value = String(i % 31);
      t.elements.spBlur.listeners.input[0]();
    }
    assert.equal(t.frames.size, 1, 'a burst of inputs schedules one frame');
    assert.equal(t.body.style.writes.length, initialCssWrites, 'CSS waits for the frame');
    assert.equal(t.localStorage.writes.length, initialStorageWrites, 'dragging does not serialize local storage');
    assert.equal(t.fetchState.putBodies.length, 0, 'dragging does not immediately save');
    t.flushFrames();
    assert.equal(t.body.style.props['--sp-bg-opacity'], '0.99');
    assert.equal(t.body.style.props['--sp-bg-blur'], '6px');
    assert.ok(t.body.style.writes.slice(initialCssWrites).every((key) => key.startsWith('--sp-')), 'palette untouched');
    assert.deepEqual(t.elements.spThumbs.children, nodes, 'all thumbnail nodes survive dragging');
    assert.ok(images.every((img) => img.srcWrites === 1), 'no image source is reassigned');
    t.elements.spOpacity.listeners.change[0]();
    await sleep(20);
    assert.equal(t.fetchState.putBodies.length, 1, 'release flushes before debounce');
    assert.equal(t.fetchState.putBodies[0].backgroundOpacity, 0.99);
    assert.equal(JSON.parse(t.localStorage.getItem('sp-appearance')).backgroundOpacity, 0.99);

    const displayedBefore = t.body.style.props['--sp-bg-image'];
    const putsBeforePosition = t.fetchState.putBodies.length;
    for (let i = 10; i < 40; i++) {
      t.elements.spPosX.value = String(i);
      t.elements.spPosX.listeners.input[0]();
    }
    t.elements.spPosX.listeners.change[0]();
    assert.equal(t.frames.size, 0);
    assert.equal(t.body.style.props['--sp-bg-position'], '39% 50%');
    assert.ok(Object.values(JSON.parse(t.localStorage.getItem('sp-wallpaper-positions'))).some((p) => p.x === 39));
    assert.equal(t.fetchState.putBodies.length, putsBeforePosition, 'position remains client-local');
    assert.equal(t.body.style.props['--sp-bg-image'], displayedBefore);
    assert.deepEqual(t.elements.spThumbs.children, nodes);
    t.elements.spPosY.value = '66';
    t.elements.spPosY.listeners.input[0]();
    nodes[10].listeners.click[0]();
    const positionAfterSelection = t.body.style.props['--sp-bg-position'];
    t.flushFrames();
    assert.equal(t.body.style.props['--sp-bg-position'], positionAfterSelection, 'selection cancels stale position paints');
    assert.equal(nodes[10].classList.contains('current'), true);
    assert.deepEqual(t.elements.spThumbs.children, nodes, 'selecting a wallpaper retains nodes');

    t.fetchState.confirmResult = false;
    nodes[0].children[1].listeners.click[0]({ stopPropagation() {} });
    click(t.elements, 'spRemove');
    assert.equal(t.fetchState.confirmations.length, 2);
    assert.equal(t.fetchState.deletes.length, 0, 'both cancel paths send no delete');
    t.fetchState.confirmResult = true;
    nodes[0].children[1].listeners.click[0]({ stopPropagation() {} });
    await sleep(30);
    assert.deepEqual(t.fetchState.deletes, ['perf-0']);
    assert.equal(t.elements.spThumbs.children[0], nodes[1], 'deleting one retains surviving elements');
    click(t.elements, 'spRemove');
    await sleep(30);
    assert.deepEqual(t.fetchState.deletes, ['perf-0', 'perf-10'], 'current removal targets the selected wallpaper');
    images[1].listeners.error[0]();
    nodes[2].listeners.click[0]();
    assert.equal(images[1].src, undefined, 'failed preview does not fall back to an original');
    assert.equal(images[1].srcWrites, 1, 'failed preview does not retry on panel synchronization');
    const survivors = t.elements.spThumbs.children.slice();
    upload(t.elements, { type: 'image/png', size: 100 });
    await sleep(50);
    assert.deepEqual(t.elements.spThumbs.children.slice(0, survivors.length), survivors, 'upload appends without replacing existing thumbnails');
    console.log('  ok 27. 30 wallpapers: bounded slider work, stable lazy thumbnails, confirmed removal');
  }

  /* A delayed save response cannot undo the latest intent or win on the server. */
  {
    let release;
    let putCount = 0;
    const t = boot(() => makeBitmap(1, 1, () => [0, 0, 0]), undefined, undefined, undefined, {
      fetch: async (base, url, options) => {
        const result = await base(url, options);
        if (url === '/api/appearance' && options && options.method === 'PUT' && ++putCount === 1)
          await new Promise((resolve) => { release = resolve; });
        return result;
      }
    });
    await sleep(30);
    t.elements.spOpacity.value = '80';
    t.elements.spOpacity.listeners.input[0]();
    t.elements.spOpacity.listeners.change[0]();
    await sleep(20);
    assert.ok(release);
    t.elements.spOpacity.value = '25';
    t.elements.spOpacity.listeners.input[0]();
    t.elements.spOpacity.listeners.change[0]();
    await sleep(20);
    assert.equal(putCount, 1, 'new save waits for the previous one');
    release();
    await sleep(30);
    assert.equal(putCount, 2);
    assert.equal(t.fetchState.settings.backgroundOpacity, 0.25);
    assert.equal(t.body.style.props['--sp-bg-opacity'], '0.25');
    assert.equal(JSON.parse(t.localStorage.getItem('sp-appearance')).backgroundOpacity, 0.25);
    console.log('  ok 28. delayed save responses preserve newer slider values');
  }

  /* ---------- Scenario 29: real server — slot names ----------
     New slots are unnamed; PUT /slots/<id> stores a sanitized name (trim,
     collapsed whitespace, control/bidi characters dropped, 60 code points
     without splitting an emoji) that survives a settings PUT, a move, an
     upload and a restart; bad requests are refused; a hand-edited
     non-string name reads as unnamed. */
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-appearance-names-'));
    const port = 18935;
    let proc = spawnServer(dataDir, port);
    const base = 'http://127.0.0.1:' + port;
    try {
      await waitUp(base);
      const json = async (r) => ({ status: r.status, body: await r.json() });
      const get = async () => (await (await fetch(base + '/api/appearance')).json()).settings;
      const postSlot = async () => (await (await fetch(base + '/api/appearance/slots', { method: 'POST' })).json());
      const rename = (id, body) => fetch(base + '/api/appearance/slots/' + id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body)
      });

      const created = await postSlot();
      assert.strictEqual(created.slot.name, '', 'a new slot is unnamed');
      assert.deepStrictEqual(Object.keys(created.slot), ['id', 'name', 'wallpapers'], 'slot shape');
      const sA = created.slot.id;
      const sB = (await postSlot()).slot.id; // B is now active

      let r = await json(await rename(sA, { name: '  Night \u0007  sky\u202e\n ' }));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.slot.name, 'Night sky', 'trimmed, collapsed, control + bidi characters dropped');
      assert.strictEqual(r.body.settings.slots[0].name, 'Night sky');
      assert.strictEqual(r.body.settings.activeSlotId, sB, 'renaming does not move the pointer');
      assert.deepStrictEqual(r.body.settings.slots.map((s) => s.id), [sA, sB], 'renaming does not reorder');

      const long = '🌅'.repeat(70);
      r = await json(await rename(sB, { name: long }));
      assert.strictEqual(Array.from(r.body.slot.name).length, 60, 'capped at 60 code points');
      assert.strictEqual(r.body.slot.name, '🌅'.repeat(60), 'no surrogate pair is split');
      r = await json(await rename(sB, { name: 'Sunsets' }));
      assert.strictEqual(r.body.slot.name, 'Sunsets');

      // Errors.
      assert.strictEqual((await rename('00000000-0000-4000-8000-000000000000', { name: 'x' })).status, 404, 'unknown slot');
      assert.strictEqual((await rename(sA, 'not json')).status, 400, 'bad JSON');
      assert.strictEqual((await rename(sA, { name: 5 })).status, 400, 'non-string name');
      assert.strictEqual((await rename(sA, {})).status, 400, 'missing name');
      assert.strictEqual((await rename(sA, ['x'])).status, 400, 'array body');
      // The shared body reader cuts the connection on an oversized body, so a
      // client may see a reset rather than the 413 — refused either way.
      const oversized = await rename(sA, { name: 'x'.repeat(5000) }).then((res) => res.status, () => 'reset');
      assert.ok(oversized === 413 || oversized === 'reset', 'oversized body refused (got ' + oversized + ')');
      assert.strictEqual((await get()).slots[0].name, 'Night sky', 'failed requests changed nothing');

      // The name rides along through the other slot operations.
      await fetch(base + '/api/appearance', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scrim: 0.2, activeSlotId: sA, slots: [{ id: sA, name: 'hijack', wallpapers: [] }] })
      });
      let s = await get();
      assert.deepStrictEqual(s.slots.map((x) => x.name), ['Night sky', 'Sunsets'], 'a settings PUT cannot rename');
      await fetch(base + '/api/appearance/slots/' + sA + '/move', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delta: 1 })
      });
      await fetch(base + '/api/appearance/slots/' + sA + '/wallpapers', {
        method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('img')
      });
      s = await get();
      assert.deepStrictEqual(s.slots.map((x) => [x.id, x.name]), [[sB, 'Sunsets'], [sA, 'Night sky']],
        'names survive a move and an upload');
      assert.strictEqual(s.slots[1].wallpapers.length, 1);
      const flat = await (await fetch(base + '/api/appearance/wallpapers')).json();
      assert.deepStrictEqual(flat.slots.map((x) => x.name), ['Sunsets', 'Night sky'], 'the flat view carries names');

      // Clearing.
      r = await json(await rename(sB, { name: '   ' }));
      assert.strictEqual(r.body.slot.name, '', 'a blank name clears it');

      // Persisted: a restart reads the names back; a hand-edited non-string
      // name reads as unnamed.
      proc.kill();
      await new Promise((resolve) => proc.once('exit', resolve));
      const file = path.join(dataDir, 'appearance.json');
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepStrictEqual(onDisk.slots.map((x) => x.name), ['', 'Night sky'], 'names are on disk');
      onDisk.slots[0].name = { evil: true };
      fs.writeFileSync(file, JSON.stringify(onDisk));
      proc = spawnServer(dataDir, port);
      await waitUp(base);
      s = await get();
      assert.deepStrictEqual(s.slots.map((x) => x.name), ['', 'Night sky'], 'names survive a restart; junk reads as unnamed');
      console.log('  ok 29. real server: slot names are sanitized, validated, persisted and survive slot operations');
    } finally {
      proc.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  /* ---------- Scenario 30: position — "Apply to all in slot" / "Reset slot"
     Apply copies the on-screen origin to every wallpaper of the active slot
     (fresh objects, so a later drag moves only the on-screen one); Reset
     sends the slot back to center. Both are client-local (no request at all),
     leave other slots alone, dim when they would do nothing, and only
     confirm when they would discard another wallpaper's own origin. */
  {
    const wp = (id) => ({ id, type: 'image/png', imageDark: false, accent: '', accentTouched: true });
    const slotA = { id: '30303030-aaaa-4aaa-8aaa-000000000000',
      wallpapers: [wp('30303030-aaaa-4aaa-8aaa-000000000001'), wp('30303030-aaaa-4aaa-8aaa-000000000002'), wp('30303030-aaaa-4aaa-8aaa-000000000003')] };
    const slotB = { id: '30303030-bbbb-4bbb-8bbb-000000000000', wallpapers: [wp('30303030-bbbb-4bbb-8bbb-000000000001')] };
    const [a1, a2, a3] = slotA.wallpapers.map((w) => w.id);
    const b1 = slotB.wallpapers[0].id;
    const t = boot(() => makeBitmap(1, 1, () => [128, 128, 128]),
      { slots: [slotA, slotB], activeSlotId: slotA.id },
      {
        'sp-wallpaper-positions': JSON.stringify({ [a2]: { x: 0, y: 0 }, [b1]: { x: 100, y: 100 } }),
        'sp-wallpaper-positions-migrated': '1'
      });
    await sleep(30); // let the startup fetch settle
    const E = t.elements;
    const map = () => JSON.parse(t.localStorage.getItem('sp-wallpaper-positions'));
    const counts = () => [t.fetchState.putBodies.length, t.fetchState.metaPuts.length,
      t.fetchState.deletes.length, t.fetchState.slotDeletes.length, t.fetchState.slotPosts];
    const before = counts();
    const thumbs = E.spThumbs.children.slice();
    assert.strictEqual(thumbs.length, 3, 'the strip lists slot A');
    thumbs[0].listeners.click[0](); // show a1 deliberately

    assert.ok(!E.spPosApplySlot.disabled, 'apply enabled: another wallpaper differs');
    assert.ok(!E.spPosResetSlot.disabled, 'reset enabled: a wallpaper is off center');
    assert.strictEqual(E.spPosSlotHint.textContent,
      'Copies 50% · 50% to 1 other wallpaper in this slot. This browser only.');

    // The hint follows a drag live.
    E.spPosX.value = '72'; E.spPosX.listeners.input[0]();
    E.spPosY.value = '30'; E.spPosY.listeners.input[0]();
    t.flushFrames();
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '72% 30%');
    assert.strictEqual(E.spPosSlotHint.textContent,
      'Copies 72% · 30% to 2 other wallpapers in this slot. This browser only.', 'hint tracks the drag');

    // Cancelled: a2's own origin would be replaced, so it asks — and nothing changes.
    t.fetchState.confirmResult = false;
    click(E, 'spPosApplySlot');
    assert.strictEqual(t.fetchState.confirmations.length, 1, 'overwriting a custom origin asks first');
    assert.match(t.fetchState.confirmations[0], /^Apply 72% · 30% to all 3 wallpapers in this slot\?/);
    assert.match(t.fetchState.confirmations[0], /1 of them has its own position, which will be replaced/);
    assert.deepStrictEqual(map()[a2], { x: 0, y: 0 }, 'cancel keeps a2');
    assert.ok(!(a3 in map()), 'cancel keeps a3 at center');

    // Accepted: the whole slot takes a1's origin; slot B is untouched.
    t.fetchState.confirmResult = true;
    click(E, 'spPosApplySlot');
    let m = map();
    for (const id of [a1, a2, a3]) assert.deepStrictEqual(m[id], { x: 72, y: 30 }, 'slot A wallpaper ' + id + ' applied');
    assert.deepStrictEqual(m[b1], { x: 100, y: 100 }, 'the other slot keeps its origin');
    assert.ok(E.spPosApplySlot.disabled, 'nothing left to apply');
    assert.ok(!E.spPosResetSlot.disabled);
    assert.strictEqual(E.spPosSlotHint.textContent, 'All 3 wallpapers in this slot share this position.');

    // Fresh objects: dragging a1 afterwards moves only a1.
    E.spPosX.value = '40'; E.spPosX.listeners.input[0]();
    E.spPosX.listeners.change[0]();
    m = map();
    assert.deepStrictEqual(m[a1], { x: 40, y: 30 }, 'the on-screen wallpaper moved');
    assert.deepStrictEqual(m[a2], { x: 72, y: 30 }, 'a2 did not ride along');
    assert.deepStrictEqual(m[a3], { x: 72, y: 30 }, 'a3 did not ride along');
    assert.ok(!E.spPosApplySlot.disabled, 'apply is live again once a1 differs');

    // Another wallpaper of the slot shows the applied origin.
    thumbs[1].listeners.click[0]();
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '72% 30%', 'a2 shows the applied origin');
    assert.strictEqual(E.spPosX.value, '72');

    // Reset: the others have their own origins, so it asks; then all center.
    click(E, 'spPosResetSlot');
    assert.strictEqual(t.fetchState.confirmations.length, 3);
    assert.match(t.fetchState.confirmations[2], /^Return all 3 wallpapers in this slot to center\?/);
    assert.match(t.fetchState.confirmations[2], /2 of them have their own position, which will be lost/);
    m = map();
    for (const id of [a1, a2, a3]) assert.ok(!(id in m), 'slot A wallpaper ' + id + ' back to center');
    assert.deepStrictEqual(m[b1], { x: 100, y: 100 }, 'reset leaves the other slot alone');
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '50% 50%');
    assert.strictEqual(E.spPosX.value, '50');
    assert.strictEqual(E.spPosY.value, '50');
    assert.strictEqual(E['spPos-mc'].attrs['aria-pressed'], 'true', 'center anchor pressed');
    assert.ok(E.spPosApplySlot.disabled && E.spPosResetSlot.disabled, 'both dim at an all-center slot');

    // Overwriting only center origins needs no confirmation.
    click(E, 'spPos-tl');
    assert.strictEqual(E.spPosSlotHint.textContent,
      'Copies 0% · 0% to 2 other wallpapers in this slot. This browser only.');
    click(E, 'spPosApplySlot');
    assert.strictEqual(t.fetchState.confirmations.length, 3, 'no prompt when only center origins change');
    m = map();
    for (const id of [a1, a2, a3]) assert.deepStrictEqual(m[id], { x: 0, y: 0 });

    // A one-wallpaper slot: nothing to apply to; reset needs no prompt.
    await sleep(400); // past every debounce: still nothing was sent
    assert.deepStrictEqual(counts(), before, 'apply/reset/drags in slot A sent no request');
    click(E, 'spNext');
    await sleep(400);
    assert.strictEqual(t.fetchState.settings.activeSlotId, slotB.id);
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '100% 100%');
    assert.ok(E.spPosApplySlot.disabled, 'apply dims in a one-wallpaper slot');
    assert.ok(!E.spPosResetSlot.disabled);
    assert.strictEqual(E.spPosSlotHint.textContent, 'This is the only wallpaper in this slot.');
    click(E, 'spPosResetSlot');
    assert.strictEqual(t.fetchState.confirmations.length, 3, 'resetting just the on-screen wallpaper does not ask');
    m = map();
    assert.ok(!(b1 in m), 'b1 back to center');
    for (const id of [a1, a2, a3]) assert.deepStrictEqual(m[id], { x: 0, y: 0 }, 'slot A untouched by slot B reset');
    assert.strictEqual(t.body.style.props['--sp-bg-position'], '50% 50%');
    assert.ok(E.spPosResetSlot.disabled);
    await sleep(400);
    assert.deepStrictEqual(counts().slice(1), before.slice(1), 'only the slot switch talked to the server');
    assert.ok(t.fetchState.putBodies.every((p) => !('backgroundPosition' in p)), 'no position rides a PUT');
    console.log('  ok 30. position: apply to all in slot / reset slot (client-local, confirmed overwrites)');
  }

  /* ---------- Scenario 31: timed rotation ----------
     Rotation → Rotate shows the next wallpaper of the active slot every N
     minutes: per browser (localStorage, no PUT), shuffle-bag order (each
     wallpaper once per cycle, never the one on screen), restarted by any
     manual change, held while the panel is open, inert in a one-wallpaper
     slot, caught up when an overdue tab is shown again, and off again
     without a trace. */
  {
    const mkWp = (id, accent) => ({ id, type: 'image/png', imageDark: true, accent, accentTouched: true });
    const slotA = { id: 'rot-a', name: 'Rotating', wallpapers: [
      mkWp('ra-1', '#b03b3b'), mkWp('ra-2', '#3b3bb0'), mkWp('ra-3', '#3bb05e'), mkWp('ra-4', '#b0b03b')
    ] };
    const slotB = { id: 'rot-b', name: 'Single', wallpapers: [mkWp('rb-1', '#8a3bb0')] };
    const t = boot(() => makeBitmap(1, 1, () => [128, 128, 128]),
      { slots: [slotA, slotB], activeSlotId: slotA.id }, undefined, undefined, { fakeClock: true });
    await sleep(30);
    const E = t.elements;
    const shown = () => {
      const m = /\/api\/appearance\/wallpapers\/([^"/]+)"\)$/.exec(t.body.style.props['--sp-bg-image'] || '');
      return m ? decodeURIComponent(m[1]) : null;
    };
    const accentOf = (id) => slotA.wallpapers.concat(slotB.wallpapers).find((w) => w.id === id).accent;
    const choose = (minutes) => { E.spRotate.value = String(minutes); fire(E.spRotate, 'change'); };
    const tick = async (ms) => { t.clock.advance(ms); await sleep(0); };
    const cssWrites = () => t.localStorage.writes.filter((k) => k === 'sp-appearance').length;

    // Off by default: nothing scheduled, the shuffle is not tinted.
    assert.strictEqual(E.spRotate.value, '0', 'rotation is off by default');
    assert.deepStrictEqual(t.clock.pending(), [], 'nothing scheduled while off');
    assert.ok(!E.bgShuffle.classList.contains('rotating'));
    assert.strictEqual(E.bgShuffle.title, 'Show another random wallpaper in this slot');
    assert.strictEqual(E.spRotateHint.textContent, '', 'no hint while off');

    // Pick 5 minutes in the panel: held while it is open, armed on close.
    click(E, 'appearanceBtn');
    choose(5);
    assert.strictEqual(t.localStorage.getItem('sp-wallpaper-rotate'), '5', 'the interval is stored per browser');
    assert.deepStrictEqual(t.clock.pending(), [], 'held while the panel is open');
    assert.strictEqual(E.spRotateHint.textContent,
      'Every 5 min, in random order, this browser only. Paused while this panel is open.');
    click(E, 'appearanceClose');
    assert.deepStrictEqual(t.clock.pending(), [300000], 'closing the panel starts a full interval');
    assert.ok(E.bgShuffle.classList.contains('rotating'), 'the header shuffle shows rotation is on');
    assert.strictEqual(E.bgShuffle.title,
      'Show another random wallpaper in this slot \u2014 auto-rotating every 5 min (set in Appearance)');

    // The interval elapses: a different wallpaper, its theme, no server write.
    const putsBefore = t.fetchState.putBodies.length;
    const cacheBefore = cssWrites();
    const start = shown();
    await tick(299999);
    assert.strictEqual(shown(), start, 'nothing changes before the interval is up');
    await tick(1);
    const rotated = [shown()];
    assert.notStrictEqual(rotated[0], start, 'the interval shows another wallpaper');
    assert.strictEqual(t.body.style.props['--accent'], accentOf(rotated[0]), 'the theme follows the rotation');
    assert.strictEqual(E.spThumbs.children.filter((item) => item.className.includes('current')).length, 1,
      'the gallery marks the new current wallpaper');
    assert.deepStrictEqual(t.clock.pending(), [300000], 'the next interval is armed');
    assert.strictEqual(t.fetchState.settings.activeSlotId, slotA.id, 'rotation stays in the active slot');

    // Shuffle-bag order: every cycle shows each of the other three once.
    for (let i = 1; i < 9; i++) { await tick(300000); rotated.push(shown()); }
    const before = [start].concat(rotated);
    for (let c = 0; c < 3; c++) {
      const cycle = rotated.slice(c * 3, c * 3 + 3);
      assert.strictEqual(new Set(cycle).size, 3, 'cycle ' + c + ' shows three different wallpapers');
      assert.ok(!cycle.includes(before[c * 3]), 'cycle ' + c + ' skips the wallpaper it started on');
    }
    for (let i = 1; i < before.length; i++) assert.notStrictEqual(before[i], before[i - 1], 'never the same twice in a row');
    assert.strictEqual(new Set(before).size, 4, 'all four wallpapers come around');
    assert.strictEqual(t.fetchState.putBodies.length, putsBefore, 'rotation never saves a shared setting');
    assert.strictEqual(cssWrites(), cacheBefore, 'rotation never rewrites the shared-settings cache');

    // A manual shuffle restarts the countdown.
    await tick(240000);
    const preShuffle = shown();
    click(E, 'bgShuffle');
    const manual = shown();
    assert.notStrictEqual(manual, preShuffle);
    assert.deepStrictEqual(t.clock.pending(), [300000], 'a manual pick gets a full interval');
    await tick(240000);
    assert.strictEqual(shown(), manual, 'the old deadline no longer applies');
    await tick(60000);
    assert.notStrictEqual(shown(), manual, 'rotation resumes a full interval after the manual pick');

    // The open panel holds rotation for as long as it stays open.
    click(E, 'appearanceBtn');
    const held = shown();
    assert.deepStrictEqual(t.clock.pending(), [], 'opening the panel holds rotation');
    await tick(3600000);
    assert.strictEqual(shown(), held, 'no rotation while the panel is open');
    // A new interval while there: stored, armed in full on close.
    choose(360);
    assert.strictEqual(t.localStorage.getItem('sp-wallpaper-rotate'), '360');
    click(E, 'appearanceClose');
    assert.deepStrictEqual(t.clock.pending(), [21600000], 'the new interval runs from now');
    assert.strictEqual(E.bgShuffle.title,
      'Show another random wallpaper in this slot \u2014 auto-rotating every 6 hours (set in Appearance)');

    // A one-wallpaper slot has nothing to rotate; coming back resumes.
    click(E, 'spNext');
    await sleep(50);
    assert.strictEqual(t.fetchState.settings.activeSlotId, slotB.id);
    assert.deepStrictEqual(t.clock.pending(), [], 'inert in a one-wallpaper slot');
    assert.ok(!E.bgShuffle.classList.contains('rotating'), 'no tint without anything to rotate');
    assert.strictEqual(E.bgShuffle.title, 'Show another random wallpaper in this slot');
    assert.strictEqual(E.spRotateHint.textContent, 'Rotation starts once this slot has two or more wallpapers.');
    assert.strictEqual(E.spRotate.value, '360', 'the interval is kept for later');
    click(E, 'spPrev');
    await sleep(50);
    assert.strictEqual(t.fetchState.settings.activeSlotId, slotA.id);
    assert.deepStrictEqual(t.clock.pending(), [21600000], 'back in a rotating slot, the timer is armed again');
    assert.ok(E.bgShuffle.classList.contains('rotating'));

    // An overdue rotation (throttled timer / sleeping machine) fires as soon
    // as the tab is shown again — but not while it stays hidden.
    const beforeSleep = shown();
    t.clock.skip(21600000 + 5000);
    t.document.visibilityState = 'hidden';
    for (const fn of t.docListeners.visibilitychange) fn({});
    await sleep(0);
    assert.strictEqual(shown(), beforeSleep, 'a hidden tab waits for its timer');
    t.document.visibilityState = 'visible';
    for (const fn of t.docListeners.visibilitychange) fn({});
    await sleep(0);
    assert.notStrictEqual(shown(), beforeSleep, 'showing the tab catches up an overdue rotation');
    assert.deepStrictEqual(t.clock.pending(), [21600000], 'and arms exactly one fresh interval');

    // Off: the key is removed, the timer and tint are gone for good.
    click(E, 'appearanceBtn');
    choose(0);
    click(E, 'appearanceClose');
    assert.strictEqual(t.localStorage.getItem('sp-wallpaper-rotate'), null, 'off forgets the interval');
    assert.deepStrictEqual(t.clock.pending(), [], 'nothing scheduled once off');
    assert.ok(!E.bgShuffle.classList.contains('rotating'));
    assert.strictEqual(E.spRotateHint.textContent, '');
    const offShown = shown();
    await tick(86400000);
    assert.strictEqual(shown(), offShown, 'a day later, still the same wallpaper');
    console.log('  ok 31. timed rotation: shuffle-bag order, manual picks restart it, panel holds it, per browser');
  }

  /* ---------- Scenario 32: rotation persistence + preload ----------
     The interval survives a reload (an unknown stored value means off); the
     next original is fetched before the swap, a manual pick made meanwhile
     wins, and a failed load keeps the wallpaper on screen. */
  {
    const mkWp = (id) => ({ id, type: 'image/png', imageDark: true, accent: '', accentTouched: true });
    const slot = { id: 'rot-p', name: '', wallpapers: [mkWp('rp-1'), mkWp('rp-2'), mkWp('rp-3')] };
    const server = { slots: [slot], activeSlotId: slot.id };
    const grey = () => makeBitmap(1, 1, () => [128, 128, 128]);

    const kept = boot(grey, server, { 'sp-wallpaper-rotate': '30' }, undefined, { fakeClock: true });
    await sleep(30);
    assert.strictEqual(kept.elements.spRotate.value, '30', 'the stored interval comes back after a reload');
    assert.deepStrictEqual(kept.clock.pending(), [1800000], 'and is armed from page load');
    assert.ok(kept.elements.bgShuffle.classList.contains('rotating'));

    const junk = boot(grey, server, { 'sp-wallpaper-rotate': '7' }, undefined, { fakeClock: true });
    await sleep(30);
    assert.strictEqual(junk.elements.spRotate.value, '0', 'an unsupported stored interval reads as off');
    assert.deepStrictEqual(junk.clock.pending(), []);

    const images = [];
    class FakeImage { constructor() { images.push(this); } }
    const t = boot(grey, server, { 'sp-wallpaper-rotate': '5' }, undefined, { fakeClock: true, Image: FakeImage });
    await sleep(30);
    const bg = () => t.body.style.props['--sp-bg-image'];
    const first = bg();
    t.clock.advance(300000);
    await sleep(0);
    assert.strictEqual(images.length, 1, 'the next wallpaper is preloaded');
    assert.ok(/^\/api\/appearance\/wallpapers\/rp-[123]$/.test(images[0].src), 'from its original');
    assert.notStrictEqual('url("' + images[0].src + '")', first, 'and it is not the one on screen');
    assert.strictEqual(bg(), first, 'the swap waits for the image');
    images[0].onload();
    await sleep(0);
    assert.strictEqual(bg(), 'url("' + images[0].src + '")', 'swapped once loaded');
    assert.deepStrictEqual(t.clock.pending(), [300000]);

    // A manual pick while the next image is still loading wins.
    t.clock.advance(300000);
    await sleep(0);
    assert.strictEqual(images.length, 2);
    click(t.elements, 'bgShuffle');
    const manual = bg();
    images[1].onload();
    await sleep(0);
    assert.strictEqual(bg(), manual, 'a stale preload does not override the manual pick');
    assert.deepStrictEqual(t.clock.pending(), [300000], 'the manual pick armed the only interval');

    // A failed load keeps the wallpaper on screen and tries again later.
    t.clock.advance(300000);
    await sleep(0);
    assert.strictEqual(images.length, 3);
    images[2].onerror();
    await sleep(0);
    assert.strictEqual(bg(), manual, 'a wallpaper that fails to load is not swapped in');
    assert.deepStrictEqual(t.clock.pending(), [300000], 'the next attempt is one interval later');
    console.log('  ok 32. rotation interval persists per browser; preloaded swaps, stale and failed loads ignored');
  }

  console.log('all appearance tests passed');
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
