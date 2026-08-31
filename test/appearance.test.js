#!/usr/bin/env node
'use strict';
/*
 * Zero-dependency test for the appearance IIFE in index.html:
 * wallpaper accent sampling, palette derivation, live CSS-variable
 * application, settings persistence, and the server-side accent
 * sanitization in server.js.
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
function mkFetch(state) {
  const respond = (status, obj) => ({ ok: status < 400, status, json: async () => obj });
  return async (url, opts) => {
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase();
    const body = () => JSON.parse(opts.body);
    if (url === '/api/appearance' && method === 'GET')
      return respond(200, { settings: { ...state.settings } });
    if (url === '/api/appearance' && method === 'PUT') {
      const sent = body();
      state.putBodies.push(sent);
      state.settings = { ...sent }; // the real server echoes its sanitized copy
      return respond(200, { ok: true, settings: { ...state.settings } });
    }
    if (url === '/api/appearance/background' && method === 'GET')
      return state.bgBlob
        ? { ok: true, status: 200, blob: async () => state.bgBlob }
        : { ok: false, status: 404, json: async () => ({}) };
    if (url === '/api/appearance/background' && method === 'POST') {
      state.posts.push({ type: (opts.headers || {})['Content-Type'], bytes: (opts.body || {}).size || 0 });
      return respond(200, { ok: true, bytes: 1 });
    }
    if (url === '/api/appearance/background' && method === 'DELETE') {
      state.deletes += 1;
      return respond(200, { ok: true });
    }
    return respond(404, {});
  };
}

const SERVER_DEFAULTS = {
  backgroundImage: '', backgroundPosition: 'center', imageDark: false,
  backgroundOpacity: 1, backgroundBlur: 0, scrim: 0, surfaceAlpha: 1,
  glassBlur: 0, accent: '', accentTouched: false
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
  const fetchState = {
    settings: serverSettings ? { ...SERVER_DEFAULTS, ...serverSettings } : { ...SERVER_DEFAULTS },
    putBodies: [], posts: [], deletes: 0
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

/* Fire the file input's change listener with the given fake file. */
function upload(elements, file) {
  const input = elements.spFile;
  input.files = [file];
  const l = input.listeners.change;
  assert.ok(l && l.length, 'file input has a change listener');
  l[0]();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Static sanity: the CSS consumes the theme variables.               */
/* ------------------------------------------------------------------ */
for (const needle of [
  '--panel-rgb:21,28,46', '--panel-2-rgb:28,39,64',
  '--header-a-rgb:20,27,45', '--header-b-rgb:16,22,38',
  '--head-rgb:24,34,58', '--hover-rgb:27,39,69', '--selftag-line:#2e4a75',
  'rgba(var(--panel-rgb),var(--sp-surface-alpha,1))',
  'rgba(var(--panel-2-rgb),var(--sp-surface-alpha,1))',
  'rgba(var(--header-a-rgb),var(--sp-surface-alpha,1))',
  'rgb(var(--head-rgb))', 'rgb(var(--hover-rgb))',
  'border:1px solid var(--selftag-line)'
]) {
  assert.ok(html.includes(needle), 'index.html CSS missing: ' + needle);
}

(async () => {
  /* ---------------- Scenario 1: red-dominant wallpaper ---------------- */
  {
    // 75% red / 25% blue → hue bucket 0 must win, re-normalized to S=.5 L=.46
    const t = boot(() => makeBitmap(64, 64, (_x, y) => (y < 48 ? [255, 60, 60] : [60, 60, 255])));
    await sleep(30); // let the startup fetch settle
    upload(t.elements, { type: 'image/png', size: 123 });
    await sleep(600); // debounce + settle

    assert.strictEqual(t.fetchState.posts.length, 1, 'wallpaper uploaded exactly once');
    const lastPut = t.fetchState.putBodies[t.fetchState.putBodies.length - 1];
    assert.strictEqual(lastPut.backgroundImage, 'server', 'settings point at the server wallpaper');
    assert.strictEqual(lastPut.accent, '#b03b3b', 'accent is the re-normalized dominant red (hsl 0 50% 46%)');

    const s = t.body.style.props;
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
    console.log('  ok 1. red-dominant upload → accent #b03b3b, full palette applied and persisted');
  }

  /* ---------------- Scenario 2: blue-only wallpaper ---------------- */
  {
    const t = boot(() => makeBitmap(64, 64, () => [60, 60, 255]));
    await sleep(30);
    upload(t.elements, { type: 'image/jpeg', size: 123 });
    await sleep(600);
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
    await sleep(600);
    const lastPut = t.fetchState.putBodies[t.fetchState.putBodies.length - 1];
    assert.strictEqual(lastPut.backgroundImage, 'server', 'gray wallpaper is still applied as background');
    assert.strictEqual(lastPut.accent, '', 'no usable hue → empty accent');
    assert.strictEqual(t.body.style.props['--accent'], undefined, 'theme variables cleared');
    assert.strictEqual(t.body.style.props['--bg'], undefined, 'bg variable cleared');
    assert.ok(!('data-sp-theme' in t.body.attrs), 'themed flag removed');
    console.log('  ok 3. gray upload → wallpaper applied, stock palette kept');
  }

  /* ---------------- Scenario 4: remove background clears theme ---------------- */
  {
    const t = boot(() => makeBitmap(64, 64, (_x, y) => (y < 48 ? [255, 60, 60] : [60, 60, 255])));
    await sleep(30);
    upload(t.elements, { type: 'image/png', size: 123 });
    await sleep(600);
    assert.strictEqual(t.body.style.props['--accent'], '#b03b3b', 'theme active after upload');
    const remove = t.elements.spRemove.listeners.click;
    assert.ok(remove && remove.length, 'remove button wired');
    remove[0]();
    await sleep(600);
    assert.strictEqual(t.fetchState.deletes, 1, 'DELETE sent');
    const lastPut = t.fetchState.putBodies[t.fetchState.putBodies.length - 1];
    assert.strictEqual(lastPut.backgroundImage, '');
    assert.strictEqual(lastPut.accent, '', 'accent cleared with the wallpaper');
    assert.strictEqual(t.body.style.props['--bg'], undefined, 'stock palette restored');
    console.log('  ok 4. removing the background clears the theme back to stock');
  }

  /* ---------- Scenario 5: legacy wallpaper gets its theme adopted ---------- */
  {
    // Server already holds a wallpaper whose accent was never decided
    // (uploaded before the auto color scheme existed).
    const t = boot(
      () => makeBitmap(64, 64, (_x, y) => (y < 48 ? [255, 60, 60] : [60, 60, 255])),
      { backgroundImage: 'server', accent: '', accentTouched: false }
    );
    t.fetchState.bgBlob = {}; // any object: createImageBitmap is stubbed
    await sleep(600); // startup fetch + background fetch + sample + PUT
    const puts = t.fetchState.putBodies;
    assert.strictEqual(puts.length, 1, 'exactly one adoption PUT');
    assert.strictEqual(puts[0].backgroundImage, 'server');
    assert.strictEqual(puts[0].accent, '#b03b3b', 'legacy wallpaper sampled and themed');
    assert.strictEqual(puts[0].accentTouched, true, 'marker stored so this never re-fires');
    assert.strictEqual(t.body.style.props['--accent'], '#b03b3b', 'theme live after adoption');
    console.log('  ok 5. pre-existing wallpaper adopts its theme on first load');
  }

  /* ---------- Scenario 6: reset colors keeps wallpaper, clears theme ---------- */
  {
    const t = boot(() => makeBitmap(64, 64, (_x, y) => (y < 48 ? [255, 60, 60] : [60, 60, 255])));
    await sleep(30);
    upload(t.elements, { type: 'image/png', size: 123 });
    await sleep(600);
    assert.strictEqual(t.body.style.props['--accent'], '#b03b3b', 'theme active after upload');
    const resetColors = t.elements.spResetColors.listeners.click;
    assert.ok(resetColors && resetColors.length, 'reset-colors button wired');
    resetColors[0]();
    await sleep(600);
    const lastPut = t.fetchState.putBodies[t.fetchState.putBodies.length - 1];
    assert.strictEqual(lastPut.backgroundImage, 'server', 'wallpaper kept');
    assert.strictEqual(lastPut.accent, '', 'theme cleared');
    assert.strictEqual(lastPut.accentTouched, true, 'clearance marked deliberate');
    assert.strictEqual(t.fetchState.deletes, 0, 'no DELETE sent');
    assert.strictEqual(t.body.style.props['--bg'], undefined, 'stock palette restored');
    console.log('  ok 6. reset colors drops the theme, keeps the wallpaper');
  }

  /* ---- Scenario 7: a deliberately cleared theme is not re-adopted ---- */
  {
    const t = boot(
      () => makeBitmap(64, 64, (_x, y) => (y < 48 ? [255, 60, 60] : [60, 60, 255])),
      { backgroundImage: 'server', accent: '', accentTouched: true }
    );
    t.fetchState.bgBlob = {};
    await sleep(600);
    assert.strictEqual(t.fetchState.putBodies.length, 0, 'no adoption PUT for a touched accent');
    assert.strictEqual(t.body.style.props['--accent'], undefined, 'cleared theme stays cleared');
    console.log('  ok 7. deliberately cleared theme survives a page reload');
  }

  /* ---------------- Scenario 8: server-side sanitization ---------------- */
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-appearance-test-'));
    const port = 18931;
    const proc = child.spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SELF_NAME: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    const base = 'http://127.0.0.1:' + port;
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(base + '/healthz');
          if (r.ok) break;
        } catch (e) { /* not up yet */ }
        await sleep(100);
      }
      const get = async () => (await (await fetch(base + '/api/appearance')).json()).settings;
      const put = async (obj) => (await (await fetch(base + '/api/appearance', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj)
      })).json()).settings;

      assert.strictEqual((await get()).accent, '', 'default settings carry an empty accent');
      assert.strictEqual((await put({ accent: '#AB12CD', backgroundOpacity: 0.4 })).accent, '#ab12cd', 'valid hex accepted and lowercased');
      assert.strictEqual((await get()).accent, '#ab12cd', 'accent persisted on the server');
      assert.strictEqual((await put({ accent: 'not-a-hex' })).accent, '', 'junk accent rejected');
      assert.strictEqual((await put({ accent: '#abc' })).accent, '', 'short hex rejected');
      assert.strictEqual((await put({ accent: '#GHIJKL' })).accent, '', 'non-hex chars rejected');
      assert.strictEqual((await put({ accent: 42 })).accent, '', 'non-string accent rejected');
      assert.strictEqual((await put({ accent: '#123456' })).accent, '#123456', 'accent survives unrelated saves');
      assert.strictEqual((await put({ accent: '', accentTouched: 1 })).accentTouched, true, 'accentTouched accepted (numeric coerce)');
      assert.strictEqual((await put({ accent: '', accentTouched: 'nope' })).accentTouched, false, 'junk accentTouched rejected');
      assert.strictEqual((await put({ accent: '', accentTouched: true })).accentTouched, true, 'accentTouched round-trips');
      assert.strictEqual((await get()).accentTouched, true, 'accentTouched persisted');
      console.log('  ok 8. server sanitizes and persists the accent fields');
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
