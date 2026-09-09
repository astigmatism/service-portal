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

function json(response) {
  return JSON.parse(response.body);
}

function dockerLogFrame(text, stream) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream || 1;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function fakeDocker(socketPath, state) {
  const portalId = 'a'.repeat(64);
  const siblingId = 'b'.repeat(64);
  const unsafeId = 'c'.repeat(64);
  const helperId = 'd'.repeat(64);
  const conflictOneId = 'f'.repeat(64);
  const conflictTwoId = '9'.repeat(64);
  const badHomeId = '8'.repeat(64);
  state.portalId = portalId;
  state.runners = new Map();
  state.calls = [];
  state.createBodies = [];
  state.containers = [
    {
      Id: portalId,
      Names: ['/portal'],
      Image: 'service-portal:test',
      State: 'running',
      Status: 'Up 1 minute',
      Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp', IP: '0.0.0.0' }],
      Labels: {
        'com.docker.compose.project': 'portal-project',
        'com.docker.compose.project.working_dir': '/srv/portal project',
        'io.service-portal.update.enabled': 'true',
        'io.service-portal.update.script': 'scripts/update-and-restart.sh',
        'io.service-portal.update.image': 'portal-updater:test',
        'io.service-portal.update.user': '123:456',
        'io.service-portal.update.host-home': '/home/tester'
      }
    },
    {
      Id: siblingId,
      Names: ['/portal-worker'],
      Image: 'worker:test',
      State: 'exited',
      Status: 'Exited (0)',
      Ports: [],
      Labels: {
        'com.docker.compose.project': 'portal-project',
        'com.docker.compose.project.working_dir': '/srv/portal project'
      }
    },
    {
      Id: unsafeId,
      Names: ['/unsafe'],
      Image: 'unsafe:test',
      State: 'running',
      Status: 'Up',
      Ports: [],
      Labels: {
        'com.docker.compose.project': 'unsafe',
        'com.docker.compose.project.working_dir': '/srv/unsafe',
        'io.service-portal.update.enabled': 'true',
        'io.service-portal.update.script': '../host-command'
      }
    },
    {
      Id: helperId,
      Names: ['/hidden-maintenance-helper'],
      Image: 'portal-updater:test',
      State: 'running',
      Status: 'Up',
      Ports: [],
      Labels: { 'io.service-portal.maintenance': 'true' }
    },
    {
      Id: badHomeId,
      Names: ['/bad-home'],
      Image: 'runner:test',
      State: 'running',
      Status: 'Up',
      Ports: [],
      Labels: {
        'com.docker.compose.project': 'bad-home',
        'com.docker.compose.project.working_dir': '/srv/bad-home',
        'io.service-portal.update.enabled': 'true',
        'io.service-portal.update.script': 'scripts/update.sh',
        'io.service-portal.update.host-home': '/'
      }
    },
    {
      Id: conflictOneId,
      Names: ['/conflict-one'],
      Image: 'runner:test',
      State: 'running',
      Status: 'Up',
      Ports: [],
      Labels: {
        'com.docker.compose.project': 'conflict',
        'com.docker.compose.project.working_dir': '/srv/conflict',
        'io.service-portal.update.enabled': 'true',
        'io.service-portal.update.script': 'scripts/one.sh'
      }
    },
    {
      Id: conflictTwoId,
      Names: ['/conflict-two'],
      Image: 'runner:test',
      State: 'running',
      Status: 'Up',
      Ports: [],
      Labels: {
        'com.docker.compose.project': 'conflict',
        'com.docker.compose.project.working_dir': '/srv/conflict',
        'io.service-portal.update.enabled': 'true',
        'io.service-portal.update.script': 'scripts/two.sh'
      }
    }
  ];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.calls.push({ method: req.method, path: req.url, body: body.toString('utf8') });
      const sendJson = (status, value) => {
        const payload = Buffer.from(JSON.stringify(value));
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
        res.end(payload);
      };
      if (req.method === 'GET' && req.url === '/containers/json?all=1') {
        sendJson(200, state.containers);
        return;
      }
      if (req.method === 'GET' && req.url === '/containers/' + portalId + '/json') {
        sendJson(200, { Config: { User: '999:999' }, State: { Running: true, Status: 'running' } });
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/containers/create?name=')) {
        const spec = JSON.parse(body.toString('utf8'));
        state.createBodies.push(spec);
        const id = String(state.createBodies.length).padStart(64, 'e');
        state.runners.set(id, {
          status: 'created',
          running: false,
          exitCode: 0,
          logs: 'maintenance complete\n'
        });
        sendJson(201, { Id: id, Warnings: [] });
        return;
      }
      const start = req.url.match(/^\/containers\/([0-9a-f]{64})\/start$/);
      if (req.method === 'POST' && start && state.runners.has(start[1])) {
        const runner = state.runners.get(start[1]);
        runner.status = 'running';
        runner.running = true;
        res.writeHead(204);
        res.end();
        return;
      }
      const inspect = req.url.match(/^\/containers\/([0-9a-f]{64})\/json$/);
      if (req.method === 'GET' && inspect && state.runners.has(inspect[1])) {
        const runner = state.runners.get(inspect[1]);
        sendJson(200, {
          State: {
            Status: runner.status,
            Running: runner.running,
            ExitCode: runner.exitCode,
            StartedAt: '2026-08-31T20:00:00.000Z',
            FinishedAt: runner.running ? '' : '2026-08-31T20:01:00.000Z'
          }
        });
        return;
      }
      const logs = req.url.match(/^\/containers\/([0-9a-f]{64})\/logs\?/);
      if (req.method === 'GET' && logs && state.runners.has(logs[1])) {
        const payload = dockerLogFrame(state.runners.get(logs[1]).logs);
        res.writeHead(200, { 'Content-Type': 'application/vnd.docker.multiplexed-stream' });
        res.end(payload);
        return;
      }
      const remove = req.url.match(/^\/containers\/([0-9a-f]{64})\?force=1&v=1$/);
      if (req.method === 'DELETE' && remove && state.runners.has(remove[1])) {
        state.runners.get(remove[1]).removed = true;
        res.writeHead(204);
        res.end();
        return;
      }
      sendJson(404, { message: 'fake Docker route not found: ' + req.method + ' ' + req.url });
    });
  });
  return new Promise((resolve, reject) => {
    try { fs.unlinkSync(socketPath); } catch (err) {}
    server.on('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

async function waitForJob(port, id, wanted) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const response = await call(port, 'GET', '/api/maintenance/' + id);
    if (response.status === 200 && json(response).job.state === wanted) return json(response).job;
    await sleep(100);
  }
  throw new Error('job ' + id + ' did not reach ' + wanted);
}

test('project updates are validated, detached, monitored, and persisted', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-maintenance-test-'));
  const socketPath = path.join(dataDir, 'docker.sock');
  const state = {};
  const docker = await fakeDocker(socketPath, state);
  const port = await freePort();
  const proc = child.spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DOCKER_SOCKET: socketPath,
      SELF_NAME: 'portal',
      PORTAL_TITLE: 'Maintenance Test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  proc.stdout.on('data', (chunk) => { serverOutput += chunk; });
  proc.stderr.on('data', (chunk) => { serverOutput += chunk; });

  t.after(async () => {
    proc.kill();
    docker.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { if ((await call(port, 'GET', '/healthz')).status === 200) break; } catch (err) {}
    await sleep(50);
  }
  assert.equal((await call(port, 'GET', '/healthz')).status, 200, serverOutput);

  await t.test('discovery includes stopped containers, shares project capability, and hides runners', async () => {
    const response = await call(port, 'GET', '/api/services');
    assert.equal(response.status, 200);
    const services = json(response).services;
    assert.deepEqual(services.map((service) => service.name),
      ['bad-home', 'conflict-one', 'conflict-two', 'portal', 'portal-worker', 'unsafe']);
    assert.equal(services.find((service) => service.name === 'portal-worker').state, 'exited');
    assert.equal(services.find((service) => service.name === 'portal-worker').update.project, 'portal-project');
    assert.equal(services.find((service) => service.name === 'unsafe').update, null);
    assert.equal(services.find((service) => service.name === 'bad-home').update, null);
    assert.equal(services.find((service) => service.name === 'conflict-one').update, null);
    assert.ok(state.calls.some((entry) => entry.path === '/containers/json?all=1'));
  });

  await t.test('the update endpoint enforces method, action header, opt-in, and path validation', async () => {
    assert.equal((await call(port, 'GET', '/api/projects/portal-project/update')).status, 405);
    assert.equal((await call(port, 'POST', '/api/projects/portal-project/update')).status, 403);
    assert.equal((await call(port, 'POST', '/api/projects/missing/update', {
      'X-Service-Portal-Action': 'update'
    })).status, 404);
    assert.equal((await call(port, 'POST', '/api/projects/unsafe/update', {
      'X-Service-Portal-Action': 'update'
    })).status, 404);
    assert.equal((await call(port, 'POST', '/api/projects/conflict/update', {
      'X-Service-Portal-Action': 'update'
    })).status, 404);
  });

  let firstJob;
  let firstRunnerId;
  await t.test('a valid request creates one least-privilege detached runner', async () => {
    const response = await call(port, 'POST', '/api/projects/portal-project/update', {
      'X-Service-Portal-Action': 'update'
    });
    assert.equal(response.status, 202, response.body);
    firstJob = json(response).job;
    assert.equal(firstJob.project, 'portal-project');
    assert.equal(firstJob.state, 'running');
    const spec = state.createBodies[0];
    assert.equal(spec.Image, 'portal-updater:test');
    assert.deepEqual(spec.Entrypoint, ['/srv/portal project/scripts/update-and-restart.sh']);
    assert.equal(spec.WorkingDir, '/srv/portal project');
    assert.equal(spec.User, '123:456');
    assert.equal(spec.HostConfig.AutoRemove, false);
    assert.ok(spec.HostConfig.Binds.includes('/srv/portal project:/srv/portal project'));
    assert.ok(spec.HostConfig.Binds.includes(socketPath + ':' + socketPath));
    assert.deepEqual(spec.HostConfig.Mounts, [{
      Type: 'bind', Source: '/home/tester', Target: '/home/tester', ReadOnly: false
    }]);
    assert.ok(spec.Env.includes('SERVICE_PORTAL_UPDATE_HOST_HOME=/home/tester'));
    assert.equal(spec.Labels['io.service-portal.maintenance'], 'true');
    firstRunnerId = [...state.runners.keys()][0];

    const duplicate = await call(port, 'POST', '/api/projects/portal-project/update', {
      'X-Service-Portal-Action': 'update'
    });
    assert.equal(duplicate.status, 409);
    assert.equal(json(duplicate).job.id, firstJob.id);
    assert.equal(state.createBodies.length, 1);
  });

  await t.test('successful exit captures demultiplexed logs, persists status, and removes the runner', async () => {
    const runner = state.runners.get(firstRunnerId);
    runner.running = false;
    runner.status = 'exited';
    runner.exitCode = 0;
    runner.logs = 'build complete\nportal healthy\n';
    const job = await waitForJob(port, firstJob.id, 'succeeded');
    assert.match(job.logs, /portal healthy/);
    assert.equal(job.exitCode, 0);
    assert.equal(state.runners.get(firstRunnerId).removed, true);
    assert.ok(fs.existsSync(path.join(dataDir, 'maintenance', firstJob.id + '.json')));
    const services = json(await call(port, 'GET', '/api/services')).services;
    assert.equal(services.find((service) => service.name === 'portal').update.job.state, 'succeeded');
  });

  await t.test('a later failed run reports its exit code and logs without poisoning the project lock', async () => {
    const response = await call(port, 'POST', '/api/projects/portal-project/update', {
      'X-Service-Portal-Action': 'update'
    });
    assert.equal(response.status, 202);
    const secondJob = json(response).job;
    const secondRunnerId = [...state.runners.keys()][1];
    const runner = state.runners.get(secondRunnerId);
    runner.running = false;
    runner.status = 'exited';
    runner.exitCode = 7;
    runner.logs = 'preflight failed: dirty checkout\n';
    const job = await waitForJob(port, secondJob.id, 'failed');
    assert.equal(job.exitCode, 7);
    assert.match(job.error, /preflight failed/);
    assert.match(job.logs, /dirty checkout/);
    assert.equal(state.runners.get(secondRunnerId).removed, true);
  });

  await t.test('status routes reject unknown IDs and mutating methods', async () => {
    assert.equal((await call(port, 'GET', '/api/maintenance/' + '0'.repeat(36))).status, 404);
    assert.equal((await call(port, 'POST', '/api/maintenance/' + firstJob.id)).status, 405);
  });
});
