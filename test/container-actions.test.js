#!/usr/bin/env node
'use strict';
/*
 * Zero-dependency test for the container start/stop route in server.js:
 *
 *   node test/container-actions.test.js
 *
 * Spawns the real server.js against a fake Docker Engine (a unix-socket
 * HTTP server that records the calls it receives), so the shipping route —
 * path matching, method guard, Docker call forwarding, and error mapping —
 * is what gets exercised (no copy drift). Not shipped in the container
 * image.
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

/* ---- fake Docker Engine over a unix socket ------------------------- */
function fakeDocker(socketPath, calls) {
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
        calls.push({ method, path: p });
        if (method === 'GET' && p === '/containers/json') return respond('200 OK', '[]');
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-actions-test-'));
  const sockPath = path.join(dataDir, 'docker.sock');
  const calls = [];
  const docker = await fakeDocker(sockPath, calls);
  const port = await freePort();
  const proc = child.spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, DOCKER_SOCKET: sockPath, SELF_NAME: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });

  const runningId = 'ab12cd34ef56';
  const stoppedId = 'cd34ef56ab12';

  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { if ((await call(port, 'GET', '/healthz')).status === 200) break; } catch (e) { /* not up yet */ }
      await sleep(100);
    }
    assert.strictEqual((await call(port, 'GET', '/healthz')).status, 200, 'server is up');

    // The list route still works over the fake socket.
    const list = json(await call(port, 'GET', '/api/services'));
    assert.strictEqual(list.services.length, 0, 'empty list from the fake engine');

    // Stop: forwarded to Docker, success surfaced as 200 {ok, action}.
    const stop = await call(port, 'POST', '/api/services/' + runningId + '/stop');
    assert.strictEqual(stop.status, 200, 'stop → 200, got ' + stop.status + ' ' + stop.body);
    assert.deepStrictEqual(json(stop), { ok: true, action: 'stop' });
    assert.deepStrictEqual(
      calls.filter((c) => c.method === 'POST'),
      [{ method: 'POST', path: '/containers/' + runningId + '/stop' }],
      'Docker received exactly the stop call');

    // Start: same path for the other direction.
    const start = await call(port, 'POST', '/api/services/' + stoppedId + '/start');
    assert.strictEqual(start.status, 200, 'start → 200, got ' + start.status);
    assert.deepStrictEqual(json(start), { ok: true, action: 'start' });
    assert.ok(calls.some((c) => c.path === '/containers/' + stoppedId + '/start'), 'start reached Docker');

    // Docker refusal (no such container) → 502 carrying Docker's message.
    const bad = await call(port, 'POST', '/api/services/bad123456789/stop');
    assert.strictEqual(bad.status, 502, 'docker 404 → 502, got ' + bad.status + ' ' + bad.body);
    assert.match(json(bad).error, /no such container/, 'error message carries the Docker reason');

    // Method guard + path hygiene.
    assert.strictEqual((await call(port, 'GET', '/api/services/' + runningId + '/stop')).status, 405, 'GET is not allowed');
    assert.strictEqual((await call(port, 'POST', '/api/services/' + runningId + '/restart')).status, 404, 'unknown action is not a route');
    assert.strictEqual((await call(port, 'POST', '/api/services/notahexid/stop')).status, 404, 'non-hex id is not a route');

    console.log('  ok 1. start/stop route forwards to the docker socket and maps outcomes');
  } finally {
    proc.kill();
    docker.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(out.trim() ? 'server log: ' + out.trim() : 'no server log output');
  console.log('all container-action tests passed');
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
