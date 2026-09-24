#!/usr/bin/env node
'use strict';
/*
 * Zero-dependency test for the favicon contract in server.js:
 *
 *   node test/favicon.test.js
 *
 * The header logo <img> and the browser-tab <link rel="icon"> must resolve to
 * the same favicon source: the file named by PORTAL_FAVICON_FILE when set and
 * readable, otherwise the built-in star.svg. Spawns the real server.js twice
 * (once with a configured non-star icon, once with the env unset) and checks:
 *
 *   (a) configured icon: the served HTML's logo <img> src resolves over HTTP
 *       to the configured asset (200, correct Content-Type, byte-identical
 *       body) — header and tab share the configured icon;
 *   (b) env unset: header and tab both resolve to the built-in star, no crash;
 *   (c) the /favicon.ico response (status, headers, bytes) is unchanged.
 */
const assert = require('assert');
const child = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- minimal PNG encoder (one RGBA pixel) -------------------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function makePng(r, g, b, a) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8;              // bit depth
  ihdr[9] = 6;              // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b, a]))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---- fake Docker Engine over a unix socket ------------------------- */
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
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function waitForServer(port) {
  const deadline = Date.now() + 5000;
  return (async () => {
    while (Date.now() < deadline) {
      try { if ((await call(port, 'GET', '/healthz')).status === 200) return; } catch (e) { /* not up yet */ }
      await sleep(100);
    }
    throw new Error('server did not become healthy in time');
  })();
}

/*
 * Spawns the real server.js against the fake Docker engine. `extraEnv` is
 * merged over the test process env after PORTAL_FAVICON_FILE/PORTAL_TITLE
 * are cleared, so host-environment leaks cannot change what is tested.
 */
function startServer(extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-favicon-test-'));
  const sockPath = path.join(dataDir, 'docker.sock');
  let proc = null;
  let docker = null;
  let out = '';
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (proc) proc.kill();
    if (docker) docker.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  };
  return (async () => {
    docker = await fakeDocker(sockPath);
    const port = await freePort();
    const base = { ...process.env };
    delete base.PORTAL_FAVICON_FILE;
    delete base.PORTAL_TITLE;
    proc = child.spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...base,
        ...extraEnv,
        PORT: String(port),
        DATA_DIR: dataDir,
        DOCKER_SOCKET: sockPath,
        SELF_NAME: 'test'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    await waitForServer(port);
    return { port, stop, log: () => out };
  })();
}

function logoSrc(html) {
  const m = html.match(/<img class="logo" src="([^"]+)" alt="" aria-hidden="true">/);
  assert.ok(m, 'header logo <img> is present with its class/alt/aria attributes');
  return m[1];
}
function tabHref(html) {
  const m = html.match(/<link rel="icon" type="([^"]+)" href="([^"]+)">/);
  assert.ok(m, 'browser-tab <link rel="icon"> is present');
  return { mime: m[1], href: m[2] };
}
function sha12(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

async function main() {
  // (a) + (c): configured non-star icon — header logo and browser tab share it.
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-favicon-test-'));
    const iconBytes = makePng(0x11, 0x22, 0x33, 0xff);
    const iconPath = path.join(dataDir, 'configured.png');
    fs.writeFileSync(iconPath, iconBytes);
    const handle = await startServer({ PORTAL_FAVICON_FILE: iconPath });
    try {
      const home = await call(handle.port, 'GET', '/');
      assert.strictEqual(home.status, 200, 'home page is available');
      const html = home.body.toString('utf8');

      const expectedVersion = sha12(iconBytes);
      const logo = logoSrc(html);
      const tab = tabHref(html);
      assert.strictEqual(
        logo, '/favicon.ico?v=' + expectedVersion,
        'header logo points at /favicon.ico with the content version');
      assert.strictEqual(
        tab.href, '/favicon.ico?v=' + expectedVersion,
        'browser tab points at /favicon.ico with the content version');
      assert.strictEqual(tab.mime, 'image/png', 'tab icon type is the detected PNG type');
      assert.strictEqual(logo, tab.href, 'header logo and browser tab share one favicon source');

      // The logo src resolves over HTTP to the configured asset, byte-identical.
      const logoRes = await call(handle.port, 'GET', decodeURIComponent(logo));
      assert.strictEqual(logoRes.status, 200, 'logo src resolves (200)');
      assert.strictEqual(logoRes.headers['content-type'], 'image/png', 'logo is served with the detected Content-Type');
      assert.strictEqual(Buffer.compare(logoRes.body, iconBytes), 0, 'logo body is byte-identical to the configured file');

      // (c) /favicon.ico contract unchanged: status, headers, bytes.
      const fav = await call(handle.port, 'GET', '/favicon.ico');
      assert.strictEqual(fav.status, 200, '/favicon.ico is 200');
      assert.strictEqual(fav.headers['content-type'], 'image/png', '/favicon.ico Content-Type is detected');
      assert.strictEqual(fav.headers['content-length'], String(iconBytes.length), '/favicon.ico Content-Length matches the body');
      assert.strictEqual(fav.headers['cache-control'], 'public, max-age=0, must-revalidate', '/favicon.ico Cache-Control is unchanged');
      assert.strictEqual(Buffer.compare(fav.body, iconBytes), 0, '/favicon.ico body is the configured file');

      // The /star.svg compatibility route still serves the built-in star.
      const starRoute = await call(handle.port, 'GET', '/star.svg');
      assert.strictEqual(starRoute.status, 200, '/star.svg is still available');
      assert.strictEqual(starRoute.headers['content-type'], 'image/svg+xml', '/star.svg is the built-in star');
      assert.strictEqual(starRoute.headers['cache-control'], 'public, max-age=86400', '/star.svg cache behavior is unchanged');

      console.log('  ok 1. configured icon drives both the header logo and the browser tab');
    } finally {
      handle.stop();
    }
  }

  // (b): env unset — header and tab both fall back to the built-in star, no crash.
  {
    const handle = await startServer({});
    const starBytes = fs.readFileSync(path.join(ROOT, 'star.svg'));
    const expectedVersion = sha12(starBytes);
    try {
      const home = await call(handle.port, 'GET', '/');
      assert.strictEqual(home.status, 200, 'home page is available with the env unset');
      const html = home.body.toString('utf8');
      const logo = logoSrc(html);
      const tab = tabHref(html);
      assert.strictEqual(logo, '/favicon.ico?v=' + expectedVersion, 'logo falls back to the built-in star');
      assert.strictEqual(tab.href, '/favicon.ico?v=' + expectedVersion, 'tab falls back to the built-in star');
      assert.strictEqual(tab.mime, 'image/svg+xml', 'tab icon type is the built-in star type');

      const logoRes = await call(handle.port, 'GET', decodeURIComponent(logo));
      assert.strictEqual(logoRes.status, 200, 'logo src resolves (200)');
      assert.strictEqual(logoRes.headers['content-type'], 'image/svg+xml', 'logo is the built-in star');
      assert.strictEqual(Buffer.compare(logoRes.body, starBytes), 0, 'logo body is byte-identical to the built-in star');

      const fav = await call(handle.port, 'GET', '/favicon.ico');
      assert.strictEqual(fav.status, 200, '/favicon.ico is 200');
      assert.strictEqual(fav.headers['content-type'], 'image/svg+xml', '/favicon.ico is the built-in star');
      assert.strictEqual(fav.headers['content-length'], String(starBytes.length), '/favicon.ico Content-Length matches the body');
      assert.strictEqual(fav.headers['cache-control'], 'public, max-age=0, must-revalidate', '/favicon.ico Cache-Control is unchanged');
      assert.strictEqual(Buffer.compare(fav.body, starBytes), 0, '/favicon.ico body is the built-in star');

      console.log('  ok 2. unset env: header logo and browser tab both use the built-in star');
    } finally {
      handle.stop();
    }
  }

  console.log('all favicon tests passed');
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
