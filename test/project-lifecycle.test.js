#!/usr/bin/env node
'use strict';

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
const ids = { reports: 'a'.repeat(64), runner: 'b'.repeat(64), other: 'c'.repeat(64) };

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function call(port, method, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

const json = (response) => JSON.parse(response.body);
const projectCall = (port, action) => call(port, 'POST', '/api/projects/betterbench/' + action,
  { 'X-Service-Portal-Action': action });

async function fakeDocker(socketPath, state) {
  const baseLabels = {
    'com.docker.compose.project': 'betterbench',
    'com.docker.compose.project.working_dir': '/srv/betterbench'
  };
  state.containers = [
    {
      Id: ids.reports, Names: ['/betterbench-reports'], Image: 'bench-reports:test',
      State: 'running', Status: 'Up (healthy)', Health: { Status: 'healthy' }, Ports: [],
      Labels: {
        ...baseLabels, 'com.docker.compose.service': 'reports',
        'io.service-portal.update.enabled': 'true',
        'io.service-portal.update.script': 'scripts/update-and-restart.sh',
        'io.service-portal.update.image': 'bench-updater:test',
        'io.service-portal.update.user': '123:456',
        'io.service-portal.lifecycle.services': 'reports,runner'
      }
    },
    {
      Id: ids.runner, Names: ['/bench-studio-runner'], Image: 'bench-runner:test',
      State: 'running', Status: 'Up (healthy)', Health: { Status: 'healthy' }, Ports: [],
      Labels: { ...baseLabels, 'com.docker.compose.service': 'runner', 'io.service-portal.hidden': 'true' }
    },
    {
      Id: ids.other, Names: ['/unrelated'], Image: 'other:test', State: 'running',
      Status: 'Up', Ports: [], Labels: {}
    }
  ];
  state.created = [];
  state.jobs = new Map();
  state.calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.calls.push({ method: req.method, path: req.url });
      const reply = (status, value) => {
        const payload = Buffer.from(JSON.stringify(value));
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
        res.end(payload);
      };
      if (req.method === 'GET' && req.url === '/containers/json?all=1') {
        state.listRequestedAt = new Date().toISOString();
        return reply(200, state.containers);
      }
      const inspect = req.url.match(/^\/containers\/([0-9a-f]{64})\/json$/);
      if (req.method === 'GET' && inspect) {
        if (inspect[1] === ids.reports) return reply(200, { Name: '/betterbench-reports', Config: { User: '0:0' } });
        if (inspect[1] === ids.other) return reply(200, { Name: '/unrelated' });
        const job = state.jobs.get(inspect[1]);
        if (job) return reply(200, { State: {
          Status: job.running ? 'running' : 'exited', Running: job.running,
          ExitCode: job.exitCode, StartedAt: '2026-09-26T10:00:00.000Z',
          FinishedAt: job.running ? '' : '2026-09-26T10:01:00.000Z'
        } });
      }
      if (req.method === 'POST' && req.url.startsWith('/containers/create?name=')) {
        state.createRequestedAt = new Date().toISOString();
        const spec = JSON.parse(body.toString());
        state.created.push(spec);
        const id = String(state.created.length).padStart(64, 'e');
        state.jobs.set(id, { running: false, exitCode: 0, logs: '' });
        return reply(201, { Id: id });
      }
      const start = req.url.match(/^\/containers\/([0-9a-f]{64})\/start$/);
      if (req.method === 'POST' && start && state.jobs.has(start[1])) {
        state.jobs.get(start[1]).running = true;
        res.writeHead(204); res.end(); return;
      }
      const direct = req.url.match(/^\/containers\/([0-9a-f]{12,64})\/(start|stop)$/);
      if (req.method === 'POST' && direct && ids.other.startsWith(direct[1])) {
        res.writeHead(204); res.end(); return;
      }
      const logs = req.url.match(/^\/containers\/([0-9a-f]{64})\/logs\?/);
      if (req.method === 'GET' && logs && state.jobs.has(logs[1])) {
        const content = Buffer.from(state.jobs.get(logs[1]).logs);
        const frame = Buffer.alloc(8);
        frame[0] = 1;
        frame.writeUInt32BE(content.length, 4);
        res.writeHead(200);
        res.end(Buffer.concat([frame, content]));
        return;
      }
      const remove = req.url.match(/^\/containers\/([0-9a-f]{64})\?force=1&v=1$/);
      if (req.method === 'DELETE' && remove && state.jobs.has(remove[1])) {
        state.jobs.get(remove[1]).removed = true;
        res.writeHead(204); res.end(); return;
      }
      reply(404, { message: 'fake Docker route not found: ' + req.method + ' ' + req.url });
    });
  });
  await new Promise((resolve, reject) => {
    try { fs.unlinkSync(socketPath); } catch {}
    server.on('error', reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

async function waitForState(port, jobId, wanted) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await call(port, 'GET', '/api/maintenance/' + jobId);
    if (response.status === 200 && json(response).job.state === wanted) return json(response).job;
    await sleep(75);
  }
  throw new Error('job did not reach ' + wanted);
}

test('opted project lifecycle uses both services and serializes detached jobs', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-lifecycle-test-'));
  const socketPath = path.join(dataDir, 'docker.sock');
  const state = {};
  const docker = await fakeDocker(socketPath, state);
  const port = await freePort();
  const proc = child.spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, DOCKER_SOCKET: socketPath,
      SERVICE_LABELS: JSON.stringify({ 'betterbench-reports': { label: 'Bench Studio' } }) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += chunk; });
  proc.stderr.on('data', (chunk) => { output += chunk; });
  t.after(() => { proc.kill(); docker.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { if ((await call(port, 'GET', '/healthz')).status === 200) break; } catch {}
    await sleep(50);
  }
  assert.equal((await call(port, 'GET', '/healthz')).status, 200, output);

  await t.test('one visible row reflects hidden, stopped, partial, and unhealthy members', async () => {
    const services = json(await call(port, 'GET', '/api/services')).services;
    assert.deepEqual(services.map((item) => item.name), ['betterbench-reports', 'unrelated']);
    assert.equal(services[0].label, 'Bench Studio');
    assert.equal(services[0].lifecycle.state, 'running');
    assert.deepEqual(services[0].lifecycle.services, ['reports', 'runner']);
    assert.deepEqual(services[0].lifecycle.members.map((member) => member.state), ['running', 'running']);
    state.containers[1].State = 'exited';
    assert.equal(json(await call(port, 'GET', '/api/services')).services[0].lifecycle.state, 'partial');
    state.containers[0].State = 'exited';
    assert.equal(json(await call(port, 'GET', '/api/services')).services[0].lifecycle.state, 'stopped');
    state.containers[0].State = 'running';
    state.containers[1].State = 'running';
    state.containers[1].Health.Status = 'unhealthy';
    assert.equal(json(await call(port, 'GET', '/api/services')).services[0].lifecycle.state, 'partial');
    state.containers[1].Health.Status = 'healthy';
    const savedHealth = state.containers[1].Health;
    delete state.containers[1].Health;
    state.containers[1].Status = 'Up 1 minute (unhealthy)';
    try {
      const statusFallback = json(await call(port, 'GET', '/api/services')).services[0].lifecycle;
      assert.equal(statusFallback.state, 'partial');
      assert.equal(statusFallback.members[1].health, 'unhealthy');
      state.containers[1].Status = 'Up 1 minute (health: starting)';
      assert.equal(json(await call(port, 'GET', '/api/services')).services[0].lifecycle.members[1].health,
        'starting');
    } finally {
      state.containers[1].Health = savedHealth;
      state.containers[1].Status = 'Up (healthy)';
    }
    state.containers[0].State = 'paused';
    state.containers[1].State = 'exited';
    assert.equal(json(await call(port, 'GET', '/api/services')).services[0].lifecycle.state, 'partial');
    state.containers[0].State = 'restarting';
    assert.equal(json(await call(port, 'GET', '/api/services')).services[0].lifecycle.state, 'partial');
    state.containers[0].State = 'running';
    state.containers[1].State = 'running';
    const hiddenRunner = state.containers.splice(1, 1)[0];
    try {
      const missing = json(await call(port, 'GET', '/api/services')).services[0].lifecycle;
      assert.equal(missing.state, 'partial');
      assert.equal(missing.members[1].state, 'missing');
    } finally { state.containers.splice(1, 0, hiddenRunner); }
  });

  await t.test('routes reject unconfigured actions and raw member controls', async () => {
    assert.equal((await call(port, 'GET', '/api/projects/betterbench/stop')).status, 405);
    assert.equal((await call(port, 'POST', '/api/projects/betterbench/stop')).status, 403);
    assert.equal((await call(port, 'POST', '/api/projects/betterbench/stop',
      { 'X-Service-Portal-Action': 'start' })).status, 403);
    assert.equal((await call(port, 'POST', '/api/projects/unknown/start',
      { 'X-Service-Portal-Action': 'start' })).status, 404);
    assert.equal((await call(port, 'POST', '/api/services/' + ids.reports.slice(0, 12) + '/stop')).status, 409);
    assert.equal((await call(port, 'POST', '/api/services/' + ids.runner.slice(0, 12) + '/start')).status, 409);
    assert.equal((await call(port, 'POST', '/api/services/' + ids.other.slice(0, 12) + '/stop')).status, 200);
    assert.ok(state.calls.some((entry) => entry.path === '/containers/' + ids.other.slice(0, 12) + '/stop'));
  });

  await t.test('malformed and conflicting opt-ins cannot launch project actions', async () => {
    const reports = state.containers[0];
    const runner = state.containers[1];
    const original = reports.Labels['io.service-portal.lifecycle.services'];
    try {
      for (const bad of ['reports,../runner', 'reports,reports', 'runner']) {
        reports.Labels['io.service-portal.lifecycle.services'] = bad;
        assert.equal((await projectCall(port, 'start')).status, 404, bad);
      }
      reports.Labels['io.service-portal.lifecycle.services'] = original;
      runner.Labels['io.service-portal.lifecycle.services'] = original;
      assert.equal((await projectCall(port, 'stop')).status, 404);
    } finally {
      reports.Labels['io.service-portal.lifecycle.services'] = original;
      delete runner.Labels['io.service-portal.lifecycle.services'];
    }
    const duplicate = { ...runner, Id: 'd'.repeat(64), Names: ['/stale-runner'] };
    state.containers.push(duplicate);
    try {
      assert.equal((await projectCall(port, 'start')).status, 404,
        'duplicate Compose service names disable the lifecycle action');
      assert.equal(json(await call(port, 'GET', '/api/services')).services[0].lifecycle, null);
    } finally { state.containers.pop(); }
  });

  let stopJob;
  await t.test('Stop inherits updater configuration and excludes concurrent Update or Start', async () => {
    const response = await projectCall(port, 'stop');
    assert.equal(response.status, 202, response.body);
    stopJob = json(response).job;
    assert.equal(stopJob.action, 'stop');
    const spec = state.created[0];
    assert.equal(spec.Image, 'bench-updater:test');
    assert.deepEqual(spec.Entrypoint, ['/srv/betterbench/scripts/update-and-restart.sh']);
    assert.deepEqual(spec.Cmd, ['stop']);
    assert.equal(spec.User, '123:456');
    assert.ok(spec.Env.includes('SERVICE_PORTAL_ACTION_REQUESTED_AT=' + stopJob.createdAt));
    assert.ok(Date.parse(stopJob.createdAt) <= Date.parse(state.listRequestedAt),
      'the cutoff is captured before Docker discovery');
    assert.ok(Date.parse(stopJob.createdAt) <= Date.parse(state.createRequestedAt),
      'the cutoff is captured before launching the detached helper');
    assert.ok(spec.HostConfig.Binds.includes('/srv/betterbench:/srv/betterbench'));
    assert.ok(spec.HostConfig.Binds.includes(socketPath + ':' + socketPath));
    assert.equal((await projectCall(port, 'update')).status, 409);
    assert.equal((await projectCall(port, 'start')).status, 409);
    assert.equal(state.created.length, 1);
  });

  await t.test('failed Stop exposes actionable error and persists activity', async () => {
    const runner = [...state.jobs.values()][0];
    runner.running = false;
    runner.exitCode = 7;
    runner.logs = 'Error: could not cancel active review\n';
    const job = await waitForState(port, stopJob.id, 'failed');
    assert.match(job.error, /could not cancel active review/);
    assert.match(job.logs, /could not cancel active review/);
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'maintenance', stopJob.id + '.json')));
    assert.equal(persisted.action, 'stop');
    assert.equal(persisted.state, 'failed');
    const event = json(await call(port, 'GET', '/api/activity')).events.find((item) => item.id === stopJob.id);
    assert.equal(event.kind, 'project');
    assert.equal(event.action, 'stop');
    assert.match(event.message, /Stop failed/);
  });

  await t.test('Start and Update can run after a completed Stop job', async () => {
    const response = await projectCall(port, 'start');
    assert.equal(response.status, 202, response.body);
    const startJob = json(response).job;
    assert.equal(startJob.action, 'start');
    assert.deepEqual(state.created[1].Cmd, ['start']);
    assert.equal((await projectCall(port, 'stop')).status, 409);
    const startRunner = [...state.jobs.values()][1];
    startRunner.running = false;
    startRunner.logs = 'both services healthy\n';
    assert.equal((await waitForState(port, startJob.id, 'succeeded')).action, 'start');
    state.containers[0].State = 'exited';
    state.containers[1].State = 'exited';
    const update = await projectCall(port, 'update');
    assert.equal(update.status, 202, update.body);
    assert.deepEqual(state.created[2].Cmd, []);
    assert.equal(json(update).job.action, 'update');
    const updateRunner = [...state.jobs.values()][2];
    updateRunner.running = false;
    assert.equal((await waitForState(port, json(update).job.id, 'succeeded')).action, 'update');
  });

  await t.test('simultaneous project requests reserve the project before Docker discovery', async () => {
    const before = state.created.length;
    const [start, stop] = await Promise.all([projectCall(port, 'start'), projectCall(port, 'stop')]);
    assert.deepEqual([start.status, stop.status].sort(), [202, 409]);
    assert.equal(state.created.length, before + 1);
  });
});
