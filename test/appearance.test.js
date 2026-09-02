#!/usr/bin/env node
'use strict';
/*
 * Zero-dependency test for the appearance IIFE in index.html:
 * wallpaper collection navigation (prev/next, delete, multi-upload),
 * per-wallpaper accent sampling, palette derivation, live CSS-variable
 * application, settings persistence, and the server-side wallpaper
 * collection endpoints in server.js (including the legacy
 * single-wallpaper migration).
 *
 *   node test/appearance.test.js
 *
 * The IIFE is extracted verbatim from index.html and run in a vm context
 * with minimal DOM/canvas/fetch stubs, so the real shipping code is what
 * gets exercised (no copy drift). Not shipped in the container image.
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
const marker = '/* ===== Appearance (wallpaper + glass)';
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
    textContent: '',
    disabled: false,
    files: []
  };
  el.setAttribute = (k, v) => { el.attrs[k] = v; };
  el.removeAttribute = (k) => { delete el.attrs[k]; };
  el.toggleAttribute = (k, on) => { on ? el.setAttribute(k, '') : el.removeAttribute(k); };
  el.addEventListener = (type, fn) => { (el.listeners[type] = el.listeners[type] || []).push(fn); };
  el.click = () => {};
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

/* Fetch stub emulating the server's wallpaper-collection protocol: the
   settings PUT carries sliders + the active pointer only (the collection
   is owned by the wallpaper endpoints), structural endpoints return the
   fresh settings, and deleting an active wallpaper re-selects the entry
   before it. */
function mkFetch(state) {
  const respond = (status, obj) => ({ ok: status < 400, status, json: async () => obj });
  const WP_ITEM = /^\/api\/appearance\/wallpapers\/([^/]+)$/;
  return async (url, opts) => {
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};

    if (url === '/api/appearance' && method === 'GET')
      return respond(200, { settings: clone(state.settings) });

    if (url === '/api/appearance' && method === 'PUT') {
      const sent = JSON.parse(opts.body);
      state.putBodies.push(sent);
      const has = state.settings.wallpapers.some((w) => w.id === sent.activeWallpaperId);
      state.settings.backgroundPosition = sent.backgroundPosition;
      state.settings.backgroundOpacity = sent.backgroundOpacity;
      state.settings.backgroundBlur = sent.backgroundBlur;
      state.settings.scrim = sent.scrim;
      state.settings.surfaceAlpha = sent.surfaceAlpha;
      state.settings.glassBlur = sent.glassBlur;
      if (state.settings.wallpapers.length === 0) state.settings.activeWallpaperId = null;
      else if (has) state.settings.activeWallpaperId = sent.activeWallpaperId;
      return respond(200, { ok: true, settings: clone(state.settings) });
    }

    if (url === '/api/appearance/wallpapers' && method === 'POST') {
      state.posts.push({
        type: headers['Content-Type'],
        dark: headers['x-sp-image-dark'],
        accent: headers['x-sp-accent'],
        bytes: (opts.body || {}).size || 0
      });
      const wallpaper = {
        id: 'wp-' + String(state.nextId++).padStart(4, '0'),
        type: String(headers['Content-Type'] || '').split(';')[0],
        imageDark: headers['x-sp-image-dark'] === '1',
        accent: typeof headers['x-sp-accent'] === 'string' && /^#[0-9a-fA-F]{6}$/.test(headers['x-sp-accent'])
          ? headers['x-sp-accent'].toLowerCase() : '',
        accentTouched: true
      };
      state.settings.wallpapers.push(wallpaper);
      state.settings.activeWallpaperId = wallpaper.id;
      state.blobs.set(wallpaper.id, {});
      return respond(200, { ok: true, wallpaper: clone(wallpaper), settings: clone(state.settings) });
    }

    if (url === '/api/appearance/wallpapers' && method === 'DELETE') {
      state.deletesAll += 1;
      state.settings.wallpapers = [];
      state.settings.activeWallpaperId = null;
      return respond(200, { ok: true, settings: clone(state.settings) });
    }

    const m = String(url).match(WP_ITEM);
    if (m) {
      const id = m[1];
      const idx = state.settings.wallpapers.findIndex((w) => w.id === id);
      if (method === 'GET') {
        if (idx === -1) return respond(404, {});
        return { ok: true, status: 200, blob: async () => state.blobs.get(id) || {} };
      }
      if (method === 'PUT') {
        if (idx === -1) return respond(404, {});
        const sent = JSON.parse(opts.body);
        state.metaPuts.push({ id, body: sent });
        const e = state.settings.wallpapers[idx];
        if (typeof sent.imageDark === 'boolean') e.imageDark = sent.imageDark;
        if (typeof sent.accent === 'string')
          e.accent = /^#[0-9a-fA-F]{6}$/.test(sent.accent) ? sent.accent.toLowerCase() : '';
        if (typeof sent.accentTouched === 'boolean') e.accentTouched = sent.accentTouched;
        return respond(200, { ok: true, wallpaper: clone(e), settings: clone(state.settings) });
      }
      if (method === 'DELETE') {
        if (idx === -1) return respond(404, {});
        state.deletes.push(id);
        const prevActive = state.settings.activeWallpaperId;
        const wallpapers = state.settings.wallpapers.filter((w) => w.id !== id);
        state.settings.wallpapers = wallpapers;
        if (wallpapers.length === 0) state.settings.activeWallpaperId = null;
        else if (prevActive === id) state.settings.activeWallpaperId = wallpapers[Math.max(0, idx - 1)].id;
        return respond(200, { ok: true, settings: clone(state.settings) });
      }
      return respond(405, {});
    }

    return respond(404, {});
  };
}

const SERVER_DEFAULTS = {
  wallpapers: [], activeWallpaperId: null, backgroundPosition: 'center',
  backgroundOpacity: 1, backgroundBlur: 0, scrim: 0, surfaceAlpha: 1,
  glassBlur: 0
};

function boot(bitmapFactory, serverSettings) {
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
      wallpapers: Array.isArray(ss.wallpapers) ? clone(ss.wallpapers) : []
    },
    blobs: new Map(),
    putBodies: [], posts: [], deletes: [], deletesAll: 0, metaPuts: [],
    nextId: 1
  };
  const sandbox = {
    document: documentStub,
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
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { elements, body, fetchState };
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
  '.sp-nav{', 'accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple>'
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
  /* ---------------- Scenario 1: red-dominant upload ----------------
     One upload appends one wallpaper; the newest becomes active; the
     sampled accent + palette follow it; the active pointer is persisted. */
  {
    // 75% red / 25% blue → hue bucket 0 must win, re-normalized to S=.5 L=.46
    const t = boot(() => makeBitmap(64, 64, (_x, y) => (y < 48 ? [255, 60, 60] : [60, 60, 255])));
    await sleep(30); // let the startup fetch settle
    upload(t.elements, { type: 'image/png', size: 123 });
    await sleep(500); // settle

    assert.strictEqual(t.fetchState.posts.length, 1, 'wallpaper uploaded exactly once');
    assert.strictEqual(t.fetchState.posts[0].type, 'image/png', 'image content type sent');
    assert.strictEqual(t.fetchState.posts[0].accent, '#b03b3b', 'sampled accent sent with the upload');
    const st = t.fetchState.settings;
    assert.strictEqual(st.wallpapers.length, 1, 'collection holds the new wallpaper');
    assert.strictEqual(st.wallpapers[0].accent, '#b03b3b', 'entry keeps the re-normalized dominant red');
    assert.strictEqual(st.wallpapers[0].accentTouched, true, 'accent marked decided on upload');
    assert.strictEqual(st.activeWallpaperId, st.wallpapers[0].id, 'the new wallpaper is active');
    const lastPut = t.fetchState.putBodies[t.fetchState.putBodies.length - 1];
    assert.strictEqual(lastPut.activeWallpaperId, st.wallpapers[0].id, 'active pointer persisted');

    const s = t.body.style.props;
    assert.strictEqual(s['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + st.wallpapers[0].id + '")', 'background points at the wallpaper endpoint');
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
    // First and only wallpaper: neither nav button shows, counter reads 1 of 1.
    assert.ok(!t.elements.spNav.classList.contains('hidden'), 'nav row visible');
    assert.ok(t.elements.spPrev.classList.contains('hidden'), 'previous hidden on the first');
    assert.ok(t.elements.spNext.classList.contains('hidden'), 'next hidden on the last');
    assert.strictEqual(t.elements.spNavCount.textContent, '1 of 1');
    console.log('  ok 1. red upload → wallpaper appended, active, accent #b03b3b, palette applied and persisted');
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
    assert.strictEqual(st.wallpapers.length, 1, 'gray wallpaper is still added to the collection');
    assert.strictEqual(st.wallpapers[0].accent, '', 'no usable hue → empty accent');
    assert.strictEqual(t.body.style.props['--accent'], undefined, 'theme variables cleared');
    assert.strictEqual(t.body.style.props['--bg'], undefined, 'bg variable cleared');
    assert.ok(!('data-sp-theme' in t.body.attrs), 'themed flag removed');
    assert.ok(t.elements.spResetColors.disabled, 'reset colors disabled for a hueless wallpaper');
    console.log('  ok 3. gray upload → wallpaper applied, stock palette kept');
  }

  /* ---------- Scenario 4: remove deletes the landed wallpaper ---------- */
  {
    const t = boot(() => makeBitmap(64, 64, (_x, y) => (y < 48 ? [255, 60, 60] : [60, 60, 255])));
    await sleep(30);
    upload(t.elements, { type: 'image/png', size: 123 });
    await sleep(500);
    assert.strictEqual(t.body.style.props['--accent'], '#b03b3b', 'theme active after upload');
    const id = t.fetchState.settings.wallpapers[0].id;
    click(t.elements, 'spRemove');
    await sleep(500);
    assert.deepStrictEqual(t.fetchState.deletes, [id], 'DELETE sent for the landed wallpaper');
    assert.strictEqual(t.fetchState.deletesAll, 0, 'not the delete-all endpoint');
    assert.strictEqual(t.fetchState.settings.wallpapers.length, 0, 'collection empty');
    assert.strictEqual(t.fetchState.settings.activeWallpaperId, null);
    assert.strictEqual(t.body.style.props['--sp-bg-image'], 'none', 'background cleared');
    assert.strictEqual(t.body.style.props['--bg'], undefined, 'stock palette restored');
    assert.ok(t.elements.spNav.classList.contains('hidden'), 'nav row hidden with no wallpapers');
    assert.strictEqual(t.fetchState.putBodies[t.fetchState.putBodies.length - 1].activeWallpaperId, null,
      'cleared pointer persisted');
    console.log('  ok 4. removing the current wallpaper deletes it and clears the theme back to stock');
  }

  /* ---------- Scenario 5: legacy wallpaper gets its theme adopted ---------- */
  {
    // Server already holds a wallpaper whose accent was never decided
    // (uploaded before the auto color scheme existed).
    const legacyId = 'deadbeef-0000-4000-8000-000000000001';
    const t = boot(
      () => makeBitmap(64, 64, (_x, y) => (y < 48 ? [255, 60, 60] : [60, 60, 255])),
      { wallpapers: [{ id: legacyId, type: 'image/png', imageDark: false, accent: '', accentTouched: false }],
        activeWallpaperId: legacyId }
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
    assert.strictEqual(st.wallpapers.length, 1, 'wallpaper kept');
    assert.strictEqual(st.wallpapers[0].accentTouched, true, 'entry remembers the deliberate reset');
    assert.strictEqual(t.fetchState.deletes.length + t.fetchState.deletesAll, 0, 'no DELETE sent');
    assert.strictEqual(t.body.style.props['--bg'], undefined, 'stock palette restored');
    console.log('  ok 6. reset colors drops the theme, keeps the wallpaper');
  }

  /* ---- Scenario 7: a deliberately cleared theme is not re-adopted ---- */
  {
    const legacyId = 'deadbeef-0000-4000-8000-000000000002';
    const t = boot(
      () => makeBitmap(64, 64, (_x, y) => (y < 48 ? [255, 60, 60] : [60, 60, 255])),
      { wallpapers: [{ id: legacyId, type: 'image/png', imageDark: false, accent: '', accentTouched: true }],
        activeWallpaperId: legacyId }
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

  /* ---------- Scenario 9: prev/next walks the collection ---------- */
  {
    let mode = 'red';
    const t = boot(() => makeBitmap(64, 64, () => (mode === 'red' ? [255, 60, 60] : [60, 60, 255])));
    await sleep(30);
    upload(t.elements, { type: 'image/png', size: 1 });
    await sleep(500);
    mode = 'blue';
    upload(t.elements, { type: 'image/png', size: 1 });
    await sleep(500);
    const st = t.fetchState.settings;
    assert.strictEqual(st.wallpapers.length, 2, 'two wallpapers in the collection');
    const [a, b] = st.wallpapers;
    assert.strictEqual(a.accent, '#b03b3b', 'first wallpaper keeps its red accent');
    assert.strictEqual(b.accent, '#3b3bb0', 'second wallpaper keeps its blue accent');
    assert.strictEqual(st.activeWallpaperId, b.id, 'second upload is active');
    assert.strictEqual(t.body.style.props['--accent'], '#3b3bb0', 'theme follows the active wallpaper');
    assert.strictEqual(t.elements.spNavCount.textContent, '2 of 2');
    assert.ok(!t.elements.spPrev.classList.contains('hidden'), 'previous visible off the first');
    assert.ok(t.elements.spNext.classList.contains('hidden'), 'next hidden on the last');

    click(t.elements, 'spPrev');
    await sleep(400);
    assert.strictEqual(t.fetchState.settings.activeWallpaperId, a.id, 'previous moves the active pointer');
    assert.strictEqual(t.body.style.props['--accent'], '#b03b3b', 'theme switched back to red');
    assert.strictEqual(t.body.style.props['--sp-bg-image'],
      'url("/api/appearance/wallpapers/' + a.id + '")', 'background switched to the first wallpaper');
    assert.strictEqual(t.elements.spNavCount.textContent, '1 of 2');
    assert.ok(t.elements.spPrev.classList.contains('hidden'), 'previous hidden on the first');
    assert.ok(!t.elements.spNext.classList.contains('hidden'), 'next visible off the first');
    // The switch is a structural change: persisted immediately (no debounce).
    assert.strictEqual(t.fetchState.putBodies[t.fetchState.putBodies.length - 1].activeWallpaperId, a.id,
      'active pointer persisted right away');

    click(t.elements, 'spNext');
    await sleep(400);
    assert.strictEqual(t.fetchState.settings.activeWallpaperId, b.id, 'next moves forward');
    assert.strictEqual(t.body.style.props['--accent'], '#3b3bb0', 'theme switched to blue again');
    assert.strictEqual(t.elements.spNavCount.textContent, '2 of 2');
    console.log('  ok 9. prev/next walks the collection, hides at the ends, follows the theme');
  }

  /* ---------- Scenario 10: deleting a middle wallpaper ---------- */
  {
    const t = boot(() => makeBitmap(64, 64, () => [128, 128, 128]));
    await sleep(30);
    upload(t.elements, { type: 'image/png', size: 1 }, { type: 'image/png', size: 2 }, { type: 'image/png', size: 3 });
    await sleep(700);
    assert.strictEqual(t.fetchState.settings.wallpapers.length, 3, 'three wallpapers');
    click(t.elements, 'spPrev'); // last → middle
    await sleep(400);
    assert.strictEqual(t.elements.spNavCount.textContent, '2 of 3');
    const middle = t.fetchState.settings.wallpapers[1].id;
    click(t.elements, 'spRemove');
    await sleep(500);
    const st = t.fetchState.settings;
    assert.deepStrictEqual(t.fetchState.deletes, [middle], 'the middle wallpaper was deleted');
    assert.strictEqual(st.wallpapers.length, 2, 'collection closed the gap');
    assert.strictEqual(st.activeWallpaperId, st.wallpapers[0].id, 'active fell back to the previous entry');
    assert.strictEqual(t.elements.spNavCount.textContent, '1 of 2');
    console.log('  ok 10. deleting a middle wallpaper closes the gap and re-selects the previous one');
  }

  /* ---------- Scenario 11: multi-file upload appends in order ---------- */
  {
    const t = boot(() => makeBitmap(64, 64, () => [128, 128, 128]));
    await sleep(30);
    upload(t.elements, { type: 'image/png', size: 1 }, { type: 'image/png', size: 2 });
    await sleep(700);
    assert.strictEqual(t.fetchState.posts.length, 2, 'each file uploaded exactly once');
    const st = t.fetchState.settings;
    assert.strictEqual(st.wallpapers.length, 2, 'both files became wallpapers');
    assert.strictEqual(st.activeWallpaperId, st.wallpapers[1].id, 'the last file is active');
    assert.strictEqual(t.elements.spNavCount.textContent, '2 of 2');
    console.log('  ok 11. multi-file upload appends each file and activates the last');
  }

  /* ---------- Scenario 12: real server — collection protocol ---------- */
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
      const postWp = async (bytes, extra) => (await (await fetch(base + '/api/appearance/wallpapers', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'x-sp-image-dark': '0', 'x-sp-accent': '', ...(extra || {}) },
        body: bytes
      })).json());

      let s = await get();
      assert.deepStrictEqual(s.wallpapers, [], 'fresh server has an empty collection');
      assert.strictEqual(s.activeWallpaperId, null, 'fresh server has no active wallpaper');

      const a = (await postWp(Buffer.from('img-a'))).wallpaper;
      assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'server mints a uuid id');
      s = await get();
      assert.strictEqual(s.wallpapers.length, 1);
      assert.strictEqual(s.activeWallpaperId, a.id, 'the upload is active');

      const r = await fetch(base + '/api/appearance/wallpapers/' + a.id);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get('content-type'), 'image/png', 'stored content type served back');
      assert.strictEqual(Buffer.from(await r.arrayBuffer()).toString(), 'img-a', 'bytes round-trip');

      const b = (await postWp(Buffer.from('img-b'), { 'x-sp-accent': '#AB12CD', 'x-sp-image-dark': '1' })).wallpaper;
      assert.strictEqual(b.accent, '#ab12cd', 'accent header stored and lowercased');
      assert.strictEqual(b.imageDark, true, 'darkness header stored');
      assert.strictEqual(b.accentTouched, true, 'server records the client-decided accent');
      s = await get();
      assert.strictEqual(s.activeWallpaperId, b.id, 'the newest upload is active');

      s = await put({ activeWallpaperId: a.id, scrim: 0.42 });
      assert.strictEqual(s.activeWallpaperId, a.id, 'PUT switches the active pointer');
      assert.strictEqual(s.scrim, 0.42, 'sliders persist with the switch');
      s = await put({ activeWallpaperId: 'bogus', scrim: 0.1 });
      assert.strictEqual(s.activeWallpaperId, a.id, 'a bogus active pointer is ignored');
      assert.strictEqual(s.scrim, 0.1, 'sliders still saved');

      const m = await (await fetch(base + '/api/appearance/wallpapers/' + b.id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accent: '', accentTouched: true })
      })).json();
      assert.strictEqual(m.wallpaper.accent, '', 'meta PUT clears the accent');
      assert.strictEqual(m.wallpaper.accentTouched, true, 'meta PUT records the deliberate reset');

      s = (await (await fetch(base + '/api/appearance/wallpapers/' + a.id, { method: 'DELETE' })).json()).settings;
      assert.strictEqual(s.wallpapers.length, 1, 'delete closes the collection');
      assert.strictEqual(s.activeWallpaperId, b.id, 'active falls back to the previous entry');
      assert.strictEqual((await fetch(base + '/api/appearance/wallpapers/' + a.id)).status, 404, 'deleted wallpaper 404s');

      const lg = await fetch(base + '/api/appearance/background');
      assert.strictEqual(Buffer.from(await lg.arrayBuffer()).toString(), 'img-b',
        'legacy endpoint serves the active wallpaper');

      s = (await (await fetch(base + '/api/appearance/wallpapers', { method: 'DELETE' })).json()).settings;
      assert.deepStrictEqual(s.wallpapers, [], 'delete-all empties the collection');
      assert.strictEqual(s.activeWallpaperId, null);
      assert.strictEqual((await fetch(base + '/api/appearance/background')).status, 404,
        'legacy endpoint 404s with no wallpaper');
      assert.strictEqual(
        (await fetch(base + '/api/appearance/wallpapers/00000000-0000-4000-0000-000000000000', { method: 'DELETE' })).status,
        404, 'unknown wallpaper 404s');
      console.log('  ok 12. real server: append/switch/delete/wipe collection protocol');
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
      assert.strictEqual(s.wallpapers.length, 1, 'legacy wallpaper migrated into the collection');
      assert.strictEqual(s.wallpapers[0].type, 'image/webp', 'legacy MIME type carried over');
      assert.strictEqual(s.wallpapers[0].imageDark, true, 'legacy darkness carried over');
      assert.strictEqual(s.wallpapers[0].accent, '#ab12cd', 'legacy sampled accent carried over');
      assert.strictEqual(s.wallpapers[0].accentTouched, true, 'legacy touched marker carried over');
      assert.strictEqual(s.activeWallpaperId, s.wallpapers[0].id, 'migrated wallpaper is active');
      assert.strictEqual(s.scrim, 0.5, 'global sliders carried over');
      const r = await fetch(base + '/api/appearance/wallpapers/' + s.wallpapers[0].id);
      assert.strictEqual(Buffer.from(await r.arrayBuffer()).toString(), 'legacy-bytes', 'legacy image bytes served');
      assert.ok(!fs.existsSync(path.join(dataDir, 'background.bin')), 'legacy file consumed');
      console.log('  ok 13. real server: legacy background.bin migrates into the collection on boot');
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
