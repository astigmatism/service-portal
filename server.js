#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '80', 10);
const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const SELF_NAME = process.env.SELF_NAME || '';
const HTML_FILE = path.join(__dirname, 'index.html');

// Friendly labels/descriptions per container name.
// Override without rebuilding via the SERVICE_LABELS env var (JSON string),
// otherwise read labels.json next to this file.
let labels = {};
try {
  const raw = process.env.SERVICE_LABELS ||
    (fs.existsSync(path.join(__dirname, 'labels.json'))
      ? fs.readFileSync(path.join(__dirname, 'labels.json'), 'utf8')
      : null);
  labels = raw ? JSON.parse(raw) : {};
} catch (err) {
  console.error('ignoring bad labels: ' + err.message);
  labels = {};
}

// ---- Appearance persistence (wallpaper + styling settings) ----------------
// Shared across all clients on the network: settings live in
// <DATA_DIR>/appearance.json, the wallpaper in <DATA_DIR>/background.bin with
// its MIME type in <DATA_DIR>/background.json. DATA_DIR defaults to ./data
// next to this file; the container deployment bind-mounts a persistent host
// volume at /data so the wallpaper survives container recreation.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'appearance.json');
const IMAGE_FILE = path.join(DATA_DIR, 'background.bin');
const IMAGE_META_FILE = path.join(DATA_DIR, 'background.json');
const MAX_IMAGE_BYTES = 209715200; // 200 MB, matches the client input cap
const SERVER_BG_TOKEN = 'server';

const APPEARANCE_DEFAULTS = {
  backgroundImage: '',
  backgroundPosition: 'center',
  imageDark: false,
  backgroundOpacity: 1,
  backgroundBlur: 0,
  scrim: 0,
  surfaceAlpha: 1,
  glassBlur: 0,
};
// cover-crop anchors for the wallpaper (see --sp-bg-position in index.html)
const APPEARANCE_POSITIONS = ['center', 'top', 'bottom', 'left', 'right'];
const APPEARANCE_BOUNDS = {
  backgroundOpacity: { min: 0, max: 1 },
  backgroundBlur: { min: 0, max: 30 },
  scrim: { min: 0, max: 1 },
  surfaceAlpha: { min: 0, max: 1 },
  glassBlur: { min: 0, max: 20 },
};

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  console.error('could not create data dir ' + DATA_DIR + ': ' + err.message);
}

function sanitizeAppearance(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...APPEARANCE_DEFAULTS };
  const out = { ...APPEARANCE_DEFAULTS };
  if (typeof raw.imageDark === 'boolean') out.imageDark = raw.imageDark;
  else if (raw.imageDark === 0) out.imageDark = false;
  else if (raw.imageDark === 1) out.imageDark = true;
  if (APPEARANCE_POSITIONS.includes(raw.backgroundPosition)) out.backgroundPosition = raw.backgroundPosition;
  for (const [field, b] of Object.entries(APPEARANCE_BOUNDS)) {
    const v = raw[field];
    if (typeof v === 'number' && Number.isFinite(v)) out[field] = Math.min(b.max, Math.max(b.min, v));
  }
  // The server stores exactly one wallpaper, so the token collapses to a flag:
  // a non-empty token is normalized to SERVER_BG_TOKEN only when an image is
  // on disk, otherwise to ''.
  const hasImage = fs.existsSync(IMAGE_FILE);
  out.backgroundImage =
    typeof raw.backgroundImage === 'string' && raw.backgroundImage !== '' && hasImage
      ? SERVER_BG_TOKEN : '';
  return out;
}

function readAppearanceSettings() {
  try {
    return sanitizeAppearance(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch (err) {
    return { ...APPEARANCE_DEFAULTS, backgroundImage: fs.existsSync(IMAGE_FILE) ? SERVER_BG_TOKEN : '' };
  }
}

function saveAppearanceSettings(settings) {
  const tmp = SETTINGS_FILE + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (err) {
    fs.unlink(tmp, () => {});
    throw err;
  }
}

function atomicWriteFileSync(file, data) {
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { fail(new Error('payload too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', fail);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function dockerApi(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: SOCKET, path: pathname }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('docker API timed out')));
  });
}

function toService(c) {
  const ports = [];
  const seen = new Set();
  const push = (p) => {
    const key = p.containerPort + '/' + p.protocol + '/' + p.hostPort;
    if (seen.has(key)) return; // dedupe IPv4/IPv6 dual-stack entries
    seen.add(key);
    ports.push(p);
  };
  if (Array.isArray(c.Ports) && c.Ports.length) {
    // /containers/json summary field (present in current Docker versions)
    for (const p of c.Ports) {
      push({
        containerPort: Number(p.PrivatePort),
        protocol: p.Type || 'tcp',
        hostIp: p.IP || '',
        hostPort: p.PublicPort ? Number(p.PublicPort) : null,
      });
    }
  } else {
    // Fallback: full binding map from inspect-level data
    const portMap = (c.NetworkSettings && c.NetworkSettings.Ports) || {};
    for (const [key, bindings] of Object.entries(portMap)) {
      const [cp, proto] = key.split('/');
      for (const b of bindings || []) {
        push({
          containerPort: Number(cp),
          protocol: proto || 'tcp',
          hostIp: b.HostIp || '',
          hostPort: b.HostPort ? Number(b.HostPort) : null,
        });
      }
    }
  }
  ports.sort((a, b) => a.containerPort - b.containerPort);
  const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : c.Id.slice(0, 12);
  const meta = labels[name] || {};
  return {
    name,
    label: meta.label || null,
    description: meta.description || null,
    id: c.Id.slice(0, 12),
    image: c.Image,
    state: c.State,
    health: c.Health ? c.Health.Status : null,
    statusLine: c.Status,
    ports,
    self: name === SELF_NAME,
  };
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://internal').pathname; } catch { pathname = req.url; }

  if (pathname === '/api/services') {
    dockerApi('/containers/json')
      .then((list) => {
        const services = list.map(toService).sort((a, b) => a.name.localeCompare(b.name));
        const body = JSON.stringify({ generatedAt: new Date().toISOString(), services });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(body);
      })
      .catch((err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'docker api error: ' + err.message }));
      });
    return;
  }

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (pathname === '/api/appearance') {
    if (req.method === 'GET') {
      sendJson(res, 200, { settings: readAppearanceSettings() });
      return;
    }
    if (req.method === 'PUT') {
      readBody(req, 65536)
        .then((buf) => {
          let raw;
          try { raw = JSON.parse(buf.toString('utf8')); } catch (err) { throw new Error('invalid JSON body'); }
          const settings = sanitizeAppearance(raw);
          saveAppearanceSettings(settings);
          sendJson(res, 200, { ok: true, settings });
        })
        .catch((err) => sendJson(res, 400, { error: err.message }));
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  if (pathname === '/api/appearance/background') {
    if (req.method === 'GET') {
      fs.readFile(IMAGE_FILE, (err, buf) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no background'); return; }
        let mime = 'application/octet-stream';
        try { mime = JSON.parse(fs.readFileSync(IMAGE_META_FILE, 'utf8')).type || mime; } catch (e) {}
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
        res.end(buf);
      });
      return;
    }
    if (req.method === 'POST') {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!type.startsWith('image/')) {
        sendJson(res, 415, { error: 'content-type must be an image type' });
        return;
      }
      readBody(req, MAX_IMAGE_BYTES)
        .then((buf) => {
          if (buf.length === 0) throw new Error('empty body');
          atomicWriteFileSync(IMAGE_META_FILE, JSON.stringify({ type }, null, 2) + '\n');
          atomicWriteFileSync(IMAGE_FILE, buf);
          sendJson(res, 200, { ok: true, bytes: buf.length });
        })
        .catch((err) =>
          sendJson(res, err.message === 'payload too large' ? 413 : 400, { error: err.message }));
      return;
    }
    if (req.method === 'DELETE') {
      fs.rm(IMAGE_FILE, () => {});
      fs.rm(IMAGE_META_FILE, () => {});
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    fs.readFile(HTML_FILE, (err, buf) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('index.html missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  const staticFiles = {
    '/favicon.ico': ['star.svg', 'image/svg+xml'],
    '/star.svg': ['star.svg', 'image/svg+xml'],
  };
  if (staticFiles[pathname]) {
    const [file, mime] = staticFiles[pathname];
    fs.readFile(path.join(__dirname, file), (err, buf) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('image missing'); return; }
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => console.log('service-portal listening on :' + PORT));
