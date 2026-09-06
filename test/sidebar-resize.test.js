#!/usr/bin/env node
'use strict';

/* The sidebar layout's right-edge drag handle: dragging it moves the panel's
   right edge (toward the centre widens it, back to the left narrows it), the
   width is clamped between 280px and "row minus the 240px wallpaper strip",
   it survives a reload through localStorage, and it snaps back to the default
   third on double-click / Enter. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const ROW_WIDTH = 1200;   // #listView.clientWidth in the fake DOM
const DEFAULT_SIDE = 400; // the panel's own width when nothing is stored

function classList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : !!force;
      enabled ? values.add(name) : values.delete(name);
      return enabled;
    },
    contains: (name) => values.has(name),
    _values: values
  };
}

function style() {
  const key = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return {
    setProperty(name, value) { this[key(name)] = String(value); },
    removeProperty(name) { delete this[key(name)]; }
  };
}

function element(tag, rect) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    classList: classList(),
    children: [],
    listeners: {},
    attrs: {},
    style: style(),
    disabled: false,
    checked: false,
    textContent: '',
    innerHTML: '',
    title: '',
    clientWidth: 0,
    getBoundingClientRect: () => rect || { left: 0, top: 0, width: 0, height: 0 },
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    remove() {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    getAttribute(name) { return this.attrs[name]; },
    addEventListener(name, listener) { (this.listeners[name] = this.listeners[name] || []).push(listener); }
  };
}

/* Boot the main UI script (everything before the Appearance block) in a fake
   DOM. `stored` seeds localStorage before the script runs. */
function boot(stored) {
  const elements = new Map();
  const appliedWidth = (el) => {
    const px = parseInt(String(el.style.flex || '').split(' ')[2], 10);
    return Number.isFinite(px) ? px : DEFAULT_SIDE;
  };
  const get = (id) => {
    if (!elements.has(id)) {
      const el = element(id, { left: 18, top: 70, width: id === 'sidebar' ? DEFAULT_SIDE : ROW_WIDTH, height: 600 });
      el.clientWidth = ROW_WIDTH;
      if (id === 'sidebar') {
        // A real panel's box follows its inline width, so the fake one must too
        // — otherwise the hover-proximity test measures against a stale edge.
        el.getBoundingClientRect = () => {
          const w = appliedWidth(el);
          return { left: 18, top: 70, width: w, height: 600, right: 18 + w };
        };
      }
      elements.set(id, el);
    }
    return elements.get(id);
  };
  const body = get('body');
  const document = {
    body,
    querySelector(selector) { return selector.startsWith('#') ? get(selector.slice(1)) : null; },
    querySelectorAll() { return []; },
    createElement: (tag) => element(tag)
  };
  const store = new Map(Object.entries(stored || {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  const windowListeners = {};
  const sandbox = {
    document,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ generatedAt: null, services: [] }) }),
    location: { hostname: 'localhost' },
    localStorage,
    innerWidth: ROW_WIDTH,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    console
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (name, listener) => {
    (windowListeners[name] = windowListeners[name] || []).push(listener);
  };
  sandbox.confirm = () => true;
  vm.createContext(sandbox);
  const scriptStart = html.indexOf("'use strict';", html.indexOf('<script>'));
  const scriptEnd = html.indexOf('/* ===== Appearance (wallpaper + glass)', scriptStart);
  assert.ok(scriptStart > 0 && scriptEnd > scriptStart, 'main UI script bounds are present');
  vm.runInContext(html.slice(scriptStart, scriptEnd), sandbox);
  const fire = (el, name, event) => {
    const listeners = el.listeners[name] || [];
    assert.ok(listeners.length, `${el.id || el.tagName} has a ${name} listener`);
    listeners.forEach((l) => l({ preventDefault() {}, ...event }));
  };
  const fireWindow = (name, event) => {
    (windowListeners[name] || []).forEach((l) => l({ preventDefault() {}, ...event }));
  };
  return {
    elements, body, localStorage, fire, fireWindow,
    side: () => get('sidebar'),
    row: () => get('listView'),
    grip: () => get('sideGrip'),
    width: () => appliedWidth(get('sidebar'))
  };
}

/* ------------------------------------------------------------------ */
/* Markup + CSS sanity.                                                */
/* ------------------------------------------------------------------ */
for (const needle of [
  'id="sideGrip" role="separator" tabindex="0"',
  '.side-grip{position:absolute;z-index:3;right:0;top:0;bottom:0',
  'cursor:col-resize',
  'touch-action:none;opacity:0;transition:opacity .16s ease}',
  '.side-grip.near,.side-grip.dragging,.side-grip:focus-visible{opacity:1}',
  'body.sp-side-resizing{cursor:col-resize;user-select:none}'
]) {
  assert.ok(html.includes(needle), 'index.html missing: ' + needle);
}

test('the handle is invisible until the pointer nears the panel edge', () => {
  const app = boot();
  assert.ok(!app.grip().classList.contains('near'), 'clean list by default');
  app.fire(app.row(), 'pointermove', { clientX: 900 });
  assert.ok(!app.grip().classList.contains('near'), 'far from the edge: still hidden');
  app.fire(app.row(), 'pointermove', { clientX: 400 }); // edge sits at 18 + 400
  assert.ok(app.grip().classList.contains('near'), 'within reach: fades in');
  app.fire(app.row(), 'pointerleave', {});
  assert.ok(!app.grip().classList.contains('near'), 'pointer leaves the row: fades out');
});

test('the handle stays revealed through a drag and just after it', () => {
  const app = boot();
  app.fire(app.row(), 'pointermove', { clientX: 400 });
  app.fire(app.grip(), 'pointerdown', { button: 0, clientX: 418 });
  app.fireWindow('pointermove', { clientX: 700 });
  assert.ok(app.grip().classList.contains('dragging'), 'drag marks itself');
  assert.ok(app.grip().classList.contains('near'), 'never hidden mid-drag');
  app.fireWindow('pointerup', {});
  assert.ok(!app.grip().classList.contains('dragging'), 'drag over');
  assert.ok(app.grip().classList.contains('near'), 'pointer still by the new edge: stays up');
});

test('dragging the handle toward the centre widens the sidebar', () => {
  const app = boot();
  app.fire(app.grip(), 'pointerdown', { button: 0, clientX: 418 });
  assert.ok(app.grip().classList.contains('dragging'), 'handle marks itself dragged');
  assert.ok(app.body.classList.contains('sp-side-resizing'), 'body tracks the drag');
  app.fireWindow('pointermove', { clientX: 538 });
  assert.equal(app.width(), 520, 'right edge follows the pointer (120px of travel)');
  assert.equal(app.side().style.maxWidth, '520px', 'max-width tracks the width');
  app.fireWindow('pointerup', {});
  assert.ok(!app.grip().classList.contains('dragging'), 'drag state cleared');
  assert.ok(!app.body.classList.contains('sp-side-resizing'), 'body released');
  assert.equal(app.localStorage.getItem('sp-sidebar-width'), '520', 'width persisted');
});

test('dragging back to the left narrows it, and the clamp keeps it usable', () => {
  const app = boot({ 'sp-sidebar-width': '538' });
  assert.equal(app.width(), 538, 'stored width restored on load');
  app.fire(app.grip(), 'pointerdown', { button: 0, clientX: 556 });
  app.fireWindow('pointermove', { clientX: 20 });
  assert.equal(app.width(), 280, 'never narrower than the panel min-width');
  app.fireWindow('pointermove', { clientX: 4000 });
  assert.equal(app.width(), ROW_WIDTH - 240, 'never wider than row minus the wallpaper strip');
  app.fireWindow('pointerup', {});
  assert.equal(app.localStorage.getItem('sp-sidebar-width'), String(ROW_WIDTH - 240));
});

test('double-click snaps back to the default third and forgets the width', () => {
  const app = boot({ 'sp-sidebar-width': '538' });
  app.fire(app.grip(), 'dblclick', {});
  assert.equal(app.side().style.flex, undefined, 'inline flex dropped back to the CSS default');
  assert.equal(app.side().style.maxWidth, undefined, 'inline max-width dropped');
  assert.equal(app.localStorage.getItem('sp-sidebar-width'), null, 'stored width forgotten');
});

test('keyboard: arrows nudge, Enter resets', () => {
  const app = boot();
  app.fire(app.grip(), 'keydown', { key: 'ArrowRight' });
  assert.equal(app.width(), DEFAULT_SIDE + 24, 'ArrowRight widens by one step');
  app.fire(app.grip(), 'keydown', { key: 'ArrowLeft' });
  assert.equal(app.width(), DEFAULT_SIDE, 'ArrowLeft narrows by one step');
  app.fire(app.grip(), 'keydown', { key: 'Enter' });
  assert.equal(app.localStorage.getItem('sp-sidebar-width'), null, 'Enter resets');
});

test('a shrunk window re-clamps the remembered width', () => {
  const app = boot({ 'sp-sidebar-width': '900' });
  assert.equal(app.width(), 900, 'stored width restored while it fits');
  app.elements.get('listView').clientWidth = 900;
  app.fireWindow('resize', {});
  assert.equal(app.width(), 900 - 240, 're-clamped to the narrower row');
});

test('the width you left it at is the width you come back to', () => {
  const visit = boot();
  visit.fire(visit.row(), 'pointermove', { clientX: 400 });
  visit.fire(visit.grip(), 'pointerdown', { button: 0, clientX: 418 });
  visit.fireWindow('pointermove', { clientX: 600 });
  visit.fireWindow('pointerup', {});
  const saved = visit.localStorage.getItem('sp-sidebar-width');
  assert.equal(saved, '582', 'the finalized width is saved on release');
  const back = boot({ 'sp-sidebar-width': saved }); // a later visit to the portal
  assert.equal(back.width(), 582, 'restored at the same position, no re-dragging');
  assert.ok(!back.grip().classList.contains('near'), 'and still hidden until the pointer nears');
});

test('a stored width below the minimum falls back to the default', () => {
  const app = boot({ 'sp-sidebar-width': '120' });
  assert.equal(app.side().style.flex, undefined, 'junk width ignored');
});
