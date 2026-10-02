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
    style: {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; }
    },
    disabled: false,
    checked: false,
    textContent: '',
    innerHTML: '',
    title: '',
    clientWidth: 1200,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 600 }),
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
  let confirmPrompt = '';
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
    if (url === '/api/update-checks') {
      return { ok: true, status: 202, json: async () => ({ ok: true, queued: [] }) };
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
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    innerWidth: 1200,
    addEventListener() {},
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    console
  };
  sandbox.window = sandbox;
  sandbox.window.confirm = (prompt) => { confirmPrompt = prompt; return confirmed; };
  vm.createContext(sandbox);
  const scriptStart = html.indexOf("'use strict';", html.indexOf('<script>'));
  const scriptEnd = html.indexOf('/* ===== Appearance (wallpaper slots + glass)', scriptStart);
  assert.ok(scriptStart > 0 && scriptEnd > scriptStart, 'main UI script bounds are present');
  vm.runInContext(html.slice(scriptStart, scriptEnd), sandbox);
  return {
    sandbox,
    elements,
    calls,
    setConfirmed(value) { confirmed = value; },
    lastConfirm() { return confirmPrompt; }
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

test('HTTPS is inferred from either side of a port mapping and preferred for service links', () => {
  const app = boot();
  const service = {
    id: 'b'.repeat(12),
    name: 'secure-service',
    label: 'Secure service',
    image: 'example/secure:latest',
    state: 'running',
    health: 'healthy',
    statusLine: 'Up 1 minute (healthy)',
    ports: [
      { containerPort: 80, hostPort: 8080, hostIp: '0.0.0.0', protocol: 'tcp' },
      { containerPort: 443, hostPort: 8444, hostIp: '0.0.0.0', protocol: 'tcp' }
    ],
    self: false,
    update: null
  };

  const schemeFor = vm.runInContext('schemeFor', app.sandbox);
  const primaryPort = vm.runInContext('primaryPort', app.sandbox);
  assert.equal(schemeFor(service.ports[0]), 'http');
  assert.equal(schemeFor(service.ports[1]), 'https', 'container port 443 remains HTTPS on a custom host port');
  assert.equal(
    schemeFor({ containerPort: 3000, hostPort: 9443 }),
    'https',
    'a conventional HTTPS host port is still recognized'
  );
  assert.equal(primaryPort(service).hostPort, 8444, 'HTTPS wins over an earlier HTTP mapping');

  vm.runInContext('renderTable', app.sandbox)([service]);
  const tableRow = app.elements.get('rows').children[0];
  assert.equal(tableRow.title, 'https://localhost:8444/');

  vm.runInContext('renderSidebar', app.sandbox)([service]);
  const sidebarRow = app.elements.get('sideRows').children[0];
  assert.equal(sidebarRow.children[1].href, 'https://localhost:8444/');
});

test('a proxy URL is the default in both layouts, even without published app ports', () => {
  for (const ports of [[], [{ containerPort: 8000, hostPort: 8000, hostIp: '192.168.1.5' }]]) {
    const app = boot();
    const service = {
      id: 'c'.repeat(12), name: 'image-app', image: 'image-app:test',
      state: 'running', ports, url: 'https://image-studio.lan:8443/'
    };
    assert.equal(vm.runInContext('hasLink', app.sandbox)(service), true);
    vm.runInContext('renderTable', app.sandbox)([service]);
    const row = app.elements.get('rows').children[0];
    assert.equal(row.title, service.url);
    assert.equal(row.className, 'linkable');
    const buttons = row.children[2].children[0].children;
    assert.equal(buttons[0].textContent, 'Open HTTPS');
    assert.equal(buttons[0].title, service.url);
    if (ports.length) assert.equal(buttons[1].title, 'http://192.168.1.5:8000/');
    vm.runInContext('renderSidebar', app.sandbox)([service]);
    const link = app.elements.get('sideRows').children[0].children[1];
    assert.equal(link.tagName, 'A');
    assert.equal(link.href, service.url);
  }
});

test('project lifecycle controls cover stopped and partial groups in both layouts', async () => {
  const app = boot();
  const base = {
    id: 'a'.repeat(12), name: 'betterbench-reports', label: 'Bench Studio',
    url: 'http://192.168.1.23:9001/',
    image: 'bench:test', state: 'exited', health: null, statusLine: 'Exited',
    ports: [], self: false,
    update: { available: true, project: 'betterbench', job: null },
    lifecycle: {
      available: true, project: 'betterbench', services: ['reports', 'runner'],
      members: [{ service: 'reports', state: 'exited', health: null },
        { service: 'runner', state: 'exited', health: null }],
      state: 'stopped', job: null
    }
  };

  vm.runInContext('renderSidebar', app.sandbox)([base]);
  let sidebarRow = app.elements.get('sideRows').children[0];
  let controls = sidebarRow.children.at(-1);
  let buttons = controls.children.filter((child) => child.tagName === 'BUTTON');
  assert.equal(buttons.length, 2, 'stopped project has Update and project Start');
  assert.equal(sidebarRow.children[0].className, 'dot bad');
  assert.match(sidebarRow.children[0].title, /Stopped \(0\/2\)/);
  assert.equal(controls.children.filter((child) => child.className === 'selftag').length, 0);
  assert.match(buttons[1].title, /Start Bench Studio project/);
  assert.doesNotMatch(buttons[1].title, /Start betterbench-reports$/);
  buttons[1].listeners.click[0]({ stopPropagation() {}, preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 35));
  let request = app.calls.find((entry) => entry.url === '/api/projects/betterbench/start');
  assert.ok(request, 'Start targets the project route');
  assert.equal(request.options.headers['X-Service-Portal-Action'], 'start');

  const partial = {
    ...base, state: 'running', health: 'healthy',
    lifecycle: { ...base.lifecycle, state: 'partial',
      members: [{ service: 'reports', state: 'running', health: 'healthy' },
        { service: 'runner', state: 'exited', health: null }] }
  };
  vm.runInContext('renderSidebar', app.sandbox)([partial]);
  sidebarRow = app.elements.get('sideRows').children.at(-1);
  controls = sidebarRow.children.at(-1);
  buttons = controls.children.filter((child) => child.tagName === 'BUTTON');
  assert.equal(buttons.length, 3, 'partial project offers Update, Start, and Stop');
  assert.equal(sidebarRow.children[0].className, 'dot warn');
  assert.match(sidebarRow.children[0].title, /runner: exited/);
  assert.equal(controls.children.filter((child) => child.className === 'selftag').length, 0);
  app.setConfirmed(false);
  buttons[2].listeners.click[0]({ stopPropagation() {}, preventDefault() {} });
  assert.equal(app.calls.filter((entry) => entry.url === '/api/projects/betterbench/stop').length, 0);
  assert.match(app.lastConfirm(), /cancels and deletes all unfinished benchmark and review jobs/);
  app.setConfirmed(true);
  buttons[2].listeners.click[0]({ stopPropagation() {}, preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 35));
  request = app.calls.find((entry) => entry.url === '/api/projects/betterbench/stop');
  assert.ok(request, 'Stop targets the project route');
  assert.equal(request.options.headers['X-Service-Portal-Action'], 'stop');

  vm.runInContext('renderTable', app.sandbox)([partial]);
  const tableStatus = app.elements.get('rows').children[0].children[3];
  assert.match(tableStatus.children[0].textContent, /Partial \(1\/2\).*runner: exited/);
  assert.equal(tableStatus.children[1].children.length, 3, 'table also offers both recovery actions');

  const running = { ...base, state: 'running', health: 'healthy',
    lifecycle: { ...base.lifecycle, state: 'running',
      members: base.lifecycle.members.map((member) => ({ ...member, state: 'running', health: 'healthy' })) } };
  vm.runInContext('renderSidebar', app.sandbox)([running]);
  sidebarRow = app.elements.get('sideRows').children.at(-1);
  assert.equal(sidebarRow.children[0].className, 'dot ok');
  assert.match(sidebarRow.children[0].title, /Running \(2\/2\)/);
  assert.equal(sidebarRow.children.at(-1).children.filter((child) => child.className === 'selftag').length, 0);

  const activeJob = { id: '2'.repeat(36), project: 'betterbench', action: 'stop', state: 'running' };
  const busy = { ...partial,
    update: { ...partial.update, job: activeJob },
    lifecycle: { ...partial.lifecycle, job: activeJob } };
  app.sandbox.fetch = async () => new Promise(() => {});
  vm.runInContext('renderSidebar', app.sandbox)([busy]);
  controls = app.elements.get('sideRows').children.at(-1).children.at(-1);
  buttons = controls.children.filter((child) => child.tagName === 'BUTTON');
  assert.ok(buttons.every((button) => button.disabled),
    'an active project job disables Update, Start, and Stop together');

  const unrelated = { ...base, id: 'c'.repeat(12), name: 'unrelated', label: 'Unrelated',
    update: null, lifecycle: null };
  vm.runInContext('renderSidebar', app.sandbox)([unrelated]);
  controls = app.elements.get('sideRows').children.at(-1).children.at(-1);
  buttons = controls.children.filter((child) => child.tagName === 'BUTTON');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].title, 'Start unrelated', 'other projects retain container controls');
});

test('update checks disable a current project and explain a pending update', async (t) => {
  const app = boot();
  const base = {
    id: 'd'.repeat(12), name: 'bench-reports', label: 'Bench', state: 'running', health: 'healthy',
    ports: [], self: false
  };
  const withCheck = (check) => ({ ...base, update: { available: true, project: 'bench', job: null, check } });
  const button = (service) => vm.runInContext('projectUpdateButton', app.sandbox)(service);
  const checkedAt = new Date(Date.now() - 60000).toISOString();

  await t.test('opening the page asks the server for checks with the action header', () => {
    const request = app.calls.find((entry) => entry.url === '/api/update-checks');
    assert.ok(request, 'boot requests update checks');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['X-Service-Portal-Action'], 'check');
  });

  await t.test('a current project keeps Update disabled and says so', () => {
    const b = button(withCheck({ status: 'current', checking: false, checkedAt, behind: 0,
      deployed: 'a'.repeat(40), target: 'a'.repeat(40), commits: [], note: null, error: null }));
    assert.equal(b.disabled, true);
    assert.match(b.title, /^Bench is up to date \(aaaaaaa\)/);
    assert.match(b.title, /Checked /);
    assert.equal(b.children.length, 0, 'no badge');
    assert.equal((b.listeners.click || []).length, 0, 'nothing to click');
  });

  await t.test('an available update is enabled, badged, and lists how far behind it is', async () => {
    const commits = Array.from({ length: 7 }, (_, i) => ({
      revision: String(i + 1).repeat(40), committedAt: new Date(Date.now() - (i + 2) * 3600000).toISOString(),
      subject: 'Change ' + (i + 1)
    }));
    const service = withCheck({ status: 'available', checking: false, checkedAt, behind: 12,
      deployed: 'a'.repeat(40), target: 'b'.repeat(40), commits, note: null, error: null });
    const b = button(service);
    assert.equal(b.disabled, false);
    assert.match(b.className, /update-ready/);
    assert.equal(b.children.length, 1);
    assert.equal(b.children[0].className, 'ctlbadge');
    assert.equal(b.children[0].textContent, '12');
    const lines = b.title.split('\n');
    assert.equal(lines[0], 'Update and restart Bench \u2014 12 commits behind \u00b7 newest 2 h ago');
    assert.equal(lines[1], '\u2022 Change 1');
    assert.equal(lines[5], '\u2022 Change 5');
    assert.equal(lines[6], '\u2026and 7 more');
    assert.equal(lines[7], 'aaaaaaa \u2192 bbbbbbb');
    assert.match(lines[8], /^Checked /);

    app.setConfirmed(false);
    b.listeners.click[0]({ stopPropagation() {}, preventDefault() {} });
    assert.match(app.lastConfirm(), /12 new commits will be deployed/);
    assert.equal(app.calls.filter((entry) => entry.url === '/api/projects/bench/update').length, 0);
  });

  await t.test('a large or unknown distance stays readable in the badge', () => {
    const many = button(withCheck({ status: 'available', behind: 250, commits: [], checkedAt }));
    assert.equal(many.children[0].textContent, '99+');
    const unknown = button(withCheck({ status: 'available', behind: null, commits: [], checkedAt,
      note: 'The running revision is not in this checkout.' }));
    assert.equal(unknown.children[0].textContent, '!');
    assert.match(unknown.title, /an update is available/);
    assert.match(unknown.title, /not in this checkout/);
  });

  await t.test('a failed, pending, or missing check never blocks an update', () => {
    const failed = button(withCheck({ status: 'error', checking: false, checkedAt,
      error: 'Error: refusing to update a checkout with uncommitted changes:' }));
    assert.equal(failed.disabled, false);
    assert.match(failed.title, /^Update and restart Bench\nCould not check for updates: Error: refusing/);
    const pending = button(withCheck({ status: 'unknown', checking: true, checkedAt: null }));
    assert.equal(pending.disabled, false);
    assert.match(pending.title, /Checking for updates/);
    const legacy = button({ ...base, update: { available: true, project: 'bench', job: null } });
    assert.equal(legacy.disabled, false);
    assert.equal(legacy.title, 'Update and restart Bench');
  });

  await t.test('an active job still wins over the check result', () => {
    app.sandbox.fetch = async () => new Promise(() => {});
    const b = button({ ...base, update: { available: true, project: 'bench',
      job: { id: '3'.repeat(36), project: 'bench', state: 'running' },
      check: { status: 'current', checkedAt } } });
    assert.equal(b.disabled, true);
    assert.match(b.className, /update-running/);
    assert.match(b.title, /in progress/);
  });
});
