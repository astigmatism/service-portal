#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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
    contains: (name) => values.has(name)
  };
}

function element(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    classList: classList(),
    children: [],
    listeners: {},
    attrs: {},
    style: {},
    disabled: false,
    checked: false,
    textContent: '',
    innerHTML: '',
    title: '',
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    remove() {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    addEventListener(name, listener) { (this.listeners[name] = this.listeners[name] || []).push(listener); }
  };
}

function boot() {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const body = get('body');
  const calls = [];
  let confirmed = true;
  const document = {
    body,
    querySelector(selector) { return selector.startsWith('#') ? get(selector.slice(1)) : null; },
    querySelectorAll() { return []; },
    createElement: (tag) => element(tag)
  };
  const fetch = async (url, options) => {
    calls.push({ url, options: options || {} });
    if (url === '/api/services') {
      return { ok: true, status: 200, json: async () => ({ generatedAt: new Date().toISOString(), services: [] }) };
    }
    if (url.startsWith('/api/projects/')) {
      return {
        ok: true,
        status: 202,
        json: async () => ({
          job: { id: '1'.repeat(36), project: 'demo', state: 'running' }
        })
      };
    }
    if (url.startsWith('/api/maintenance/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          job: { id: '1'.repeat(36), project: 'demo', state: 'succeeded', logs: 'ok' }
        })
      };
    }
    throw new Error('unexpected fetch ' + url);
  };
  const sandbox = {
    document,
    fetch,
    location: { hostname: 'localhost' },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    console
  };
  sandbox.window = sandbox;
  sandbox.window.confirm = () => confirmed;
  vm.createContext(sandbox);
  const scriptStart = html.indexOf("'use strict';", html.indexOf('<script>'));
  const scriptEnd = html.indexOf('/* ===== Appearance (wallpaper + glass)', scriptStart);
  assert.ok(scriptStart > 0 && scriptEnd > scriptStart, 'main UI script bounds are present');
  vm.runInContext(html.slice(scriptStart, scriptEnd), sandbox);
  return {
    sandbox,
    elements,
    calls,
    setConfirmed(value) { confirmed = value; }
  };
}

test('sidebar update control is adjacent, confirmed, protected, and restart-aware', async (t) => {
  const app = boot();
  const service = {
    id: 'a'.repeat(12),
    name: 'demo-service',
    label: 'Demo',
    state: 'running',
    health: 'healthy',
    ports: [],
    self: false,
    update: { available: true, project: 'demo', job: null }
  };

  await t.test('the update button is rendered immediately before start/stop', () => {
    vm.runInContext('renderSidebar', app.sandbox)([service]);
    const row = app.elements.get('sideRows').children[0];
    const controls = row.children[row.children.length - 1];
    const buttons = controls.children.filter((child) => child.tagName === 'BUTTON');
    assert.equal(buttons.length, 2);
    assert.match(buttons[0].title, /Update and restart Demo/);
    assert.match(buttons[1].title, /Stop demo-service/);
  });

  await t.test('cancelling confirmation makes no mutating request', () => {
    const button = vm.runInContext('projectUpdateButton', app.sandbox)(service);
    const before = app.calls.filter((entry) => entry.url.startsWith('/api/projects/')).length;
    app.setConfirmed(false);
    button.listeners.click[0]({ stopPropagation() {}, preventDefault() {} });
    const after = app.calls.filter((entry) => entry.url.startsWith('/api/projects/')).length;
    assert.equal(after, before);
  });

  await t.test('confirmed updates send the non-simple action header and poll through restart', async () => {
    const button = vm.runInContext('projectUpdateButton', app.sandbox)(service);
    app.setConfirmed(true);
    button.listeners.click[0]({ stopPropagation() {}, preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const request = app.calls.find((entry) => entry.url === '/api/projects/demo/update');
    assert.ok(request);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['X-Service-Portal-Action'], 'update');
    assert.ok(app.calls.some((entry) => entry.url === '/api/maintenance/' + '1'.repeat(36)));
  });

  await t.test('an active job disables and animates the shared project control', () => {
    const active = {
      ...service,
      update: {
        available: true,
        project: 'demo',
        job: { id: '2'.repeat(36), project: 'demo', state: 'running' }
      }
    };
    // Prevent this isolated assertion from starting another background poll.
    app.sandbox.fetch = async () => new Promise(() => {});
    const button = vm.runInContext('projectUpdateButton', app.sandbox)(active);
    assert.equal(button.disabled, true);
    assert.match(button.className, /update-running/);
    assert.match(button.title, /in progress/);
  });
});
