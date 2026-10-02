'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { once } = require('events');
const sharp = require('sharp');
const { createWallpaperImages, attachmentDisposition } = require('../wallpaper-images');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-previews-'));
  fs.mkdirSync(path.join(root, 'wallpapers'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const originalPath = (root, id) => path.join(root, 'wallpapers', id);
const cachePath = (root, id) => path.join(root, 'wallpaper-thumbnails', id);
const png = (width, height, background = '#ed448080') =>
  sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();

test('previews resize, orient, preserve alpha, use the first animation frame and survive restart', async (t) => {
  const root = fixture(t);
  const source = await png(1600, 800);
  fs.writeFileSync(originalPath(root, 'alpha'), source);
  const images = createWallpaperImages(root);
  const target = await images.thumbnail('alpha');
  let info = await sharp(target).metadata();
  assert.equal(info.format, 'webp');
  assert.equal(info.width, 640);
  assert.equal(info.height, 320);
  assert.equal(info.hasAlpha, true);
  const pixels = await sharp(target).raw().toBuffer();
  assert.ok(pixels[3] >= 126 && pixels[3] <= 130, 'alpha is retained');
  assert.deepEqual(fs.readFileSync(originalPath(root, 'alpha')), source);
  const timestamp = fs.statSync(target).mtimeMs;
  const restarted = createWallpaperImages(root, { generate: () => { throw new Error('cache should be reused'); } });
  assert.equal(await restarted.thumbnail('alpha'), target);
  assert.equal(fs.statSync(target).mtimeMs, timestamp);

  const oriented = await sharp(await png(100, 50)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  fs.writeFileSync(originalPath(root, 'oriented'), oriented);
  info = await sharp(await images.thumbnail('oriented')).metadata();
  assert.equal(info.width, 50);
  assert.equal(info.height, 100, 'orientation applied without enlargement');

  const frames = Buffer.alloc(8 * 16 * 3);
  for (let i = 0; i < 8 * 16; i++) frames[i * 3 + (i < 64 ? 0 : 2)] = 255;
  const gif = await sharp(frames, { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } })
    .gif({ delay: [100, 100], loop: 0 }).toBuffer();
  assert.equal((await sharp(gif, { animated: true }).metadata()).pages, 2);
  fs.writeFileSync(originalPath(root, 'animated'), gif);
  const animatedPreview = await images.thumbnail('animated');
  info = await sharp(animatedPreview).metadata();
  assert.equal(info.height, 8);
  assert.ok(!info.pages || info.pages === 1);
  const first = await sharp(animatedPreview).raw().toBuffer();
  assert.ok(first[0] > 230 && first[2] < 20, 'preview is the first, red frame');
});

test('preview jobs deduplicate and run one at a time; failures do not block the queue', async (t) => {
  const root = fixture(t);
  for (const id of ['one', 'two', 'bad']) fs.writeFileSync(originalPath(root, id), id);
  let active = 0, maximum = 0, calls = 0;
  const images = createWallpaperImages(root, { generate: async (source) => {
    calls++;
    maximum = Math.max(maximum, ++active);
    await pause(20);
    active--;
    if (source.endsWith('bad')) throw new Error('invalid image');
    return Buffer.from('preview');
  } });
  const results = await Promise.all([images.thumbnail('one'), images.thumbnail('one'), images.thumbnail('two')]);
  assert.equal(results[0], results[1]);
  assert.equal(calls, 2);
  assert.equal(maximum, 1);
  await assert.rejects(images.thumbnail('bad'), { status: 422 });
  images.invalidate('two');
  await images.thumbnail('two');
  assert.equal(calls, 4, 'queue continues after a failed decode');
});

test('delete and replacement invalidate running and queued preview jobs', async (t) => {
  for (const action of ['delete', 'replace']) {
    await t.test(action, async (t) => {
      const root = fixture(t);
      const started = deferred(), release = deferred();
      fs.writeFileSync(originalPath(root, 'image'), 'old');
      let calls = 0;
      const images = createWallpaperImages(root, { generate: async (source) => {
        const bytes = fs.readFileSync(source);
        if (++calls === 1) { started.resolve(); await release.promise; }
        return bytes;
      } });
      const pending = images.thumbnail('image');
      const rejected = assert.rejects(pending, { status: 409 });
      await started.promise;
      if (action === 'delete') images.remove('image');
      else {
        images.invalidate('image');
        fs.writeFileSync(originalPath(root, 'image'), 'replacement');
      }
      release.resolve();
      await rejected;
      assert.equal(fs.existsSync(cachePath(root, 'image')), false, 'stale job cannot recreate cache');
      if (action === 'replace') {
        const target = await images.thumbnail('image');
        assert.equal(fs.readFileSync(target, 'utf8'), 'replacement');
      }
    });
  }
  const root = fixture(t);
  for (const id of ['blocker', 'queued']) fs.writeFileSync(originalPath(root, id), id);
  const started = deferred(), release = deferred();
  const seen = [];
  const images = createWallpaperImages(root, { generate: async (source) => {
    seen.push(path.basename(source));
    started.resolve();
    await release.promise;
    return Buffer.from('preview');
  } });
  const blocker = images.thumbnail('blocker');
  await started.promise;
  const queued = images.thumbnail('queued');
  const rejected = assert.rejects(queued, (err) => err.status === 409 || err.code === 'ENOENT');
  await pause(10);
  images.remove('queued');
  release.resolve();
  await blocker;
  await rejected;
  assert.deepEqual(seen, ['blocker'], 'deleted queued image is never decoded');
});

async function startServer(root) {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: root, DOCKER_SOCKET: path.join(root, 'no-docker.sock') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const base = 'http://127.0.0.1:' + port;
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  };
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return { base, stop }; } catch {}
    if (child.exitCode !== null) break;
    await pause(50);
  }
  await stop();
  throw new Error('server did not start: ' + output);
}

test('HTTP originals and previews revalidate, stream unchanged bytes, invalidate and clean up', async (t) => {
  const root = fixture(t);
  let server = await startServer(root);
  t.after(() => server.stop());
  const request = (url, options) => fetch(server.base + url, options);
  const source = await png(1400, 700);
  const upload = async (body = source, url = '/api/appearance/wallpapers') => {
    const res = await request(url, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body });
    assert.equal(res.status, 200);
    return (await res.json()).wallpaper.id;
  };
  const imageUrl = (id) => '/api/appearance/wallpapers/' + id;
  const id = await upload();
  const thumbUrl = imageUrl(id) + '/thumbnail';
  let res = await request(imageUrl(id));
  const originalEtag = res.headers.get('etag');
  assert.equal(res.headers.get('cache-control'), 'private, no-cache');
  assert.equal(Number(res.headers.get('content-length')), source.length);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), source);
  res = await request(thumbUrl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  const thumbEtag = res.headers.get('etag');
  const thumb = Buffer.from(await res.arrayBuffer());
  assert.equal((await sharp(thumb).metadata()).width, 640);
  assert.ok(thumb.length < source.length);
  for (const [url, etag] of [[imageUrl(id), originalEtag], [thumbUrl, thumbEtag], ['/api/appearance/background', originalEtag]]) {
    res = await request(url, { headers: { 'If-None-Match': 'W/' + etag } });
    assert.equal(res.status, 304);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
  }
  await server.stop();
  server = await startServer(root);
  res = await request(thumbUrl, { headers: { 'If-None-Match': thumbEtag } });
  assert.equal(res.status, 304, 'disk preview survives a process restart');

  const replacement = await png(60, 90, '#00ff00');
  assert.equal(await upload(replacement, '/api/appearance/background'), id);
  for (const [url, etag] of [[imageUrl(id), originalEtag], [thumbUrl, thumbEtag]]) {
    res = await request(url, { headers: { 'If-None-Match': etag } });
    assert.equal(res.status, 200, 'same-ID replacement invalidates the validator');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (url === thumbUrl) assert.equal((await sharp(bytes).metadata()).width, 60);
    else assert.deepEqual(bytes, replacement);
  }
  assert.equal((await request(thumbUrl, { method: 'DELETE' })).status, 405);
  assert.equal((await request(imageUrl(id), { method: 'DELETE' })).status, 200);
  assert.equal(fs.existsSync(cachePath(root, id)), false);
  assert.equal((await request(thumbUrl)).status, 404);
  assert.equal((await request(imageUrl(id), { headers: { 'If-None-Match': originalEtag } })).status, 404);

  const bad = await upload(Buffer.from('invalid image'));
  assert.equal((await request(imageUrl(bad) + '/thumbnail')).status, 422);
  assert.equal((await request(imageUrl(bad))).status, 200, 'preview failure leaves the original available');
  await request(imageUrl(bad), { method: 'DELETE' });
  for (const route of ['slot', '/api/appearance/slots', '/api/appearance/wallpapers', '/api/appearance/background']) {
    const currentId = await upload();
    assert.equal((await request(imageUrl(currentId) + '/thumbnail')).status, 200);
    const state = await (await request('/api/appearance')).json();
    const url = route === 'slot' ? '/api/appearance/slots/' + state.settings.activeSlotId : route;
    assert.equal((await request(url, { method: 'DELETE' })).status, 200);
    assert.equal(fs.existsSync(cachePath(root, currentId)), false, route + ' cleans up previews');
  }
});

test('attachmentDisposition keeps the header ASCII and the exact name in filename*', () => {
  assert.equal(attachmentDisposition('Slot 1 07.png'),
    'attachment; filename="Slot 1 07.png"; filename*=UTF-8\'\'Slot%201%2007.png');
  // Quotes/backslashes cannot break out of the quoted fallback; RFC 5987
  // reserves '()* so they are percent-encoded too.
  assert.equal(attachmentDisposition('a"b\\c (it\'s)*.jpg'),
    'attachment; filename="a_b_c (it\'s)*.jpg"; filename*=UTF-8\'\'a%22b%5Cc%20%28it%27s%29%2A.jpg');
  assert.equal(attachmentDisposition('Ünï 01.webp'),
    'attachment; filename="_n_ 01.webp"; filename*=UTF-8\'\'%C3%9Cn%C3%AF%2001.webp');
});

test('?download=1 serves the stored original as an attachment named after its slot', async (t) => {
  const root = fixture(t);
  const server = await startServer(root);
  t.after(() => server.stop());
  const request = (url, options) => fetch(server.base + url, options);
  const first = await png(320, 200, '#336699');
  const second = await png(200, 320, '#996633');
  const upload = async (body) => {
    const res = await request('/api/appearance/wallpapers', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body });
    assert.equal(res.status, 200);
    return (await res.json()).wallpaper.id;
  };
  await upload(first);
  const id = await upload(second);
  const url = '/api/appearance/wallpapers/' + id;

  let res = await request(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), null, 'plain GET (the background) stays inline');
  await res.arrayBuffer();

  res = await request(url + '?download=1');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('content-disposition'),
    'attachment; filename="Slot 1 02.png"; filename*=UTF-8\'\'Slot%201%2002.png', 'unnamed slot falls back to "Slot N"');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), second, 'download is the stored original, not the preview');
  const etag = res.headers.get('etag');
  res = await request(url + '?download=1', { headers: { 'If-None-Match': etag } });
  assert.equal(res.status, 304, 'downloads revalidate like the original');

  const state = await (await request('/api/appearance')).json();
  const slotId = state.settings.activeSlotId;
  res = await request('/api/appearance/slots/' + slotId, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: ' Ünïcode "Sky"/Night. ' })
  });
  assert.equal(res.status, 200);
  res = await request(url + '?download=1');
  assert.equal(res.headers.get('content-disposition'),
    'attachment; filename="_n_code -Sky--Night 02.png"; filename*=UTF-8\'\'%C3%9Cn%C3%AFcode%20-Sky--Night%2002.png',
    'the slot name is made filesystem-safe and follows renames');
  await res.arrayBuffer();

  res = await request('/api/appearance/wallpapers/00000000-0000-4000-8000-000000000000?download=1');
  assert.equal(res.status, 404);
  await res.arrayBuffer();
});
