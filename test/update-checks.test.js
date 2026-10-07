#!/usr/bin/env node
'use strict';

/* Update checks: opted-in projects run their update script with `check` in a
   detached runner; the parsed result drives the Update control. Exercised
   end to end against a fake Docker Engine on a Unix socket. */

const test = require('node:test');
const assert = require('node:assert/strict');
const child = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function call(port, method, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const json = (response) => JSON.parse(response.body);
const CHECK = { 'X-Service-Portal-Action': 'check' };

function dockerLogFrame(text) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function appContainer(index, project, extraLabels) {
  return {
    Id: String(index).repeat(64).slice(0, 64),
    Names: ['/' + project + '-app'],
    Image: project + ':test',
    State: 'running',
    Status: 'Up 1 minute',
    Ports: [],
    Labels: {
      'com.docker.compose.project': project,
      'com.docker.compose.project.working_dir': '/srv/' + project,
      'io.service-portal.update.enabled': 'true',
      'io.service-portal.update.script': 'scripts/update.sh',
      'io.service-portal.update.image': project + '-updater:test',
      'io.service-portal.update.user': '1000:1000',
      ...extraLabels
    }
  };
}

/* A fake Docker Engine. `state.behavior[project]` scripts each check runner
   ({ logs, exitCode, hold }); update runners stay running until
   `state.updateHold` is cleared. */
function fakeDocker(socketPath, state) {
  state.calls = [];
  state.createBodies = [];
  state.runners = new Map();
  state.behavior = state.behavior || {};
  state.updateHold = true;
  let next = 0;
  const advance = (runner) => {
    if (!runner.running) return;
    if (runner.kind === 'check') {
      const behavior = state.behavior[runner.project] || {};
      if (behavior.hold) return;
      runner.logs = behavior.logs || '';
      runner.exitCode = Number.isInteger(behavior.exitCode) ? behavior.exitCode : 0;
    } else {
      if (state.updateHold) return;
      runner.logs = 'update done\n';
      runner.exitCode = 0;
    }
    runner.running = false;
    runner.status = 'exited';
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      state.calls.push({ method: req.method, path: req.url });
      const send = (status, value) => {
        const payload = Buffer.from(JSON.stringify(value));
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
        res.end(payload);
      };
      if (req.method === 'GET' && req.url === '/containers/json?all=1') {
        send(200, state.containers);
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/containers/create?name=')) {
        const spec = JSON.parse(body);
        state.createBodies.push(spec);
        next += 1;
        const id = ('e' + String(next)).padEnd(64, 'e').replace(/[^0-9a-f]/g, 'e');
        const kind = spec.Cmd && spec.Cmd[0] === 'check' ? 'check' : 'update';
        state.runners.set(id, {
          id, kind, spec, project: spec.Labels['io.service-portal.maintenance.project'],
          status: 'created', running: false, exitCode: null, logs: ''
        });
        send(201, { Id: id, Warnings: [] });
        return;
      }
      let match = req.url.match(/^\/containers\/([0-9a-f]{64})\/start$/);
      if (req.method === 'POST' && match && state.runners.has(match[1])) {
        const runner = state.runners.get(match[1]);
        runner.status = 'running';
        runner.running = true;
        res.writeHead(204);
        res.end();
        return;
      }
      match = req.url.match(/^\/containers\/([0-9a-f]{64})\/stop\?t=10$/);
      if (req.method === 'POST' && match) {
        const runner = state.runners.get(match[1]);
        if (runner) { runner.running = false; runner.status = 'exited'; runner.exitCode = 143; runner.stopped = true; }
        res.writeHead(204);
        res.end();
        return;
      }
      match = req.url.match(/^\/containers\/([0-9a-f]{64})\/json$/);
      if (req.method === 'GET' && match) {
        const runner = state.runners.get(match[1]);
        if (runner) {
          advance(runner);
          send(200, { State: { Status: runner.status, Running: runner.running, ExitCode: runner.exitCode,
            StartedAt: '2026-10-01T00:00:00.000Z', FinishedAt: runner.running ? '' : new Date().toISOString() } });
          return;
        }
        if (state.containers.some((c) => c.Id === match[1])) {
          send(200, { Config: { User: '' }, State: { Running: true, Status: 'running' } });
          return;
        }
      }
      match = req.url.match(/^\/containers\/([0-9a-f]{64})\/logs\?/);
      if (req.method === 'GET' && match && state.runners.has(match[1])) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.docker.multiplexed-stream' });
        res.end(dockerLogFrame(state.runners.get(match[1]).logs));
        return;
      }
      match = req.url.match(/^\/containers\/([0-9a-f]{64})\?force=1&v=1$/);
      if (req.method === 'DELETE' && match) {
        const runner = state.runners.get(match[1]);
        if (runner) runner.removed = true;
        state.containers = state.containers.filter((c) => c.Id !== match[1]);
        res.writeHead(204);
        res.end();
        return;
      }
      send(404, { message: 'fake Docker route not found: ' + req.method + ' ' + req.url });
    });
  });
  return new Promise((resolve, reject) => {
    try { fs.unlinkSync(socketPath); } catch (err) {}
    server.on('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

async function startPortal(t, dataDir, socketPath, env) {
  const port = await freePort();
  const proc = child.spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DOCKER_SOCKET: socketPath,
      SELF_NAME: 'nobody', POWER_GPU_PROBE: 'off',
      SERVICE_LABELS: JSON.stringify({ 'ready-app': { label: 'Ready App' } }),
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += chunk; });
  proc.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => proc.on('exit', resolve));
  t.after(async () => { proc.kill(); await exited; });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { if ((await call(port, 'GET', '/healthz')).status === 200) break; } catch (err) {}
    await sleep(50);
  }
  assert.equal((await call(port, 'GET', '/healthz')).status, 200, output);
  return { port, stop: async () => { proc.kill(); await exited; } };
}

async function services(port) {
  const response = await call(port, 'GET', '/api/services');
  assert.equal(response.status, 200, response.body);
  return Object.fromEntries(json(response).services.map((s) => [s.name.replace(/-app$/, ''), s]));
}

async function waitFor(what, predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
    await sleep(80);
  }
}

const READY_LOGS = [
  'Fetching origin/main...',
  'service-portal-check-note: Compared\twith origin/main.',
  'service-portal-check-commit: ' + B + ' 2026-10-01T10:00:00Z Fix \u202ethe\tthing',
  'service-portal-check-commit: ' + C + ' 2026-09-30T10:00:00+00:00 Add Y',
  'service-portal-check-commit: ' + D + ' not-a-date Tweak Z',
  'service-portal-check: status=available behind=3 deployed=' + A + ' target=' + B,
  ''
].join('\n');

test('update checks run opted-in project scripts and drive the Update control', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-update-checks-'));
  const socketPath = path.join(dataDir, 'docker.sock');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const state = {
    containers: [
      appContainer(1, 'ready', { 'io.service-portal.update.check': 'true', 'org.opencontainers.image.revision': A }),
      appContainer(2, 'current', { 'io.service-portal.update.check': 'true' }),
      appContainer(3, 'broken', { 'io.service-portal.update.check': 'true' }),
      appContainer(4, 'silent', { 'io.service-portal.update.check': 'true' }),
      appContainer(5, 'plain'),
      appContainer(6, 'slow', { 'io.service-portal.update.check': 'true' })
    ],
    behavior: {
      ready: { logs: READY_LOGS },
      current: { logs: 'service-portal-check: status=current behind=0 deployed=' + C + ' target=' + C + '\n' },
      broken: { exitCode: 1, logs: 'Error: refusing to update a checkout with uncommitted changes:\n M server.js\n' },
      silent: { logs: 'all good, I think\n' },
      slow: { hold: true }
    }
  };
  const docker = await fakeDocker(socketPath, state);
  t.after(() => docker.close());
  const { port } = await startPortal(t, dataDir, socketPath, {
    UPDATE_CHECK_FIRST_TICK_MS: '600000', // keep the scheduler out of the way
    UPDATE_CHECK_MIN_GAP_SECONDS: '0',
    UPDATE_CHECK_TIMEOUT_SECONDS: '2'
  });

  await t.test('only opted-in projects report a check, which starts unknown', async () => {
    const list = await services(port);
    assert.equal(list.plain.update.check, null);
    assert.equal(list.ready.update.available, true);
    assert.equal(list.ready.update.check.status, 'unknown');
    assert.equal(list.ready.update.check.checkedAt, null);
    assert.equal(list.ready.update.check.intervalMinutes, 15);
    assert.equal(state.createBodies.length, 0, 'listing never starts a check');
  });

  await t.test('the trigger route requires POST and the check action header', async () => {
    assert.equal((await call(port, 'GET', '/api/update-checks')).status, 405);
    assert.equal((await call(port, 'POST', '/api/update-checks')).status, 403);
    assert.equal((await call(port, 'POST', '/api/update-checks', { 'X-Service-Portal-Action': 'update' })).status, 403);
    assert.equal(state.createBodies.length, 0);
  });

  await t.test('checks run one at a time in detached runners and record their results', async () => {
    const response = await call(port, 'POST', '/api/update-checks', CHECK);
    assert.equal(response.status, 202, response.body);
    assert.deepEqual(json(response).queued.sort(), ['broken', 'current', 'ready', 'silent', 'slow']);
    const list = await waitFor('every check to finish', async () => {
      const current = await services(port);
      return ['ready', 'current', 'broken', 'silent', 'slow']
        .every((name) => current[name].update.check.checkedAt && !current[name].update.check.checking) && current;
    });

    const spec = state.createBodies.find((body) => body.Labels['io.service-portal.maintenance.project'] === 'ready');
    assert.deepEqual(spec.Cmd, ['check']);
    assert.deepEqual(spec.Entrypoint, ['/srv/ready/scripts/update.sh']);
    assert.equal(spec.Image, 'ready-updater:test');
    assert.equal(spec.User, '1000:1000');
    assert.equal(spec.WorkingDir, '/srv/ready');
    assert.ok(spec.HostConfig.Binds.includes('/srv/ready:/srv/ready'));
    assert.ok(spec.HostConfig.Binds.includes(socketPath + ':' + socketPath));
    assert.ok(spec.Env.includes('SERVICE_PORTAL_DEPLOYED_REVISION=' + A));
    assert.ok(spec.Env.includes('SERVICE_PORTAL_UPDATE_DELEGATED=1'));
    assert.equal(spec.Labels['io.service-portal.maintenance'], 'true');
    assert.match(spec.Labels['io.service-portal.maintenance.check'], /^[0-9a-f-]{36}$/);
    assert.equal(spec.Labels['io.service-portal.maintenance.job'], undefined);
    const current = state.createBodies.find((body) => body.Labels['io.service-portal.maintenance.project'] === 'current');
    assert.ok(current.Env.includes('SERVICE_PORTAL_DEPLOYED_REVISION='), 'an unrecorded revision is passed empty');
    assert.equal(state.createBodies.some((body) => body.Labels['io.service-portal.maintenance.project'] === 'plain'), false);

    assert.ok([...state.runners.values()].every((runner) => runner.removed), 'every check runner is removed');
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'maintenance')), [], 'checks are not maintenance jobs');
    assert.ok(fs.existsSync(path.join(dataDir, 'update-checks.json')));

    const ready = list.ready.update.check;
    assert.equal(ready.status, 'available');
    assert.equal(ready.behind, 3);
    assert.equal(ready.deployed, A);
    assert.equal(ready.target, B);
    assert.equal(ready.note, 'Compared with origin/main.');
    assert.deepEqual(ready.commits.map((c) => c.subject), ['Fix the thing', 'Add Y', 'Tweak Z']);
    assert.equal(ready.commits[0].committedAt, '2026-10-01T10:00:00.000Z');
    assert.equal(ready.commits[2].committedAt, null);
    assert.equal(list.current.update.check.status, 'current');
    assert.equal(list.current.update.check.behind, 0);
    assert.equal(list.broken.update.check.status, 'error');
    assert.match(list.broken.update.check.error, /uncommitted changes/);
    assert.equal(list.silent.update.check.status, 'error');
    assert.match(list.silent.update.check.error, /did not report a result/);
    assert.equal(list.slow.update.check.status, 'error');
    assert.match(list.slow.update.check.error, /timed out/);
    const slowRunner = [...state.runners.values()].find((runner) => runner.project === 'slow');
    assert.equal(slowRunner.stopped, true, 'a timed-out runner is stopped with a grace period');
    assert.equal(slowRunner.removed, true);
  });

  await t.test('a newly available update is announced in Activity exactly once', async () => {
    const events = () => call(port, 'GET', '/api/activity')
      .then((r) => json(r).events.filter((ev) => ev.kind === 'update-check'));
    let found = await events();
    assert.equal(found.length, 1);
    assert.equal(found[0].project, 'ready');
    assert.equal(found[0].state, 'available');
    assert.equal(found[0].message, 'Update available for Ready App: 3 commits behind');

    state.behavior.slow = { logs: 'service-portal-check: status=current behind=0 deployed=unknown target=unknown\n' };
    const before = (await services(port)).ready.update.check.checkedAt;
    assert.equal((await call(port, 'POST', '/api/update-checks', CHECK)).status, 202);
    await waitFor('the repeat check', async () => {
      const check = (await services(port)).ready.update.check;
      return check.checkedAt !== before && !check.checking;
    });
    found = await events();
    assert.equal(found.length, 1, 'the same target is not announced twice');

    state.behavior.ready = {
      logs: 'service-portal-check: status=available behind=1 deployed=' + A + ' target=' + C + '\n'
    };
    const again = (await services(port)).ready.update.check.checkedAt;
    assert.equal((await call(port, 'POST', '/api/update-checks', CHECK)).status, 202);
    await waitFor('the new-target check', async () => {
      const check = (await services(port)).ready.update.check;
      return check.checkedAt !== again && !check.checking;
    });
    found = await events();
    assert.equal(found.length, 2);
    assert.equal(found[0].message, 'Update available for Ready App: 1 commit behind');
  });

  await t.test('a result taken against another deployed revision reads as unknown', async () => {
    state.containers[0] = {
      ...state.containers[0],
      Labels: { ...state.containers[0].Labels, 'org.opencontainers.image.revision': C }
    };
    const check = (await services(port)).ready.update.check;
    assert.equal(check.status, 'unknown');
    assert.match(check.note, /changed since the last check/);
    assert.ok(check.checkedAt);
  });

  await t.test('an update waits for a running check of its project', async () => {
    state.behavior.ready = { hold: true, logs: 'service-portal-check: status=current behind=0 deployed=' + C + ' target=' + C + '\n' };
    const createdBefore = state.createBodies.length;
    assert.deepEqual(json(await call(port, 'POST', '/api/update-checks', CHECK)).queued.includes('ready'), true);
    const checkRunner = await waitFor('the ready check runner', () => [...state.runners.values()]
      .find((runner) => runner.project === 'ready' && runner.kind === 'check' && runner.running));
    const update = call(port, 'POST', '/api/projects/ready/update', { 'X-Service-Portal-Action': 'update' });
    await sleep(400);
    assert.equal(state.createBodies.slice(createdBefore).filter((body) => body.Cmd.length === 0).length, 0,
      'no update runner while the check runs');
    state.behavior.ready.hold = false;
    const response = await update;
    assert.equal(response.status, 202, response.body);
    assert.equal(checkRunner.removed, true);
    const order = state.calls.map((entry) => entry.method + ' ' + entry.path);
    const removedAt = order.indexOf('DELETE /containers/' + checkRunner.id + '?force=1&v=1');
    const createdAt = order.findIndex((entry, index) => index > removedAt && entry.startsWith('POST /containers/create?name=service-portal-update-ready-'));
    assert.ok(removedAt >= 0 && createdAt > removedAt, 'the update starts after the check finished');
    const check = (await services(port)).ready.update.check;
    assert.equal(check.status, 'current');
    assert.equal(json(await call(port, 'POST', '/api/update-checks', CHECK)).queued.includes('ready'), false,
      'no check starts while an action is active');
  });
});

test('the scheduler resumes persisted results, cleans leftovers, throttles, and re-checks after actions', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-update-schedule-'));
  const socketPath = path.join(dataDir, 'docker.sock');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const recent = new Date(Date.now() - 5000).toISOString();
  fs.writeFileSync(path.join(dataDir, 'update-checks.json'), JSON.stringify({
    ready: {
      status: 'current', startedAt: recent, checkedAt: recent, deployedInput: A, label: 'Ready App',
      behind: 0, deployed: A, target: A, commits: [], note: null, error: null, notifiedTarget: null
    }
  }));
  const leftover = (id, containerState) => ({
    Id: id, Names: ['/service-portal-check-old-' + id.slice(0, 4)], Image: 'x:test', State: containerState,
    Status: containerState, Ports: [],
    Labels: { 'io.service-portal.maintenance': 'true', 'io.service-portal.maintenance.check': 'old' }
  });
  const exitedLeftover = '7'.repeat(64);
  const runningLeftover = '8'.repeat(64);
  const state = {
    containers: [
      appContainer(1, 'ready', { 'io.service-portal.update.check': 'true', 'org.opencontainers.image.revision': A }),
      appContainer(2, 'current', { 'io.service-portal.update.check': 'true' }),
      leftover(exitedLeftover, 'exited'),
      leftover(runningLeftover, 'running')
    ],
    behavior: {
      ready: { logs: 'service-portal-check: status=current behind=0 deployed=' + A + ' target=' + A + '\n' },
      current: { logs: 'service-portal-check: status=current behind=0 deployed=unknown target=unknown\n' }
    }
  };
  const docker = await fakeDocker(socketPath, state);
  t.after(() => docker.close());
  const { port } = await startPortal(t, dataDir, socketPath, { UPDATE_CHECK_FIRST_TICK_MS: '150' });

  await t.test('a persisted result is served after a restart', async () => {
    const check = (await services(port)).ready.update.check;
    assert.equal(check.status, 'current');
    assert.equal(check.checkedAt, recent);
  });

  await t.test('the first tick removes leftover runners and checks never-checked projects only', async () => {
    await waitFor('the scheduled check', async () => (await services(port)).current.update.check.status === 'current');
    const paths = state.calls.map((entry) => entry.method + ' ' + entry.path);
    assert.ok(paths.includes('DELETE /containers/' + exitedLeftover + '?force=1&v=1'));
    assert.ok(paths.includes('POST /containers/' + runningLeftover + '/stop?t=10'));
    assert.ok(paths.includes('DELETE /containers/' + runningLeftover + '?force=1&v=1'));
    const projects = state.createBodies.map((body) => body.Labels['io.service-portal.maintenance.project']);
    assert.deepEqual(projects, ['current'], 'a fresh persisted result is not re-checked');
  });

  await t.test('browser-requested checks respect the minimum gap', async () => {
    const response = await call(port, 'POST', '/api/update-checks', CHECK);
    assert.equal(response.status, 202);
    assert.deepEqual(json(response).queued, []);
  });

  await t.test('a finished project action triggers a fresh check', async () => {
    state.updateHold = false;
    const response = await call(port, 'POST', '/api/projects/ready/update', { 'X-Service-Portal-Action': 'update' });
    assert.equal(response.status, 202, response.body);
    await waitFor('the post-update check', () => state.createBodies
      .some((body) => body.Cmd[0] === 'check' && body.Labels['io.service-portal.maintenance.project'] === 'ready'),
    10000);
  });
});
