'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

// Disk is the durable preview cache; keep decoding memory and CPU bounded.
sharp.cache({ memory: 16, files: 0, items: 32 });
sharp.concurrency(1);
const RECIPE = 'webp-640-inside-q80-oriented-first-frame-v1';
const fingerprint = (stat) => crypto.createHash('sha256')
  .update([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')).digest('hex');
const failure = (message, status) => Object.assign(new Error(message), { status });

async function generatePreview(source) {
  return sharp(source, { pages: 1, autoOrient: true })
    .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 }).toBuffer();
}

function createWallpaperImages(dataDir, { generate = generatePreview } = {}) {
  const originals = path.join(dataDir, 'wallpapers');
  const previews = path.join(dataDir, 'wallpaper-thumbnails');
  const jobs = new Map();
  let queue = Promise.resolve();

  function invalidate(id) {
    for (const job of jobs.values()) if (job.id === id) job.cancelled = true;
    fs.rmSync(path.join(previews, id), { recursive: true, force: true });
  }

  function remove(id) {
    invalidate(id);
    fs.rmSync(path.join(originals, id), { force: true });
  }

  async function thumbnail(id) {
    const source = path.join(originals, id);
    const version = fingerprint(await fs.promises.stat(source));
    const key = crypto.createHash('sha256').update(version + RECIPE).digest('hex');
    const directory = path.join(previews, id);
    const target = path.join(directory, key + '.webp');
    try {
      await fs.promises.access(target);
      return target;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const jobKey = id + ':' + key;
    const existing = jobs.get(jobKey);
    if (existing && !existing.cancelled) return existing.promise;
    const job = { id, cancelled: false };
    const checkSource = () => {
      if (job.cancelled) throw failure('wallpaper changed', 409);
      if (fingerprint(fs.statSync(source)) !== version) throw failure('wallpaper changed', 409);
    };
    job.promise = queue.then(async () => {
      checkSource();
      // A cache miss can finish its async lookup just after another request
      // publishes this version and leaves the in-flight map.
      if (fs.existsSync(target)) return target;
      let buffer;
      try { buffer = await generate(source); }
      catch (err) { throw failure('thumbnail unavailable', err.code === 'ENOENT' ? 404 : 422); }
      // No await between checking and publishing: delete/replace cannot publish
      // stale work back into the cache, even while native decoding is running.
      checkSource();
      fs.rmSync(directory, { recursive: true, force: true });
      fs.mkdirSync(directory, { recursive: true });
      const temporary = target + '.' + crypto.randomUUID() + '.tmp';
      try {
        fs.writeFileSync(temporary, buffer);
        fs.renameSync(temporary, target);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      return target;
    }).finally(() => {
      if (jobs.get(jobKey) === job) jobs.delete(jobKey);
    });
    jobs.set(jobKey, job);
    queue = job.promise.catch(() => {});
    return job.promise;
  }

  return { thumbnail, invalidate, remove };
}

async function serveImage(req, res, file, type) {
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
    // Stat the opened file, so a concurrent atomic replacement cannot pair
    // one image's validator with another image's bytes.
    const stat = await handle.stat();
    if (res.destroyed) { await handle.close(); handle = null; return; }
    const etag = '"' + fingerprint(stat) + '"';
    const headers = { 'Cache-Control': 'private, no-cache', ETag: etag };
    const matches = String(req.headers['if-none-match'] || '').split(',')
      .some((value) => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
    if (matches) {
      await handle.close();
      handle = null;
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': stat.size });
    const stream = handle.createReadStream();
    handle = null; // the stream owns and closes the descriptor
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, {
      'Content-Type': 'text/plain', 'Cache-Control': 'no-store'
    });
    res.end('image unavailable');
  }
}

module.exports = { createWallpaperImages, serveImage };
