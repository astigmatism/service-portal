#!/usr/bin/env node
'use strict';
/*
 * Zero-dependency test for the activity feed in server.js:
 *
 *   node test/activity.test.js
 *
 * Exercises the shipping server against a fake Docker Engine: container
 * start/stop actions must land in the durable feed (GET /api/activity),
 * persisted maintenance jobs must surface as update events with their logs
 * still fetchable per job, and the feed must be newest-first and GET-only.
 */
const assert = require('assert');
const child = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeDocker(socketPath) {
  return new Promise((resolve, reject) => {
    try { fs.unlinkSync(socketPath); } catch (e) {}
    const srv = net.createServer((conn) => {
      conn.on('error', () => {});
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString('binary');
        if (!buf.includes('\r\n\r\n')) return;
        const head = buf.slice(0, buf.indexOf('\r\n\r\n'));
        const [method, p] = head.split('\r\n')[0].split(' ');
        const respond = (status, body) => {
          const b = Buffer.from(body);
          conn.end('HTTP/1.1 ' + status + '\r\nContent-Type: application/json\r\n' +
            'Content-Length: ' + b.length + '\r\nConnection: close\r\n\r\n' + body);
        };
        if (method === 'GET' && p === '/containers/json?all=1') return respond('200 OK', '[]');
        const m = p.match(/^\/containers\/([0-9a-f]{6,64})\/(start|stop)$/);
        if (method === 'POST' && m) {
          if (m[1].startsWith('bad'))
            return respond('404 Not Found', JSON.stringify({ message: 'no such container: ' + m[1] }));
          return respond('204 No Content', '');
        }
        respond('404 Not Found', JSON.stringify({ message: 'not found' }));
      });
    });
    srv.on('error', reject);
    srv.listen(socketPath, () => resolve(srv));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function call(port, method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}
const json = (r) => JSON.parse(r.body);

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-activity-test-'));
  const sockPath = path.join(dataDir, 'docker.sock');

  // Seed one persisted maintenance job before the server boots, so the feed
  // must pick it up from disk like any other durable record.
  const jobId = '6f1e2d3c-4b5a-4988-8776-554433221100';
  fs.mkdirSync(path.join(dataDir, 'maintenance'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'maintenance', jobId + '.json'), JSON.stringify({
    id: jobId,
    project: 'demo-project',
    state: 'failed',
    createdAt: '2020-01-02T10:00:00.000Z',
    startedAt: '2020-01-02T10:00:01.000Z',
    finishedAt: '2020-01-02T10:02:00.000Z',
    exitCode: 1,
    error: 'build exited with code 1',
    logs: 'step one\nbuild exited with code 1',
    containerId: null,
    containerName: 'service-portal-update-demo',
  }));

  const port = await freePort();
  const docker = await fakeDocker(sockPath);
  const proc = child.spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DOCKER_SOCKET: sockPath,
      SELF_NAME: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });

  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { if ((await call(port, 'GET', '/healthz')).status === 200) break; } catch (e) { /* not up yet */ }
      await sleep(100);
    }
    assert.strictEqual((await call(port, 'GET', '/healthz')).status, 200, 'server is up');

    // A container action is recorded durably, even though the fake engine
    // refuses the name lookup — the action must still succeed.
    const containerId = 'ab12cd34ef56';
    const stop = await call(port, 'POST', '/api/services/' + containerId + '/stop');
    assert.strictEqual(stop.status, 200, 'stop → 200, got ' + stop.status + ' ' + stop.body);

    const feed = json(await call(port, 'GET', '/api/activity'));
    assert.ok(Array.isArray(feed.events), 'feed is an event array');
    const containerEvents = feed.events.filter((ev) => ev.kind === 'container');
    assert.strictEqual(containerEvents.length, 1, 'the stop was recorded once');
    assert.strictEqual(containerEvents[0].action, 'stop');
    assert.strictEqual(containerEvents[0].state, 'ok');
    assert.match(containerEvents[0].message, /Stopped /, 'human-readable message');

    // The persisted maintenance job surfaces as an update event, newest-first
    // ordering puts the fresh stop above the September job.
    const updateEvents = feed.events.filter((ev) => ev.kind === 'update');
    assert.strictEqual(updateEvents.length, 1, 'the seeded job is in the feed');
    assert.strictEqual(updateEvents[0].id, jobId, 'event carries the job id for log lookup');
    assert.strictEqual(updateEvents[0].state, 'failed');
    assert.strictEqual(updateEvents[0].hasLogs, true, 'update events advertise their logs');
    assert.strictEqual(feed.events[0].kind, 'container', 'newest event first');

    // Full logs stay fetchable per job (the feed itself stays small).
    const job = json(await call(port, 'GET', '/api/maintenance/' + jobId));
    assert.match(job.job.logs, /build exited with code 1/, 'full logs served per job');

    // A failed action is recorded too — the feed keeps the bad news as well.
    await call(port, 'POST', '/api/services/bad123456789/stop');
    const feed2 = json(await call(port, 'GET', '/api/activity'));
    const failed = feed2.events.filter((ev) => ev.kind === 'container' && ev.state === 'error');
    assert.strictEqual(failed.length, 1, 'the failed stop was recorded');
    assert.match(failed[0].message, /Could not stop/, 'failure message reads naturally');

    // Method guard.
    assert.strictEqual((await call(port, 'POST', '/api/activity')).status, 405, 'POST is not allowed');

    console.log('  ok 1. activity feed records container actions and persisted update jobs, newest first');
  } finally {
    proc.kill();
    docker.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(out.trim() ? 'server log: ' + out.trim() : 'no server log output');
  console.log('all activity-feed tests passed');
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
