#!/usr/bin/env node
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createWallpaperImages, serveImage, attachmentDisposition } = require('./wallpaper-images');

const PORT = parseInt(process.env.PORT || '80', 10);
const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const SELF_NAME = process.env.SELF_NAME || '';
const HTML_FILE = path.join(__dirname, 'index.html');
const DEFAULT_FAVICON_FILE = path.join(__dirname, 'star.svg');
const DEFAULT_PORTAL_TITLE = 'Service Portal';
const PORTAL_TITLE = String(process.env.PORTAL_TITLE || DEFAULT_PORTAL_TITLE)
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120) || DEFAULT_PORTAL_TITLE;

function faviconMimeType(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x00000100) return 'image/x-icon';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp' &&
      /^(avif|avis)$/.test(buf.subarray(8, 12).toString('ascii'))) return 'image/avif';
  const start = buf.subarray(0, 1024).toString('utf8')
    .replace(/^\ufeff?\s*(?:<\?xml[^>]*>\s*)?(?:<!doctype[^>]*>\s*)?/i, '');
  if (/^<svg(?:\s|>)/i.test(start)) return 'image/svg+xml';
  return '';
}

function loadFavicon() {
  const configured = process.env.PORTAL_FAVICON_FILE;
  const requestedFile = configured ? path.resolve(configured) : DEFAULT_FAVICON_FILE;
  try {
    const body = fs.readFileSync(requestedFile);
    const mime = faviconMimeType(body);
    if (!mime) throw new Error('unsupported image format');
    return { body, mime, version: crypto.createHash('sha256').update(body).digest('hex').slice(0, 12) };
  } catch (err) {
    if (requestedFile === DEFAULT_FAVICON_FILE) throw err;
    console.error('could not load favicon ' + requestedFile + ': ' + err.message + '; using the default');
    const body = fs.readFileSync(DEFAULT_FAVICON_FILE);
    return {
      body,
      mime: 'image/svg+xml',
      version: crypto.createHash('sha256').update(body).digest('hex').slice(0, 12)
    };
  }
}

const FAVICON = loadFavicon();

function escapeHtmlText(value) {
  return value.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
}

// Friendly labels/descriptions and visibility per container name.
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

// ---- Appearance persistence (wallpaper slots + styling settings) ----------
// Shared across all clients on the network: settings live in
// <DATA_DIR>/appearance.json — the wallpaper slots (an ordered collection of
// slots, each with an optional display name and an ordered list of wallpaper
// entries with MIME type, sampled darkness and sampled accent), the id of the
// active slot, and the global styling sliders — with one image file per
// wallpaper in <DATA_DIR>/wallpapers/<id> (id = random UUID). DATA_DIR defaults to ./data
// next to this file; the container deployment bind-mounts a persistent host
// volume at /data so the wallpapers survive container recreation.
//
// The server tracks the active *slot* only. Which wallpaper of the active
// slot a client displays is a per-browser random roll (re-rolled on every
// page refresh and every slot navigation), so there is no shared
// active-wallpaper pointer. The slot collection is owned by its own endpoints
// (below) — the settings PUT only steers the global sliders and the
// active-slot pointer — and every mutation runs under a promise lock so a
// concurrent upload can never clobber another. Slots are the single source of
// truth; pre-slot state (the single background.bin + background.json files,
// then the flat wallpaper-collection era) is migrated into slots once on
// first boot.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const wallpaperImages = createWallpaperImages(DATA_DIR);
const SETTINGS_FILE = path.join(DATA_DIR, 'appearance.json');
const IMAGE_FILE = path.join(DATA_DIR, 'background.bin');       // legacy single-wallpaper storage
const IMAGE_META_FILE = path.join(DATA_DIR, 'background.json'); // legacy single-wallpaper storage
const WALLPAPERS_DIR = path.join(DATA_DIR, 'wallpapers');
const MAINTENANCE_DIR = path.join(DATA_DIR, 'maintenance');
const MAX_IMAGE_BYTES = 1073741824; // 1 GB, matches the client input cap
const WALLPAPER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JOB_LOG_BYTES = 131072;
const ACTIVE_JOB_STATES = new Set(['queued', 'running']);
const UPDATE_LABELS = {
  enabled: 'io.service-portal.update.enabled',
  script: 'io.service-portal.update.script',
  image: 'io.service-portal.update.image',
  user: 'io.service-portal.update.user',
  hostHome: 'io.service-portal.update.host-home',
};
const LIFECYCLE_SERVICES_LABEL = 'io.service-portal.lifecycle.services';
const MAINTENANCE_LABEL = 'io.service-portal.maintenance';
const HIDDEN_LABEL = 'io.service-portal.hidden';
// Update checks (see "Update checks" below): opt-in label, the standard OCI
// label that records which source revision a running image was built from,
// and the label that marks the portal's own short-lived check runners.
const UPDATE_CHECK_LABEL = 'io.service-portal.update.check';
const REVISION_LABEL = 'org.opencontainers.image.revision';
const CHECK_RUNNER_LABEL = 'io.service-portal.maintenance.check';

function envNumber(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
// 0 turns the periodic schedule off; page-open and post-job checks still run.
const UPDATE_CHECK_INTERVAL_MINUTES = envNumber('UPDATE_CHECK_INTERVAL_MINUTES', 15, 0, 1440);
const UPDATE_CHECK_INTERVAL_MS = UPDATE_CHECK_INTERVAL_MINUTES > 0
  ? Math.max(1, UPDATE_CHECK_INTERVAL_MINUTES) * 60000 : 0;
const UPDATE_CHECK_MIN_GAP_MS = envNumber('UPDATE_CHECK_MIN_GAP_SECONDS', 60, 0, 3600) * 1000;
const UPDATE_CHECK_TIMEOUT_MS = envNumber('UPDATE_CHECK_TIMEOUT_SECONDS', 120, 1, 900) * 1000;
const UPDATE_CHECK_FIRST_TICK_MS = 20000;
const UPDATE_CHECK_TICK_MS = 60000;

const APPEARANCE_DEFAULTS = {
  slots: [], // ordered collection: [{ id, name, wallpapers: [{ id, type, imageDark, accent, accentTouched }] }]
  activeSlotId: null, // id into slots — the slot clients navigate between
  backgroundPosition: { x: 50, y: 50 }, // origin in the cover crop, 0..100 per axis
  backgroundOpacity: 1,
  backgroundBlur: 0,
  scrim: 0,
  surfaceAlpha: 1, // service-list background opacity (table and sidebar)
  glassBlur: 0,
};
// Wallpaper origin in the cover crop (see --sp-bg-position in index.html): a
// (x, y) point on 0..100 per axis. Pre-grid versions stored one of the five
// anchor strings; those map onto the grid so old settings keep working.
const LEGACY_POSITIONS = { center: [50, 50], top: [50, 0], bottom: [50, 100], left: [0, 50], right: [100, 50] };
function sanitizePosition(raw) {
  if (typeof raw === 'string') raw = LEGACY_POSITIONS[raw];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = [raw.x, raw.y];
  const ax = Array.isArray(raw) ? raw : [];
  const axis = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 50);
  return { x: axis(ax[0]), y: axis(ax[1]) };
}
const APPEARANCE_BOUNDS = {
  backgroundOpacity: { min: 0, max: 1 },
  backgroundBlur: { min: 0, max: 30 },
  scrim: { min: 0, max: 1 },
  surfaceAlpha: { min: 0, max: 1 },
  glassBlur: { min: 0, max: 20 },
};

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(WALLPAPERS_DIR, { recursive: true });
  fs.mkdirSync(MAINTENANCE_DIR, { recursive: true });
} catch (err) {
  console.error('could not create data dir ' + DATA_DIR + ': ' + err.message);
}

function readSettingsFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) ? raw : {};
  } catch (err) {
    return {};
  }
}

/* Validate one wallpaper entry; entries whose image file is missing on disk
   are dropped, so the slots always match what can actually be served. */
function sanitizeWallpaperEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !WALLPAPER_ID_RE.test(entry.id)) return null;
  const id = entry.id.toLowerCase();
  try {
    if (!fs.existsSync(path.join(WALLPAPERS_DIR, id))) return null;
  } catch (err) {}
  return {
    id,
    type: typeof entry.type === 'string' && /^image\//.test(entry.type) ? entry.type : '',
    imageDark: entry.imageDark === true || entry.imageDark === 1,
    accent: typeof entry.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(entry.accent) ? entry.accent.toLowerCase() : '',
    accentTouched: entry.accentTouched === true || entry.accentTouched === 1,
  };
}

/* A slot's optional display name (the header slot menu and the panel's Name
   field show it; unnamed slots fall back to "Slot N" client-side). Control
   and bidi-override characters become spaces, whitespace runs collapse to
   one space, the ends are trimmed, and the result is capped at
   SLOT_NAME_MAX code points (never splitting a surrogate pair). Anything
   that is not a string — including the field missing from a pre-name
   appearance.json — reads as '' (unnamed). */
const SLOT_NAME_MAX = 60;
function sanitizeSlotName(raw) {
  if (typeof raw !== 'string') return '';
  const flat = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(flat).slice(0, SLOT_NAME_MAX).join('').trim();
}

/* Download filename for one wallpaper: "<slot label> <NN>.<ext>". The label
   is the slot's name made filesystem-safe (path and reserved characters
   become '-', leading/trailing dots and spaces go), or "Slot N" (its
   position) when unnamed; NN is the wallpaper's 1-based position in the
   slot, zero-padded to at least two digits; the extension follows the
   stored MIME type (none for a blank type). Derived per request, so it
   follows renames and reorders; nothing extra is stored. */
const WALLPAPER_EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/heic': 'heic', 'image/heif': 'heif',
};
function wallpaperDownloadName(slots, slot, entry) {
  const label = String(slot.name || '').replace(/[\\/:*?"<>|]/g, '-').replace(/^[\s.]+|[\s.]+$/g, '') ||
    'Slot ' + (slots.indexOf(slot) + 1);
  const position = slot.wallpapers.findIndex((w) => w.id === entry.id) + 1;
  const digits = Math.max(2, String(slot.wallpapers.length).length);
  const type = String(entry.type || '').toLowerCase();
  const ext = WALLPAPER_EXTENSIONS[type] || (/^image\/([a-z0-9]+)$/.exec(type) || [])[1] || '';
  return label + ' ' + String(position).padStart(digits, '0') + (ext ? '.' + ext : '');
}

/* Validate one slot entry: its wallpapers revalidated against disk, deduped
   across the whole collection (a wallpaper file belongs to at most one
   slot — the first occurrence wins). */
function sanitizeSlotEntry(slot, seenWallpapers) {
  if (!slot || typeof slot !== 'object' || typeof slot.id !== 'string' || !WALLPAPER_ID_RE.test(slot.id)) return null;
  const wallpapers = [];
  if (Array.isArray(slot.wallpapers)) {
    for (const entry of slot.wallpapers) {
      const clean = sanitizeWallpaperEntry(entry);
      if (clean && !seenWallpapers.has(clean.id)) {
        seenWallpapers.add(clean.id);
        wallpapers.push(clean);
      }
    }
  }
  return { id: slot.id.toLowerCase(), name: sanitizeSlotName(slot.name), wallpapers };
}

/* Global styling sliders (position/opacity/blur/scrim/list-background/glass)
   — shared by the whole portal, independent of which slot is active. */
function sanitizeSliders(raw) {
  const out = { ...APPEARANCE_DEFAULTS, slots: [], activeSlotId: null };
  out.backgroundPosition = sanitizePosition(raw.backgroundPosition);
  for (const [field, b] of Object.entries(APPEARANCE_BOUNDS)) {
    const v = raw[field];
    if (typeof v === 'number' && Number.isFinite(v)) out[field] = Math.min(b.max, Math.max(b.min, v));
  }
  return out;
}

/* The one read model: sliders from the settings file, the slot collection
   revalidated against disk, and the active-slot pointer healed to a real
   slot (the first one when the stored pointer is stale). */
function loadAppearanceState() {
  const raw = readSettingsFile();
  const slots = [];
  const seenSlots = new Set();
  const seenWallpapers = new Set();
  if (Array.isArray(raw.slots)) {
    for (const slot of raw.slots) {
      const clean = sanitizeSlotEntry(slot, seenWallpapers);
      if (clean && !seenSlots.has(clean.id)) {
        seenSlots.add(clean.id);
        slots.push(clean);
      }
    }
  }
  const activeValid = slots.some((s) => s.id === raw.activeSlotId) ? raw.activeSlotId : null;
  const settings = sanitizeSliders(raw);
  settings.slots = slots;
  settings.activeSlotId = slots.length ? (activeValid || slots[0].id) : null;
  return settings;
}

function readAppearanceSettings() {
  return loadAppearanceState();
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

/* Structural mutations (append/delete/replace) read-modify-write the settings
   file, so they run one at a time; a plain settings PUT stays last-writer-
   wins on the sliders it owns. */
let stateLock = Promise.resolve();
function withStateLock(fn) {
  const run = stateLock.then(fn, fn);
  stateLock = run.then(() => undefined, () => undefined);
  return run;
}

/* One-time migration from the single-wallpaper era: background.bin becomes
   the only wallpaper of the first (and active) slot, keeping the sampled
   accent/darkness the old settings file already held for it. */
function migrateLegacyBackground() {
  if (!fs.existsSync(IMAGE_FILE)) return;
  const raw = readSettingsFile();
  if ((Array.isArray(raw.slots) && raw.slots.length > 0) ||
      (Array.isArray(raw.wallpapers) && raw.wallpapers.length > 0)) {
    // A slot collection (new or flat-era schema) already in use: the legacy
    // single-image files are stale.
    fs.rm(IMAGE_FILE, () => {});
    fs.rm(IMAGE_META_FILE, () => {});
    return;
  }
  let type = '';
  try {
    const meta = JSON.parse(fs.readFileSync(IMAGE_META_FILE, 'utf8'));
    if (typeof meta.type === 'string' && meta.type.startsWith('image/')) type = meta.type;
  } catch (err) {}
  if (!type) {
    try { type = faviconMimeType(fs.readFileSync(IMAGE_FILE)); } catch (err) {}
  }
  if (!type) type = 'application/octet-stream';
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(WALLPAPERS_DIR, { recursive: true });
    try {
      fs.renameSync(IMAGE_FILE, path.join(WALLPAPERS_DIR, id));
    } catch (err) {
      fs.copyFileSync(IMAGE_FILE, path.join(WALLPAPERS_DIR, id));
    }
  } catch (err) {
    console.error('could not migrate legacy wallpaper: ' + err.message);
    return;
  }
  const entry = {
    id,
    type,
    imageDark: raw.imageDark === true || raw.imageDark === 1,
    accent: typeof raw.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.accent) ? raw.accent.toLowerCase() : '',
    accentTouched: raw.accentTouched === true || raw.accentTouched === 1,
  };
  const slot = { id: crypto.randomUUID(), name: '', wallpapers: [entry] };
  const settings = loadAppearanceState();
  settings.slots = [slot];
  settings.activeSlotId = slot.id;
  try {
    saveAppearanceSettings(settings);
  } catch (err) {
    console.error('could not save migrated appearance settings: ' + err.message);
  }
  fs.rm(IMAGE_FILE, () => {});
  fs.rm(IMAGE_META_FILE, () => {});
}
migrateLegacyBackground();

/* One-time migration from the flat wallpaper-collection era: each wallpaper
   becomes its own slot (same order), and the slot holding the stored active
   wallpaper becomes the active slot. Runs after the legacy single-image
   migration, which may have just written the old flat schema. */
function migrateLegacyWallpapers() {
  const raw = readSettingsFile();
  const hasSlots = Array.isArray(raw.slots) && raw.slots.length > 0;
  const wallpapers = [];
  if (Array.isArray(raw.wallpapers)) {
    const seen = new Set();
    for (const entry of raw.wallpapers) {
      const clean = sanitizeWallpaperEntry(entry);
      if (clean && !seen.has(clean.id)) {
        seen.add(clean.id);
        wallpapers.push(clean);
      }
    }
  }
  if (hasSlots) {
    if (wallpapers.length) {
      // New schema in use: the flat field is stale — rewrite the file
      // without it so the slot collection is the single source of truth.
      try { saveAppearanceSettings(loadAppearanceState()); } catch (err) {}
    }
    return;
  }
  if (!wallpapers.length) return;
  const slots = wallpapers.map((w) => ({ id: crypto.randomUUID(), name: '', wallpapers: [w] }));
  const activeIdx = Math.max(0, wallpapers.findIndex((w) => w.id === raw.activeWallpaperId));
  const settings = sanitizeSliders(raw);
  settings.slots = slots;
  settings.activeSlotId = slots[activeIdx].id;
  try {
    saveAppearanceSettings(settings);
  } catch (err) {
    console.error('could not save migrated appearance settings: ' + err.message);
  }
}
migrateLegacyWallpapers();

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

function dockerRawRequest(method, pathname, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    let payload = null;
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined) {
      payload = Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request({ socketPath: SOCKET, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          let msg = data.toString('utf8');
          try { msg = JSON.parse(msg).message || msg; } catch (e) {}
          const err = new Error(msg || 'docker api HTTP ' + res.statusCode);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(options.timeoutMs || 5000, () => req.destroy(new Error('docker API timed out')));
    req.end(payload || undefined);
  });
}

function dockerApiRequest(method, pathname, timeoutOrOptions) {
  const options = typeof timeoutOrOptions === 'number'
    ? { timeoutMs: timeoutOrOptions }
    : (timeoutOrOptions || {});
  return dockerRawRequest(method, pathname, options).then((response) => response.body.toString('utf8'));
}

function dockerJsonRequest(method, pathname, body, timeoutMs) {
  return dockerApiRequest(method, pathname, { body, timeoutMs }).then((data) => data ? JSON.parse(data) : {});
}

/* JSON list calls (GET /containers/json). */
function dockerApi(pathname) {
  return dockerApiRequest('GET', pathname).then((data) => JSON.parse(data));
}

function safeProjectName(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]{0,62}$/.test(value) ? value : null;
}

function safeRelativeScript(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 || value.includes('\0')) return null;
  if (value.startsWith('/') || value.includes('\\')) return null;
  const normalized = path.posix.normalize(value.replace(/^\.\//, ''));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return /^[A-Za-z0-9._ /-]+$/.test(normalized) ? normalized : null;
}

function safeHostHome(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !path.posix.isAbsolute(value)) return null;
  if (value === '/' || value.includes(':') || value.includes('\0')) return null;
  return path.posix.normalize(value);
}

function updateCapability(c) {
  const dockerLabels = c && c.Labels || {};
  if (dockerLabels[UPDATE_LABELS.enabled] !== 'true') return null;
  const project = safeProjectName(dockerLabels['com.docker.compose.project']);
  const projectDir = dockerLabels['com.docker.compose.project.working_dir'];
  const script = safeRelativeScript(dockerLabels[UPDATE_LABELS.script]);
  const runnerImage = dockerLabels[UPDATE_LABELS.image] || c.Image;
  const runnerUser = dockerLabels[UPDATE_LABELS.user] || '';
  const runnerHostHome = safeHostHome(dockerLabels[UPDATE_LABELS.hostHome]);
  if (!project || typeof projectDir !== 'string' || !path.posix.isAbsolute(projectDir) ||
      projectDir === '/' || projectDir.includes(':') || projectDir.includes('\0') || !script) return null;
  if (typeof runnerImage !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(runnerImage)) return null;
  if (runnerUser && !/^\d+:\d+$/.test(runnerUser)) return null;
  if (runnerHostHome === null) return null;
  const check = dockerLabels[UPDATE_CHECK_LABEL] === 'true';
  return {
    project, projectDir, script, runnerImage, runnerUser, runnerHostHome, check,
    deployedRevision: deployedRevision(c), targetId: c.Id,
  };
}

/* The source revision the running image was built from, when its build
   recorded one in the standard OCI label. Anything that is not a plain
   commit hash (e.g. "development" or an empty label) reads as unknown. */
function deployedRevision(c) {
  const value = c && c.Labels && c.Labels[REVISION_LABEL];
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value) ? value.toLowerCase() : '';
}

function updateCapabilities(containers) {
  const out = new Map();
  const conflicts = new Set();
  for (const c of containers) {
    const capability = updateCapability(c);
    if (!capability || conflicts.has(capability.project)) continue;
    const existing = out.get(capability.project);
    if (!existing) {
      out.set(capability.project, capability);
      continue;
    }
    const same = existing.projectDir === capability.projectDir &&
      existing.script === capability.script &&
      existing.runnerImage === capability.runnerImage &&
      existing.runnerUser === capability.runnerUser &&
      existing.runnerHostHome === capability.runnerHostHome &&
      existing.check === capability.check;
    if (!same) {
      out.delete(capability.project);
      conflicts.add(capability.project);
    }
  }
  return out;
}

function containerHealth(c) {
  if (c.Health && typeof c.Health.Status === 'string') return c.Health.Status;
  const match = String(c.Status || '').match(/\((healthy|unhealthy|health: starting)\)\s*$/);
  return match ? (match[1] === 'health: starting' ? 'starting' : match[1]) : null;
}

function lifecycleCapabilities(containers, updates) {
  const labeled = new Map();
  for (const c of containers) {
    const dockerLabels = c.Labels || {};
    if (!Object.hasOwn(dockerLabels, LIFECYCLE_SERVICES_LABEL)) continue;
    const project = safeProjectName(dockerLabels['com.docker.compose.project']);
    if (!project) continue;
    const entries = labeled.get(project) || [];
    entries.push(c);
    labeled.set(project, entries);
  }

  const out = new Map();
  for (const [project, entries] of labeled) {
    // Exactly one update-enabled Compose service opts the project in. Other
    // services are members by name, including ones hidden from discovery.
    if (entries.length !== 1 || !updates.has(project)) continue;
    const anchor = entries[0];
    const anchorCapability = updateCapability(anchor);
    const raw = anchor.Labels[LIFECYCLE_SERVICES_LABEL];
    const anchorService = anchor.Labels['com.docker.compose.service'];
    if (!anchorCapability || typeof raw !== 'string' || raw.length > 512 ||
        typeof anchorService !== 'string' || hiddenService(anchor)) continue;
    const services = raw.split(',').map((name) => name.trim());
    if (!services.length || services.length > 16 ||
        services.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(name)) ||
        new Set(services).size !== services.length || !services.includes(anchorService)) continue;

    const members = [];
    let invalid = false;
    for (const service of services) {
      const matches = containers.filter((c) => c.Labels &&
        c.Labels['com.docker.compose.project'] === project &&
        c.Labels['com.docker.compose.service'] === service);
      if (matches.length > 1 || (matches.length === 1 &&
          matches[0].Labels['com.docker.compose.project.working_dir'] !== anchorCapability.projectDir)) {
        invalid = true;
        break;
      }
      const c = matches[0];
      members.push({ service, id: c ? c.Id : null, state: c ? c.State : 'missing',
        health: c ? containerHealth(c) : null });
    }
    if (invalid) continue;
    const running = members.filter((member) => member.state === 'running').length;
    const state = running === members.length &&
      members.every((member) => !member.health || member.health === 'healthy') ? 'running' : running === 0 &&
      members.every((member) => ['created', 'exited', 'dead'].includes(member.state)) ? 'stopped' : 'partial';
    out.set(project, { project, anchorId: anchor.Id, services, members, state });
  }
  return out;
}

const maintenanceJobs = new Map();
const maintenanceMonitors = new Map();

function maintenanceJobFile(id) {
  return path.join(MAINTENANCE_DIR, id + '.json');
}

function saveMaintenanceJob(job) {
  const tmp = maintenanceJobFile(job.id) + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, maintenanceJobFile(job.id));
}

function loadMaintenanceJobs() {
  let names = [];
  try { names = fs.readdirSync(MAINTENANCE_DIR); } catch (err) { return; }
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(MAINTENANCE_DIR, name), 'utf8'));
      if (job && /^[0-9a-f-]{36}$/.test(job.id) && safeProjectName(job.project)) {
        maintenanceJobs.set(job.id, job);
      }
    } catch (err) {
      console.error('ignoring bad maintenance job ' + name + ': ' + err.message);
    }
  }
}

function publicMaintenanceJob(job, includeLogs) {
  if (!job) return null;
  const out = {
    id: job.id,
    project: job.project,
    action: job.action || 'update',
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    exitCode: Number.isInteger(job.exitCode) ? job.exitCode : null,
    error: job.error || null,
  };
  if (includeLogs) out.logs = job.logs || '';
  return out;
}

function latestMaintenanceJob(project) {
  let latest = null;
  for (const job of maintenanceJobs.values()) {
    if (job.project !== project) continue;
    if (!latest || job.createdAt > latest.createdAt) latest = job;
  }
  return latest;
}

function activeMaintenanceJob(project) {
  for (const job of maintenanceJobs.values()) {
    if (job.project === project && ACTIVE_JOB_STATES.has(job.state)) return job;
  }
  return null;
}

/* ---- Activity feed ------------------------------------------------------
   The portal used to report actions only through transient toasts in the
   browser that triggered them — gone after 5 s, invisible to other clients,
   and lost on reload. The activity feed makes that history durable: update
   events are derived from the persisted maintenance jobs (one event per job,
   carrying its full logs), and container start/stop actions are appended to
   an append-only JSONL file next to them. GET /api/activity merges both,
   newest first. */
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.jsonl');
const ACTIVITY_MAX_BYTES = 262144;   // rotate the log past 256 KB…
const ACTIVITY_KEEP_LINES = 500;     // …keeping the most recent events
const ACTIVITY_MAX_EVENTS = 200;     // cap one feed page

function logActivityEvent(ev) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(ACTIVITY_FILE, JSON.stringify(ev) + '\n');
    if (fs.statSync(ACTIVITY_FILE).size > ACTIVITY_MAX_BYTES) {
      const lines = fs.readFileSync(ACTIVITY_FILE, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(ACTIVITY_FILE, lines.slice(-ACTIVITY_KEEP_LINES).join('\n') + '\n');
    }
  } catch (err) {
    console.error('could not record activity event: ' + err.message);
  }
}

function readActivityEvents() {
  let text = '';
  try { text = fs.readFileSync(ACTIVITY_FILE, 'utf8'); } catch (err) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev.at === 'string' && typeof ev.kind === 'string') out.push(ev);
    } catch (err) { /* skip a torn line */ }
  }
  return out;
}

function maintenanceActivityMessage(job) {
  const action = job.action || 'update';
  const noun = action === 'update' ? 'Update' : action === 'start' ? 'Start' : 'Stop';
  if (job.state === 'queued') return noun + ' queued for ' + job.project;
  if (job.state === 'running') return noun + ' running for ' + job.project;
  if (job.state === 'succeeded') return action === 'update'
    ? 'Updated and restarted ' + job.project
    : (action === 'start' ? 'Started ' : 'Stopped ') + job.project;
  if (job.state === 'failed') return noun + ' failed for ' + job.project;
  return noun + ' ' + job.state + ' for ' + job.project;
}

function activityEvents() {
  const events = [];
  for (const job of maintenanceJobs.values()) {
    events.push({
      id: job.id,
      kind: job.action && job.action !== 'update' ? 'project' : 'update',
      action: job.action || 'update',
      at: job.finishedAt || job.startedAt || job.createdAt,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt || null,
      project: job.project,
      state: job.state,
      message: maintenanceActivityMessage(job),
      error: job.error || null,
      hasLogs: true,
    });
  }
  events.push(...readActivityEvents());
  events.sort((a, b) => (String(a.at) < String(b.at) ? 1 : String(a.at) > String(b.at) ? -1 : 0));
  return events.slice(0, ACTIVITY_MAX_EVENTS);
}

function decodeDockerLogs(buffer) {
  if (!buffer || !buffer.length) return '';
  const parts = [];
  let offset = 0;
  let framed = true;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length || buffer[offset + 1] !== 0 ||
        buffer[offset + 2] !== 0 || buffer[offset + 3] !== 0) {
      framed = false;
      break;
    }
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) { framed = false; break; }
    parts.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  let output = (framed ? Buffer.concat(parts) : buffer);
  if (output.length > MAX_JOB_LOG_BYTES) output = output.subarray(output.length - MAX_JOB_LOG_BYTES);
  return output.toString('utf8').replace(/\u0000/g, '');
}

function maintenanceFailureMessage(logs, exitCode) {
  const lines = String(logs || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = lines.find((candidate) => /\b(error|fatal|failed|refusing)\b/i.test(candidate));
  if (!line) return 'maintenance runner exited with code ' + exitCode;
  const withoutTimestamp = line.replace(/^\d{4}-\d\d-\d\dT\S+Z\s+/, '');
  return withoutTimestamp.length > 300 ? withoutTimestamp.slice(0, 297) + '...' : withoutTimestamp;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function monitorMaintenanceJob(job) {
  if (!job || !ACTIVE_JOB_STATES.has(job.state) || maintenanceMonitors.has(job.id)) return;
  const monitor = (async () => {
    while (ACTIVE_JOB_STATES.has(job.state)) {
      let inspection;
      try {
        inspection = JSON.parse(await dockerApiRequest(
          'GET', '/containers/' + encodeURIComponent(job.containerId) + '/json', 10000));
      } catch (err) {
        if (err.statusCode === 404) {
          job.state = 'failed';
          job.error = 'maintenance runner disappeared before reporting a result';
          job.finishedAt = new Date().toISOString();
          saveMaintenanceJob(job);
          break;
        }
        await wait(2000);
        continue;
      }
      const state = inspection.State || {};
      if (state.Running) {
        if (job.state !== 'running') {
          job.state = 'running';
          job.startedAt = state.StartedAt || new Date().toISOString();
          saveMaintenanceJob(job);
        }
        await wait(1500);
        continue;
      }
      if (state.Status === 'created') {
        await wait(500);
        continue;
      }

      let logs = '';
      try {
        const response = await dockerRawRequest(
          'GET', '/containers/' + encodeURIComponent(job.containerId) + '/logs?stdout=1&stderr=1&timestamps=1',
          { timeoutMs: 10000 });
        logs = decodeDockerLogs(response.body);
      } catch (err) {
        logs = 'Could not read maintenance logs: ' + err.message;
      }
      job.exitCode = Number.isInteger(state.ExitCode) ? state.ExitCode : 1;
      job.logs = logs;
      job.state = job.exitCode === 0 ? 'succeeded' : 'failed';
      if (job.exitCode !== 0 && !job.error) job.error = maintenanceFailureMessage(logs, job.exitCode);
      job.finishedAt = state.FinishedAt || new Date().toISOString();
      saveMaintenanceJob(job);
      try {
        await dockerApiRequest(
          'DELETE', '/containers/' + encodeURIComponent(job.containerId) + '?force=1&v=1', 10000);
      } catch (err) {
        console.error('could not remove maintenance runner ' + job.containerId + ': ' + err.message);
      }
    }
  })().finally(() => {
    maintenanceMonitors.delete(job.id);
    // Re-check soon after any project action, so the Update control reflects
    // the freshly deployed revision instead of waiting for the next interval.
    scheduleUpdateCheckTick(2000);
  });
  maintenanceMonitors.set(job.id, monitor);
}

const maintenanceReservations = new Set();

async function startProjectMaintenance(project, action) {
  const requestedAt = new Date().toISOString();
  const active = activeMaintenanceJob(project);
  if (active || maintenanceReservations.has(project)) {
    const err = new Error('another project action is already running for ' + project);
    err.httpStatus = 409;
    err.job = active || null;
    throw err;
  }
  maintenanceReservations.add(project);
  try {
    // A running update check may hold the project's checkout lock; it always
    // settles within its timeout, so wait for it rather than fail the action.
    const check = updateChecksRunning.get(project);
    if (check) await check.catch(() => {});
    return await launchProjectMaintenance(project, action, requestedAt);
  } finally {
    maintenanceReservations.delete(project);
  }
}

/* The detached runner every project action uses: the validated runner image
   and numeric user, the project checkout at its own absolute path, the Docker
   socket (plus its group), and the optional user-unit mount. Update, start,
   stop, and update checks differ only in the argument, name, labels, and a
   few environment variables. */
function maintenanceRunnerSpec(capability, target, options) {
  const { action, id, requestedAt, runnerName } = options;
  const configuredUser = target && target.Config && target.Config.User || '';
  const runnerUser = capability.runnerUser || (/^\d+(?::\d+)?$/.test(configuredUser) ? configuredUser : '0:0');
  const scriptPath = path.posix.join(capability.projectDir, capability.script);
  const runnerEnv = [
    'HOME=/tmp',
    'SERVICE_PORTAL_ACTION_REQUESTED_AT=' + requestedAt,
    'SERVICE_PORTAL_UPDATE_DELEGATED=1',
    'SERVICE_PORTAL_UPDATE_JOB_ID=' + id,
    'DSH_UPDATE_DELEGATED=1',
    'DSH_UPDATE_CONTAINER_NAME=' + runnerName,
    ...(options.env || []),
  ];
  const runnerMounts = [];
  if (capability.runnerHostHome) {
    const hostUserUnitDir = path.posix.join(
      capability.runnerHostHome, '.config/systemd/user');
    runnerEnv.push('SERVICE_PORTAL_UPDATE_HOST_HOME=' + capability.runnerHostHome);
    runnerMounts.push({
      Type: 'bind',
      Source: hostUserUnitDir,
      Target: hostUserUnitDir,
      ReadOnly: false,
    });
  }
  let socketGid = 0;
  try { socketGid = fs.statSync(SOCKET).gid; } catch (err) {}
  return {
    Image: capability.runnerImage,
    Entrypoint: [scriptPath],
    Cmd: action === 'update' ? [] : [action],
    WorkingDir: capability.projectDir,
    User: runnerUser,
    Env: runnerEnv,
    Labels: {
      [MAINTENANCE_LABEL]: 'true',
      ...(options.labels || {}),
      'io.service-portal.maintenance.project': capability.project,
    },
    HostConfig: {
      AutoRemove: false,
      Init: true,
      Binds: [
        capability.projectDir + ':' + capability.projectDir,
        SOCKET + ':' + SOCKET,
      ],
      Mounts: runnerMounts,
      GroupAdd: [String(socketGid)],
    },
  };
}

async function launchProjectMaintenance(project, action, requestedAt) {
  const containers = await dockerApi('/containers/json?all=1');
  const updates = updateCapabilities(containers);
  const capability = updates.get(project);
  if (!capability) {
    const err = new Error('project is not configured for portal updates');
    err.httpStatus = 404;
    throw err;
  }
  if (action !== 'update' && !lifecycleCapabilities(containers, updates).has(project)) {
    const err = new Error('project is not configured for portal lifecycle actions');
    err.httpStatus = 404;
    throw err;
  }

  let target = {};
  try {
    target = JSON.parse(await dockerApiRequest(
      'GET', '/containers/' + encodeURIComponent(capability.targetId) + '/json', 10000));
  } catch (err) {
    const wrapped = new Error('could not inspect update target: ' + err.message);
    wrapped.httpStatus = 502;
    throw wrapped;
  }
  const id = crypto.randomUUID();
  const runnerName = ('service-portal-' + action + '-' + project + '-' + id.slice(0, 8)).slice(0, 63);
  const spec = maintenanceRunnerSpec(capability, target, {
    action, id, requestedAt, runnerName,
    labels: { 'io.service-portal.maintenance.job': id },
  });
  const job = {
    id,
    project,
    action,
    state: 'queued',
    createdAt: requestedAt,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    logs: '',
    containerId: null,
    containerName: runnerName,
  };
  maintenanceJobs.set(id, job);
  saveMaintenanceJob(job);

  let createdId = null;
  try {
    const created = await dockerJsonRequest(
      'POST', '/containers/create?name=' + encodeURIComponent(runnerName), spec, 30000);
    createdId = created.Id;
    if (typeof createdId !== 'string' || !createdId) throw new Error('Docker did not return a runner ID');
    job.containerId = createdId;
    saveMaintenanceJob(job);
    await dockerApiRequest('POST', '/containers/' + encodeURIComponent(createdId) + '/start', 30000);
    job.state = 'running';
    job.startedAt = new Date().toISOString();
    saveMaintenanceJob(job);
    monitorMaintenanceJob(job);
    return job;
  } catch (err) {
    if (createdId) {
      try {
        await dockerApiRequest('DELETE', '/containers/' + encodeURIComponent(createdId) + '?force=1&v=1', 10000);
      } catch (cleanupErr) {}
    }
    job.state = 'failed';
    job.error = 'could not start maintenance runner: ' + err.message;
    job.finishedAt = new Date().toISOString();
    saveMaintenanceJob(job);
    const wrapped = new Error(job.error);
    wrapped.httpStatus = 502;
    wrapped.job = job;
    throw wrapped;
  }
}

/* ---- Update checks -----------------------------------------------------
   A project whose update labels also carry io.service-portal.update.check
   "true" is checked periodically for a pending update, so the browser can
   keep the Update control disabled while nothing would change and say how
   far behind the deployment is when something would. The portal cannot see
   project checkouts, and each project script owns its own Git rules, so a
   check runs the project's update script with the single argument `check`
   in the same detached runner an update uses (image, user, checkout mount,
   socket), plus SERVICE_PORTAL_DEPLOYED_REVISION: the running target
   container's org.opencontainers.image.revision label, empty when unknown.
   The label is a hard opt-in because a script that ignores its arguments
   would otherwise run a full update.

   A check must not change the working tree or any service; it may fetch.
   It reports on stdout (the last summary line wins):

     service-portal-check: status=<current|available> behind=<n|unknown> deployed=<sha|unknown> target=<sha|unknown>
     service-portal-check-commit: <sha> <ISO-8601 date> <subject>   (newest first, optional)
     service-portal-check-note: <text>                              (optional)

   A nonzero exit, a missing or malformed summary, or a timeout is an
   error. Errors never disable the control — only a successful "current"
   does. Checks are not maintenance jobs (no job record, no Activity entry
   of their own) but they never overlap one: an action waits for a running
   check of its project, and no check starts while an action is active.
   One worker runs checks one at a time; results persist in
   <DATA_DIR>/update-checks.json. */
const UPDATE_CHECKS_FILE = path.join(DATA_DIR, 'update-checks.json');
const CHECK_SUMMARY_RE = /^service-portal-check:[ \t]+(.+)$/;
const CHECK_COMMIT_RE = /^service-portal-check-commit:[ \t]+([0-9a-f]{7,40})[ \t]+(\S+)(?:[ \t]+(.*))?$/i;
const CHECK_NOTE_RE = /^service-portal-check-note:[ \t]+(.+)$/;
const MAX_CHECK_COMMITS = 10;
const CHECK_STALE_NOTE = 'The deployment changed since the last check.';

const updateChecks = new Map();        // project -> persisted check record
const updateChecksRunning = new Map(); // project -> promise of its running check
const updateCheckQueue = [];           // projects waiting for the worker
const ownCheckRunners = new Set();     // container IDs this process created
let updateCheckWorker = null;
let updateCheckTimer = null;
let updateCheckCleanupDone = false;

function loadUpdateChecks() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(UPDATE_CHECKS_FILE, 'utf8')); } catch (err) { return; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  for (const [project, record] of Object.entries(raw)) {
    if (safeProjectName(project) && record && typeof record === 'object' && !Array.isArray(record)) {
      updateChecks.set(project, record);
    }
  }
}

function saveUpdateChecks() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    atomicWriteFileSync(UPDATE_CHECKS_FILE, JSON.stringify(Object.fromEntries(updateChecks), null, 2) + '\n');
  } catch (err) {
    console.error('could not save update checks: ' + err.message);
  }
}

/* Script output is untrusted display text: control and bidi-override
   characters become spaces, whitespace collapses, and length is capped. */
function checkText(value, max) {
  const flat = String(value || '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '\u2026' : flat;
}

function checkRevision(value) {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value) ? value.toLowerCase() : null;
}

function parseUpdateCheckOutput(logs) {
  let summary = null;
  const commits = [];
  const notes = [];
  for (const raw of String(logs || '').split(/\r?\n/)) {
    const line = raw.trim();
    let match = line.match(CHECK_SUMMARY_RE);
    if (match) { summary = match[1]; continue; }
    match = line.match(CHECK_COMMIT_RE);
    if (match) {
      if (commits.length < MAX_CHECK_COMMITS) {
        const when = new Date(match[2]);
        commits.push({
          revision: match[1].toLowerCase(),
          committedAt: Number.isNaN(when.getTime()) ? null : when.toISOString(),
          subject: checkText(match[3], 200),
        });
      }
      continue;
    }
    match = line.match(CHECK_NOTE_RE);
    if (match) notes.push(checkText(match[1], 200));
  }
  if (!summary) return { error: 'the update check did not report a result' };
  const fields = {};
  for (const token of summary.trim().split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq > 0) fields[token.slice(0, eq)] = token.slice(eq + 1);
  }
  if (fields.status !== 'current' && fields.status !== 'available') {
    return { error: 'the update check reported an invalid result' };
  }
  const current = fields.status === 'current';
  return {
    status: fields.status,
    behind: current ? 0 : (/^\d{1,9}$/.test(fields.behind || '') ? Number(fields.behind) : null),
    deployed: checkRevision(fields.deployed),
    target: checkRevision(fields.target),
    commits: current ? [] : commits,
    note: notes.length ? checkText(notes.join(' '), 300) : null,
  };
}

/* The client view of a project's check. A result taken against a different
   deployed revision than the one running now is reported as unknown (and
   the next scheduler tick re-checks it). */
function publicUpdateCheck(capability) {
  if (!capability || !capability.check) return null;
  const project = capability.project;
  const out = {
    status: 'unknown',
    checking: updateChecksRunning.has(project) || updateCheckQueue.includes(project),
    checkedAt: null,
    behind: null,
    deployed: null,
    target: null,
    commits: [],
    note: null,
    error: null,
    intervalMinutes: UPDATE_CHECK_INTERVAL_MINUTES,
  };
  const record = updateChecks.get(project);
  if (!record || !record.checkedAt) return out;
  out.checkedAt = record.checkedAt;
  if ((record.deployedInput || '') !== capability.deployedRevision) {
    out.note = CHECK_STALE_NOTE;
    return out;
  }
  out.status = ['current', 'available', 'error'].includes(record.status) ? record.status : 'unknown';
  out.behind = Number.isInteger(record.behind) ? record.behind : null;
  out.deployed = record.deployed || null;
  out.target = record.target || null;
  out.commits = Array.isArray(record.commits) ? record.commits.slice(0, MAX_CHECK_COMMITS) : [];
  out.note = record.note || null;
  out.error = record.error || null;
  return out;
}

function stopContainerQuietly(id) {
  // A grace period lets a script's TERM trap release its checkout lock.
  return dockerApiRequest('POST', '/containers/' + encodeURIComponent(id) + '/stop?t=10', 20000)
    .catch(() => {});
}

function removeContainerQuietly(id) {
  return dockerApiRequest('DELETE', '/containers/' + encodeURIComponent(id) + '?force=1&v=1', 10000)
    .catch((err) => console.error('could not remove update check runner ' + id + ': ' + err.message));
}

async function executeUpdateCheck(capability, target) {
  const id = crypto.randomUUID();
  const runnerName = ('service-portal-check-' + capability.project + '-' + id.slice(0, 8)).slice(0, 63);
  const spec = maintenanceRunnerSpec(capability, target, {
    action: 'check', id, requestedAt: new Date().toISOString(), runnerName,
    labels: { [CHECK_RUNNER_LABEL]: id },
    env: ['SERVICE_PORTAL_DEPLOYED_REVISION=' + capability.deployedRevision],
  });
  let containerId = null;
  try {
    const created = await dockerJsonRequest(
      'POST', '/containers/create?name=' + encodeURIComponent(runnerName), spec, 30000);
    containerId = created.Id;
    if (typeof containerId !== 'string' || !containerId) {
      containerId = null;
      throw new Error('Docker did not return a runner ID');
    }
    ownCheckRunners.add(containerId);
    await dockerApiRequest('POST', '/containers/' + encodeURIComponent(containerId) + '/start', 30000);
    const deadline = Date.now() + UPDATE_CHECK_TIMEOUT_MS;
    let state = {};
    for (let first = true; ; first = false) {
      await wait(first ? 300 : 1000);
      try {
        const inspection = JSON.parse(await dockerApiRequest(
          'GET', '/containers/' + encodeURIComponent(containerId) + '/json', 10000));
        state = inspection.State || {};
      } catch (err) {
        if (err.statusCode === 404) throw new Error('the update check runner disappeared before reporting a result');
        state = { Running: true };
      }
      if (!state.Running && state.Status !== 'created') break;
      if (Date.now() >= deadline) {
        await stopContainerQuietly(containerId);
        return { error: 'the update check timed out after ' + Math.round(UPDATE_CHECK_TIMEOUT_MS / 1000) + ' s' };
      }
    }
    let logs = '';
    try {
      const response = await dockerRawRequest(
        'GET', '/containers/' + encodeURIComponent(containerId) + '/logs?stdout=1&stderr=1',
        { timeoutMs: 10000 });
      logs = decodeDockerLogs(response.body);
    } catch (err) {
      return { error: 'could not read the update check output: ' + err.message };
    }
    const exitCode = Number.isInteger(state.ExitCode) ? state.ExitCode : 1;
    if (exitCode !== 0) return { error: maintenanceFailureMessage(logs, exitCode) };
    return parseUpdateCheckOutput(logs);
  } finally {
    if (containerId) {
      await removeContainerQuietly(containerId);
      ownCheckRunners.delete(containerId);
    }
  }
}

function updateCheckActivity(project, record) {
  const behind = record.behind;
  logActivityEvent({
    id: crypto.randomUUID(),
    at: record.checkedAt,
    kind: 'update-check',
    action: 'check',
    project,
    service: record.label || project,
    state: 'available',
    message: 'Update available for ' + (record.label || project) +
      (behind > 0 ? ': ' + behind + ' commit' + (behind === 1 ? '' : 's') + ' behind' : ''),
  });
}

async function runUpdateCheck(project) {
  const containers = (await dockerApi('/containers/json?all=1'))
    .filter((c) => !(c.Labels && c.Labels[MAINTENANCE_LABEL] === 'true'));
  const capability = updateCapabilities(containers).get(project);
  if (!capability || !capability.check) return; // no longer opted in
  const previous = updateChecks.get(project) || {};
  const anchor = containers.find((c) => c.Id === capability.targetId);
  const label = anchor ? ((labels[containerName(anchor)] || {}).label || containerName(anchor)) : project;
  const startedAt = new Date().toISOString();
  updateChecks.set(project, { ...previous, startedAt });
  let result;
  try {
    let target = {};
    try {
      target = JSON.parse(await dockerApiRequest(
        'GET', '/containers/' + encodeURIComponent(capability.targetId) + '/json', 10000));
    } catch (err) {
      throw new Error('could not inspect the update target: ' + err.message);
    }
    result = await executeUpdateCheck(capability, target);
  } catch (err) {
    result = { error: err.message };
  }
  const failed = !!result.error;
  const record = {
    status: failed ? 'error' : result.status,
    startedAt,
    checkedAt: new Date().toISOString(),
    deployedInput: capability.deployedRevision,
    label,
    behind: failed ? null : result.behind,
    deployed: failed ? null : result.deployed,
    target: failed ? null : result.target,
    commits: failed ? [] : result.commits,
    note: failed ? null : result.note,
    error: failed ? checkText(result.error, 300) : null,
    notifiedTarget: previous.notifiedTarget || null,
  };
  if (record.status === 'available') {
    // Announce each newly available target once; the Activity badge is what
    // tells someone who is not looking at the list that an update is ready.
    const key = record.target || 'unknown';
    if (key !== record.notifiedTarget) {
      record.notifiedTarget = key;
      updateCheckActivity(project, record);
    }
  } else if (record.status === 'current') {
    record.notifiedTarget = null;
  }
  updateChecks.set(project, record);
  saveUpdateChecks();
}

function updateCheckBlocked(project) {
  return !!(activeMaintenanceJob(project) || maintenanceReservations.has(project));
}

/* Queue a project's check. Browser-requested checks respect the minimum gap
   since the last check started; scheduler-detected ones (never checked, a
   changed deployment, a finished action, the interval) do not. */
function queueUpdateCheck(project, respectGap) {
  if (updateChecksRunning.has(project) || updateCheckQueue.includes(project) || updateCheckBlocked(project)) {
    return false;
  }
  if (respectGap) {
    const record = updateChecks.get(project);
    const last = record ? Date.parse(record.startedAt) : NaN;
    if (Number.isFinite(last) && Date.now() - last < UPDATE_CHECK_MIN_GAP_MS) return false;
  }
  updateCheckQueue.push(project);
  startUpdateCheckWorker();
  return true;
}

function startUpdateCheckWorker() {
  if (updateCheckWorker) return;
  updateCheckWorker = (async () => {
    while (updateCheckQueue.length) {
      const project = updateCheckQueue[0];
      if (updateCheckBlocked(project)) { updateCheckQueue.shift(); continue; }
      const running = runUpdateCheck(project);
      updateChecksRunning.set(project, running);
      updateCheckQueue.shift();
      try {
        await running;
      } catch (err) {
        console.error('update check for ' + project + ' failed: ' + err.message);
      } finally {
        updateChecksRunning.delete(project);
      }
    }
  })().finally(() => {
    updateCheckWorker = null;
    if (updateCheckQueue.length) startUpdateCheckWorker();
  });
}

function updateCheckDue(capability) {
  const record = updateChecks.get(capability.project);
  if (!record || !record.checkedAt) return true;
  if ((record.deployedInput || '') !== capability.deployedRevision) return true;
  const started = Date.parse(record.startedAt) || 0;
  if (UPDATE_CHECK_INTERVAL_MS && Date.now() - started >= UPDATE_CHECK_INTERVAL_MS) return true;
  const job = latestMaintenanceJob(capability.project);
  const finished = job && job.finishedAt ? Date.parse(job.finishedAt) : NaN;
  return Number.isFinite(finished) && finished > started;
}

/* Runners left behind by a previous portal process (e.g. one replaced by its
   own update mid-check) are stopped and removed on the first tick. */
async function removeLeftoverCheckRunners(list) {
  for (const c of list) {
    if (!(c.Labels && c.Labels[CHECK_RUNNER_LABEL]) || ownCheckRunners.has(c.Id)) continue;
    if (c.State === 'running') await stopContainerQuietly(c.Id);
    await removeContainerQuietly(c.Id);
  }
}

function scheduleUpdateCheckTick(delayMs) {
  if (updateCheckTimer) clearTimeout(updateCheckTimer);
  updateCheckTimer = setTimeout(runUpdateCheckTick, delayMs);
  updateCheckTimer.unref();
}

async function runUpdateCheckTick() {
  updateCheckTimer = null;
  try {
    const list = await dockerApi('/containers/json?all=1');
    if (!updateCheckCleanupDone) {
      updateCheckCleanupDone = true;
      await removeLeftoverCheckRunners(list);
    }
    const containers = list.filter((c) => !(c.Labels && c.Labels[MAINTENANCE_LABEL] === 'true'));
    for (const capability of updateCapabilities(containers).values()) {
      if (capability.check && updateCheckDue(capability)) queueUpdateCheck(capability.project, false);
    }
  } catch (err) {
    // Docker is unavailable; the next tick tries again.
  } finally {
    if (!updateCheckTimer) scheduleUpdateCheckTick(UPDATE_CHECK_TICK_MS);
  }
}

loadUpdateChecks();
// Tests shorten the first tick; deployments use the default.
scheduleUpdateCheckTick(envNumber('UPDATE_CHECK_FIRST_TICK_MS', UPDATE_CHECK_FIRST_TICK_MS, 0, 600000));

loadMaintenanceJobs();
for (const job of maintenanceJobs.values()) monitorMaintenanceJob(job);

function containerName(c) {
  return c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : c.Id.slice(0, 12);
}

function hiddenService(c) {
  const meta = labels[containerName(c)] || {};
  return meta.hidden === true || !!(c.Labels && c.Labels[HIDDEN_LABEL] === 'true');
}

// A reverse proxy may serve a different hostname/port than the app container.
// Only allow browser URLs, without embedded credentials.
function browserUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function toService(c, capability, job, lifecycle) {
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
  const name = containerName(c);
  const meta = labels[name] || {};
  const project = safeProjectName(c.Labels && c.Labels['com.docker.compose.project']);
  return {
    name,
    label: meta.label || null,
    description: meta.description || null,
    url: browserUrl(c.Labels && c.Labels['io.service-portal.url']) || browserUrl(meta.url),
    id: c.Id.slice(0, 12),
    image: c.Image,
    state: c.State,
    health: containerHealth(c),
    statusLine: c.Status,
    ports,
    self: name === SELF_NAME,
    project,
    update: capability ? {
      available: true,
      project: capability.project,
      job: publicMaintenanceJob(job, false),
      check: publicUpdateCheck(capability),
    } : null,
    lifecycle: lifecycle ? {
      available: true,
      project: lifecycle.project,
      services: lifecycle.services,
      members: lifecycle.members.map(({ service, state, health }) => ({ service, state, health })),
      state: lifecycle.state,
      job: publicMaintenanceJob(job, false),
    } : null,
  };
}

const server = http.createServer((req, res) => {
  let pathname;
  let searchParams;
  try {
    const parsed = new URL(req.url, 'http://internal');
    pathname = parsed.pathname;
    searchParams = parsed.searchParams;
  } catch {
    pathname = req.url;
    searchParams = new URLSearchParams();
  }

  if (pathname === '/api/services') {
    dockerApi('/containers/json?all=1')
      .then((list) => {
        const containers = list.filter((c) => !(c.Labels && c.Labels[MAINTENANCE_LABEL] === 'true'));
        // Validate against every member, including stopped and hidden ones.
        const capabilities = updateCapabilities(containers);
        const lifecycles = lifecycleCapabilities(containers, capabilities);
        const groupedMembers = new Set();
        for (const lifecycle of lifecycles.values()) {
          for (const member of lifecycle.members) {
            if (member.id && member.id !== lifecycle.anchorId) groupedMembers.add(member.id);
          }
        }
        const visible = containers.filter((c) => !hiddenService(c) && !groupedMembers.has(c.Id));
        const services = visible.map((c) => {
          const project = safeProjectName(c.Labels && c.Labels['com.docker.compose.project']);
          const capability = project ? capabilities.get(project) : null;
          const lifecycle = project ? lifecycles.get(project) : null;
          return toService(c, capability, project ? latestMaintenanceJob(project) : null,
            lifecycle && lifecycle.anchorId === c.Id ? lifecycle : null);
        }).sort((a, b) => a.name.localeCompare(b.name));
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

  const svcAction = pathname.match(/^\/api\/services\/([0-9a-f]{12,64})\/(start|stop)$/);
  if (svcAction) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const action = svcAction[2];
    dockerApi('/containers/json?all=1').then((list) => {
      const containers = list.filter((c) => !(c.Labels && c.Labels[MAINTENANCE_LABEL] === 'true'));
      const lifecycles = lifecycleCapabilities(containers, updateCapabilities(containers));
      if ([...lifecycles.values()].some((lifecycle) => lifecycle.members.some((member) =>
        member.id && member.id.startsWith(svcAction[1])))) {
        sendJson(res, 409, { error: 'use the project start or stop action for this service' });
        return;
      }
      // Docker allows a stopped container its grace period. Inspect supplies
      // a friendly activity name but is not required for the action.
      return dockerApiRequest('GET', '/containers/' + svcAction[1] + '/json', 10000)
        .then((info) => String((info && info.Name) || '').replace(/^\//, ''))
        .catch(() => '')
        .then((name) => name || svcAction[1].slice(0, 12))
        .then((name) => dockerApiRequest('POST', '/containers/' + svcAction[1] + '/' + action, 35000)
        .then(() => {
          logActivityEvent({
            id: crypto.randomUUID(), at: new Date().toISOString(),
            kind: 'container', action, service: name, state: 'ok',
            message: (action === 'start' ? 'Started ' : 'Stopped ') + name,
          });
          sendJson(res, 200, { ok: true, action });
        }, (err) => {
          logActivityEvent({
            id: crypto.randomUUID(), at: new Date().toISOString(),
            kind: 'container', action, service: name, state: 'error',
            message: 'Could not ' + action + ' ' + name + ': ' + err.message,
            error: err.message,
          });
          sendJson(res, 502, { error: 'docker api error: ' + err.message });
        }));
    }).catch((err) => sendJson(res, 502, { error: 'docker api error: ' + err.message }));
    return;
  }

  if (pathname === '/api/activity') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    sendJson(res, 200, { generatedAt: new Date().toISOString(), events: activityEvents() });
    return;
  }

  const projectAction = pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9_.-]{0,62})\/(update|start|stop)$/);
  if (projectAction) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const action = projectAction[2];
    if (req.headers['x-service-portal-action'] !== action) {
      sendJson(res, 403, { error: 'missing or incorrect ' + action + ' action header' });
      return;
    }
    startProjectMaintenance(projectAction[1], action)
      .then((job) => sendJson(res, 202, { ok: true, job: publicMaintenanceJob(job, false) }))
      .catch((err) => {
        const body = { error: err.message };
        if (err.job) body.job = publicMaintenanceJob(err.job, false);
        sendJson(res, err.httpStatus || 502, body);
      });
    return;
  }

  if (pathname === '/api/update-checks') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (req.headers['x-service-portal-action'] !== 'check') {
      sendJson(res, 403, { error: 'missing or incorrect check action header' });
      return;
    }
    dockerApi('/containers/json?all=1').then((list) => {
      const containers = list.filter((c) => !(c.Labels && c.Labels[MAINTENANCE_LABEL] === 'true'));
      const queued = [];
      for (const capability of updateCapabilities(containers).values()) {
        if (capability.check && queueUpdateCheck(capability.project, true)) queued.push(capability.project);
      }
      sendJson(res, 202, { ok: true, queued });
    }).catch((err) => sendJson(res, 502, { error: 'docker api error: ' + err.message }));
    return;
  }

  const maintenanceStatus = pathname.match(/^\/api\/maintenance\/([0-9a-f-]{36})$/);
  if (maintenanceStatus) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const job = maintenanceJobs.get(maintenanceStatus[1]);
    if (!job) {
      sendJson(res, 404, { error: 'maintenance job not found' });
      return;
    }
    sendJson(res, 200, { job: publicMaintenanceJob(job, true) });
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
          if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('invalid settings body');
          return withStateLock(() => {
            const current = loadAppearanceState();
            // Missing slider fields fall back to the stored values, so a
            // partial PUT cannot silently reset the ones it doesn't touch.
            const settings = sanitizeSliders({ ...current, ...raw });
            // The slot collection is managed by the slot/wallpaper endpoints;
            // the PUT only steers the sliders and the active-slot pointer.
            settings.slots = current.slots;
            const requested = raw.activeSlotId;
            settings.activeSlotId = current.slots.length
              ? (typeof requested === 'string' && current.slots.some((s) => s.id === requested)
                  ? requested : current.activeSlotId)
              : null;
            saveAppearanceSettings(settings);
            return settings;
          });
        })
        .then((settings) => sendJson(res, 200, { ok: true, settings }))
        .catch((err) => sendJson(res, 400, { error: err.message }));
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  /* ---- wallpaper slots ---------------------------------------------------
     POST   /api/appearance/slots                  append an empty slot and
                                                   make it the active slot
     DELETE /api/appearance/slots                  remove every slot and all
                                                   wallpapers in them
     DELETE /api/appearance/slots/<id>             remove one slot and every
                                                   wallpaper in it; the active
                                                   slot moves to the previous
                                                   slot (next, if it was the
                                                   first)
     PUT    /api/appearance/slots/<id>             rename the slot ({name});
                                                   sanitized (see
                                                   sanitizeSlotName), '' clears
                                                   it; the active pointer and
                                                   the order are untouched
     POST   /api/appearance/slots/<id>/move        move the slot one position
                                                   ({delta: -1 | 1}); the
                                                   active-slot pointer rides
                                                   along by id; 422 when the
                                                   slot is already at the end
                                                   it wants to move toward
     POST   /api/appearance/slots/<id>/wallpapers  upload a wallpaper (image
                                                   body; x-sp-image-dark /
                                                   x-sp-accent headers) into
                                                   that slot and make the
                                                   slot active
     POST   /api/appearance/wallpapers             (legacy) append a wallpaper
                                                   to the active slot, creating
                                                   a slot when there is none
     GET    /api/appearance/wallpapers             the slots + active-slot
                                                   pointer, plus a derived flat
                                                   wallpaper list for
                                                   pre-slot clients
     DELETE /api/appearance/wallpapers             (legacy) remove every
                                                   wallpaper (all slots)
     GET    /api/appearance/wallpapers/<id>        one wallpaper's bytes;
                                                   ?download=1 adds
                                                   Content-Disposition:
                                                   attachment with a name
                                                   derived from its slot
     GET    /api/appearance/wallpapers/<id>/thumbnail
                                                  cached small WebP preview
     PUT    /api/appearance/wallpapers/<id>        update its meta (imageDark,
                                                   accent, accentTouched)
     DELETE /api/appearance/wallpapers/<id>        remove it from its slot; a
                                                   drained slot is removed too
                                                   and the active slot moves
                                                   to the previous slot */
  const slotWallpapersPath = pathname.match(/^\/api\/appearance\/slots\/([0-9a-f-]{36})\/wallpapers$/i);
  const slotMove = pathname.match(/^\/api\/appearance\/slots\/([0-9a-f-]{36})\/move$/i);
  const slotItem = pathname.match(/^\/api\/appearance\/slots\/([0-9a-f-]{36})$/i);
  const wallpaperItem = pathname.match(/^\/api\/appearance\/wallpapers\/([0-9a-f-]{36})$/i);
  const wallpaperThumbnail = pathname.match(/^\/api\/appearance\/wallpapers\/([0-9a-f-]{36})\/thumbnail$/i);
  if (pathname === '/api/appearance/slots' || slotItem || slotWallpapersPath || slotMove) {
    const slotId = slotItem
      ? slotItem[1].toLowerCase()
      : ((slotWallpapersPath || slotMove) ? (slotWallpapersPath || slotMove)[1].toLowerCase() : null);
    if (pathname === '/api/appearance/slots' && req.method === 'POST') {
      withStateLock(() => {
        const current = loadAppearanceState();
        const slot = { id: crypto.randomUUID(), name: '', wallpapers: [] };
        const settings = { ...current, slots: [...current.slots, slot], activeSlotId: slot.id };
        saveAppearanceSettings(settings);
        return { ok: true, slot, settings };
      })
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }
    if (pathname === '/api/appearance/slots' && req.method === 'DELETE') {
      withStateLock(() => {
        const current = loadAppearanceState();
        const settings = { ...current, slots: [], activeSlotId: null };
        saveAppearanceSettings(settings);
        for (const s of current.slots) for (const w of s.wallpapers) wallpaperImages.remove(w.id);
        return { ok: true, settings };
      })
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }
    if (slotItem && req.method === 'DELETE') {
      withStateLock(() => {
        const current = loadAppearanceState();
        const slotIdx = current.slots.findIndex((s) => s.id === slotId);
        if (slotIdx === -1) { const e = new Error('slot not found'); e.httpStatus = 404; throw e; }
        const slots = current.slots.filter((s) => s.id !== slotId);
        let activeSlotId = current.activeSlotId;
        if (activeSlotId === slotId) {
          activeSlotId = slots.length ? slots[Math.max(0, slotIdx - 1)].id : null;
        }
        const settings = { ...current, slots, activeSlotId };
        saveAppearanceSettings(settings);
        for (const w of current.slots[slotIdx].wallpapers) wallpaperImages.remove(w.id);
        return { ok: true, settings };
      })
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, err.httpStatus || 500, { error: err.message }));
      return;
    }
    if (slotItem && req.method === 'PUT') {
      readBody(req, 4096)
        .then((buf) => {
          let raw;
          try { raw = JSON.parse(buf.toString('utf8')); } catch (err) { const e = new Error('invalid JSON body'); e.httpStatus = 400; throw e; }
          if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || typeof raw.name !== 'string') {
            const e = new Error('name must be a string'); e.httpStatus = 400; throw e;
          }
          const name = sanitizeSlotName(raw.name);
          return withStateLock(() => {
            const current = loadAppearanceState();
            const slotIdx = current.slots.findIndex((s) => s.id === slotId);
            if (slotIdx === -1) { const e = new Error('slot not found'); e.httpStatus = 404; throw e; }
            const slot = { ...current.slots[slotIdx], name };
            const settings = { ...current, slots: current.slots.map((s, i) => (i === slotIdx ? slot : s)) };
            saveAppearanceSettings(settings);
            return { ok: true, slot, settings };
          });
        })
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, err.httpStatus || (err.message === 'payload too large' ? 413 : 400), { error: err.message }));
      return;
    }
    if (slotMove && req.method === 'POST') {
      readBody(req, 65536)
        .then((buf) => {
          let raw;
          try { raw = JSON.parse(buf.toString('utf8')); } catch (err) { const e = new Error('invalid JSON body'); e.httpStatus = 400; throw e; }
          if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || (raw.delta !== -1 && raw.delta !== 1)) {
            const e = new Error('delta must be -1 or 1'); e.httpStatus = 400; throw e;
          }
          const delta = raw.delta;
          return withStateLock(() => {
            const current = loadAppearanceState();
            const slotIdx = current.slots.findIndex((s) => s.id === slotId);
            if (slotIdx === -1) { const e = new Error('slot not found'); e.httpStatus = 404; throw e; }
            const target = slotIdx + delta;
            if (target < 0 || target >= current.slots.length) {
              const e = new Error(delta === 1 ? 'slot is already at the end of the list' : 'slot is already at the start of the list');
              e.httpStatus = 422; throw e;
            }
            const slots = [...current.slots];
            const [moved] = slots.splice(slotIdx, 1);
            slots.splice(target, 0, moved);
            // activeSlotId points at a slot id, so the pointer rides along
            // without any adjustment when the array is reordered.
            const settings = { ...current, slots };
            saveAppearanceSettings(settings);
            return settings;
          });
        })
        .then((settings) => sendJson(res, 200, { ok: true, settings }))
        .catch((err) => sendJson(res, err.httpStatus || 400, { error: err.message }));
      return;
    }
    if (slotWallpapersPath && req.method === 'POST') {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!type.startsWith('image/')) {
        sendJson(res, 415, { error: 'content-type must be an image type' });
        return;
      }
      const accentHeader = String(req.headers['x-sp-accent'] || '');
      const imageDark = req.headers['x-sp-image-dark'] === '1';
      readBody(req, MAX_IMAGE_BYTES)
        .then((buf) => {
          if (buf.length === 0) throw new Error('empty body');
          return withStateLock(() => {
            const current = loadAppearanceState();
            if (!current.slots.some((s) => s.id === slotId)) {
              const e = new Error('slot not found'); e.httpStatus = 404; throw e;
            }
            const wallpaper = {
              id: crypto.randomUUID(),
              type,
              imageDark,
              accent: /^#[0-9a-fA-F]{6}$/.test(accentHeader) ? accentHeader.toLowerCase() : '',
              accentTouched: true, // the client sampled it (or deliberately kept the stock palette)
            };
            const settings = {
              ...current,
              slots: current.slots.map((s) => (s.id === slotId ? { ...s, wallpapers: [...s.wallpapers, wallpaper] } : s)),
              activeSlotId: slotId,
            };
            fs.mkdirSync(WALLPAPERS_DIR, { recursive: true });
            saveAppearanceSettings(settings);
            wallpaperImages.invalidate(wallpaper.id);
            atomicWriteFileSync(path.join(WALLPAPERS_DIR, wallpaper.id), buf);
            return { ok: true, wallpaper, settings };
          });
        })
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, err.httpStatus || (err.message === 'payload too large' ? 413 : 400), { error: err.message }));
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  if (pathname === '/api/appearance/wallpapers' || wallpaperItem || wallpaperThumbnail) {
    const id = (wallpaperItem || wallpaperThumbnail) ? (wallpaperItem || wallpaperThumbnail)[1].toLowerCase() : null;
    const state = readAppearanceSettings();
    // A wallpaper lives in exactly one slot; find the slot that holds it.
    let holder = null;
    if (id) {
      for (const s of state.slots) {
        if (s.wallpapers.some((w) => w.id === id)) { holder = s; break; }
      }
    }
    const entry = id ? holder && holder.wallpapers.find((w) => w.id === id) : null;
    if (id && !entry) {
      sendJson(res, 404, { error: 'wallpaper not found' });
      return;
    }
    if (wallpaperThumbnail) {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
      wallpaperImages.thumbnail(id)
        .then((file) => serveImage(req, res, file, 'image/webp'))
        .catch((err) => sendJson(res, err.status || (err.code === 'ENOENT' ? 404 : 500), { error: 'thumbnail unavailable' }));
      return;
    }
    if (pathname === '/api/appearance/wallpapers' && req.method === 'GET') {
      const activeSlot = state.slots.find((s) => s.id === state.activeSlotId) || null;
      const flat = [];
      for (const s of state.slots) for (const w of s.wallpapers) flat.push(w);
      sendJson(res, 200, {
        slots: state.slots,
        activeSlotId: state.activeSlotId,
        wallpapers: flat, // derived flat view for pre-slot clients
        activeWallpaperId: activeSlot && activeSlot.wallpapers.length ? activeSlot.wallpapers[0].id : null,
      });
      return;
    }
    if (pathname === '/api/appearance/wallpapers' && req.method === 'POST') {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!type.startsWith('image/')) {
        sendJson(res, 415, { error: 'content-type must be an image type' });
        return;
      }
      const accentHeader = String(req.headers['x-sp-accent'] || '');
      const imageDark = req.headers['x-sp-image-dark'] === '1';
      readBody(req, MAX_IMAGE_BYTES)
        .then((buf) => {
          if (buf.length === 0) throw new Error('empty body');
          return withStateLock(() => {
            const current = loadAppearanceState();
            const wallpaper = {
              id: crypto.randomUUID(),
              type,
              imageDark,
              accent: /^#[0-9a-fA-F]{6}$/.test(accentHeader) ? accentHeader.toLowerCase() : '',
              accentTouched: true, // the client sampled it (or deliberately kept the stock palette)
            };
            // The wallpaper lands in the active slot; with no slot at all a
            // fresh one is created and made active.
            let settings;
            if (current.slots.length) {
              settings = {
                ...current,
                slots: current.slots.map((s) => (s.id === current.activeSlotId ? { ...s, wallpapers: [...s.wallpapers, wallpaper] } : s)),
              };
            } else {
              const slot = { id: crypto.randomUUID(), name: '', wallpapers: [wallpaper] };
              settings = { ...current, slots: [slot], activeSlotId: slot.id };
            }
            fs.mkdirSync(WALLPAPERS_DIR, { recursive: true });
            saveAppearanceSettings(settings);
            wallpaperImages.invalidate(wallpaper.id);
            atomicWriteFileSync(path.join(WALLPAPERS_DIR, wallpaper.id), buf);
            return { ok: true, wallpaper, settings };
          });
        })
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, err.message === 'payload too large' ? 413 : 400, { error: err.message }));
      return;
    }
    if (pathname === '/api/appearance/wallpapers' && req.method === 'DELETE') {
      withStateLock(() => {
        const current = loadAppearanceState();
        const settings = { ...current, slots: [], activeSlotId: null };
        saveAppearanceSettings(settings);
        for (const s of current.slots) for (const w of s.wallpapers) wallpaperImages.remove(w.id);
        return { ok: true, settings };
      })
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }
    if (id && req.method === 'GET') {
      // ?download=1 serves the same original bytes as an attachment, named
      // after its slot (see wallpaperDownloadName).
      const extra = searchParams.get('download') === '1'
        ? { 'Content-Disposition': attachmentDisposition(wallpaperDownloadName(state.slots, holder, entry)) }
        : {};
      serveImage(req, res, path.join(WALLPAPERS_DIR, id), entry.type || 'application/octet-stream', extra);
      return;
    }
    if (id && req.method === 'PUT') {
      readBody(req, 65536)
        .then((buf) => {
          let raw;
          try { raw = JSON.parse(buf.toString('utf8')); } catch (err) { throw new Error('invalid JSON body'); }
          return withStateLock(() => {
            const current = loadAppearanceState();
            const slotIdx = current.slots.findIndex((s) => s.wallpapers.some((w) => w.id === id));
            if (slotIdx === -1) { const e = new Error('wallpaper not found'); e.httpStatus = 404; throw e; }
            const idx = current.slots[slotIdx].wallpapers.findIndex((w) => w.id === id);
            const wallpaper = { ...current.slots[slotIdx].wallpapers[idx] };
            if (raw.imageDark === true || raw.imageDark === false || raw.imageDark === 0 || raw.imageDark === 1)
              wallpaper.imageDark = raw.imageDark === true || raw.imageDark === 1;
            if (typeof raw.accent === 'string')
              wallpaper.accent = /^#[0-9a-fA-F]{6}$/.test(raw.accent) ? raw.accent.toLowerCase() : '';
            if (raw.accentTouched === true || raw.accentTouched === false || raw.accentTouched === 0 || raw.accentTouched === 1)
              wallpaper.accentTouched = raw.accentTouched === true || raw.accentTouched === 1;
            const slots = current.slots.map((s, si) =>
              si !== slotIdx ? s
                : { ...s, wallpapers: s.wallpapers.map((w, wi) => (wi === idx ? wallpaper : w)) });
            const settings = { ...current, slots };
            saveAppearanceSettings(settings);
            return { ok: true, wallpaper, settings };
          });
        })
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, err.httpStatus || 400, { error: err.message }));
      return;
    }
    if (id && req.method === 'DELETE') {
      withStateLock(() => {
        const current = loadAppearanceState();
        const slotIdx = current.slots.findIndex((s) => s.wallpapers.some((w) => w.id === id));
        if (slotIdx === -1) { const e = new Error('wallpaper not found'); e.httpStatus = 404; throw e; }
        const remaining = current.slots[slotIdx].wallpapers.filter((w) => w.id !== id);
        let slots;
        let activeSlotId = current.activeSlotId;
        if (remaining.length) {
          slots = current.slots.map((s, si) => (si === slotIdx ? { ...s, wallpapers: remaining } : s));
        } else {
          // The slot drained: remove it; the active slot moves to the
          // previous slot (the next, when this was the first).
          slots = current.slots.filter((s) => s.id !== current.slots[slotIdx].id);
          if (activeSlotId === current.slots[slotIdx].id) {
            activeSlotId = slots.length ? slots[Math.max(0, slotIdx - 1)].id : null;
          }
        }
        const settings = { ...current, slots, activeSlotId };
        saveAppearanceSettings(settings);
        wallpaperImages.remove(id);
        return { ok: true, settings };
      })
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, err.httpStatus || 500, { error: err.message }));
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  /* ---- legacy single-wallpaper endpoint --------------------------------
     Kept working for pre-slot clients: it always addresses the *first*
     wallpaper of the active slot — GET serves its bytes (404 when the active
     slot has none), POST replaces it in place (or creates it in the active
     slot, or in a fresh slot when there is none), DELETE removes it (a
     drained slot is removed too, and the active slot moves to the previous
     slot). */
  if (pathname === '/api/appearance/background') {
    if (req.method === 'GET') {
      const state = readAppearanceSettings();
      const slot = state.slots.find((s) => s.id === state.activeSlotId) || null;
      const entry = slot && slot.wallpapers.length ? slot.wallpapers[0] : null;
      if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no background'); return; }
      serveImage(req, res, path.join(WALLPAPERS_DIR, entry.id), entry.type || 'application/octet-stream');
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
          const accentHeader = String(req.headers['x-sp-accent'] || '');
          const imageDark = req.headers['x-sp-image-dark'] === '1';
          return withStateLock(() => {
            const current = loadAppearanceState();
            const slot = current.slots.find((s) => s.id === current.activeSlotId) || null;
            const first = slot && slot.wallpapers.length ? slot.wallpapers[0] : null;
            const meta = {
              type,
              imageDark,
              accent: /^#[0-9a-fA-F]{6}$/.test(accentHeader) ? accentHeader.toLowerCase() : '',
              accentTouched: true,
            };
            let wallpaper;
            let settings;
            if (first) {
              wallpaper = { ...first, ...meta };
              settings = {
                ...current,
                slots: current.slots.map((s) => (s.id === slot.id ? { ...s, wallpapers: [wallpaper, ...s.wallpapers.slice(1)] } : s)),
              };
            } else if (slot) {
              wallpaper = { id: crypto.randomUUID(), ...meta };
              settings = {
                ...current,
                slots: current.slots.map((s) => (s.id === slot.id ? { ...s, wallpapers: [wallpaper] } : s)),
              };
            } else {
              wallpaper = { id: crypto.randomUUID(), ...meta };
              const fresh = { id: crypto.randomUUID(), name: '', wallpapers: [wallpaper] };
              settings = { ...current, slots: [...current.slots, fresh], activeSlotId: fresh.id };
            }
            fs.mkdirSync(WALLPAPERS_DIR, { recursive: true });
            saveAppearanceSettings(settings);
            wallpaperImages.invalidate(wallpaper.id);
            atomicWriteFileSync(path.join(WALLPAPERS_DIR, wallpaper.id), buf);
            return { ok: true, bytes: buf.length, wallpaper, settings };
          });
        })
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, err.message === 'payload too large' ? 413 : 400, { error: err.message }));
      return;
    }
    if (req.method === 'DELETE') {
      const state = readAppearanceSettings();
      const slot = state.slots.find((s) => s.id === state.activeSlotId) || null;
      if (!slot || !slot.wallpapers.length) {
        sendJson(res, 200, { ok: true });
        return;
      }
      const first = slot.wallpapers[0];
      withStateLock(() => {
        const current = loadAppearanceState();
        const slotIdx = current.slots.findIndex((s) => s.id === slot.id);
        if (slotIdx === -1 || !current.slots[slotIdx].wallpapers.length) return { ok: true, settings: current };
        const curFirst = current.slots[slotIdx].wallpapers[0];
        const remaining = current.slots[slotIdx].wallpapers.slice(1);
        let slots;
        let activeSlotId = current.activeSlotId;
        if (remaining.length) {
          slots = current.slots.map((s, si) => (si === slotIdx ? { ...s, wallpapers: remaining } : s));
        } else {
          slots = current.slots.filter((s) => s.id !== current.slots[slotIdx].id);
          if (activeSlotId === current.slots[slotIdx].id) {
            activeSlotId = slots.length ? slots[Math.max(0, slotIdx - 1)].id : null;
          }
        }
        const settings = { ...current, slots, activeSlotId };
        saveAppearanceSettings(settings);
        wallpaperImages.remove(curFirst.id);
        return { ok: true, settings };
      })
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    fs.readFile(HTML_FILE, (err, buf) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('index.html missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf.toString('utf8')
        .replace(/\{\{PORTAL_TITLE\}\}/g, escapeHtmlText(PORTAL_TITLE))
        .replace(/\{\{FAVICON_MIME\}\}/g, FAVICON.mime)
        .replace(/\{\{FAVICON_VERSION\}\}/g, FAVICON.version));
    });
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(200, {
      'Content-Type': FAVICON.mime,
      'Content-Length': FAVICON.body.length,
      'Cache-Control': 'public, max-age=0, must-revalidate'
    });
    res.end(FAVICON.body);
    return;
  }

  const staticFiles = {
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
