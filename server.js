#!/usr/bin/env node
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

// ---- Appearance persistence (wallpaper slots + styling settings) ----------
// Shared across all clients on the network: settings live in
// <DATA_DIR>/appearance.json — the wallpaper slots (an ordered collection of
// slots, each holding an ordered list of wallpaper entries with MIME type,
// sampled darkness and sampled accent), the id of the active slot, and the
// global styling sliders — with one image file per wallpaper in
// <DATA_DIR>/wallpapers/<id> (id = random UUID). DATA_DIR defaults to ./data
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
const SETTINGS_FILE = path.join(DATA_DIR, 'appearance.json');
const IMAGE_FILE = path.join(DATA_DIR, 'background.bin');       // legacy single-wallpaper storage
const IMAGE_META_FILE = path.join(DATA_DIR, 'background.json'); // legacy single-wallpaper storage
const WALLPAPERS_DIR = path.join(DATA_DIR, 'wallpapers');
const MAINTENANCE_DIR = path.join(DATA_DIR, 'maintenance');
const MAX_IMAGE_BYTES = 209715200; // 200 MB, matches the client input cap
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
const MAINTENANCE_LABEL = 'io.service-portal.maintenance';

const APPEARANCE_DEFAULTS = {
  slots: [], // ordered collection: [{ id, wallpapers: [{ id, type, imageDark, accent, accentTouched }] }]
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
  return { id: slot.id.toLowerCase(), wallpapers };
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
  const slot = { id: crypto.randomUUID(), wallpapers: [entry] };
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
  const slots = wallpapers.map((w) => ({ id: crypto.randomUUID(), wallpapers: [w] }));
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
  return { project, projectDir, script, runnerImage, runnerUser, runnerHostHome, targetId: c.Id };
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
      existing.runnerHostHome === capability.runnerHostHome;
    if (!same) {
      out.delete(capability.project);
      conflicts.add(capability.project);
    }
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

function updateActivityMessage(job) {
  if (job.state === 'queued') return 'Update queued for ' + job.project;
  if (job.state === 'running') return 'Update running for ' + job.project;
  if (job.state === 'succeeded') return 'Updated and restarted ' + job.project;
  if (job.state === 'failed') return 'Update failed for ' + job.project;
  return 'Update ' + job.state + ' for ' + job.project;
}

function activityEvents() {
  const events = [];
  for (const job of maintenanceJobs.values()) {
    events.push({
      id: job.id,
      kind: 'update',
      at: job.finishedAt || job.startedAt || job.createdAt,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt || null,
      project: job.project,
      state: job.state,
      message: updateActivityMessage(job),
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
  })().finally(() => maintenanceMonitors.delete(job.id));
  maintenanceMonitors.set(job.id, monitor);
}

async function startProjectUpdate(project) {
  const active = activeMaintenanceJob(project);
  if (active) {
    const err = new Error('an update is already running for ' + project);
    err.httpStatus = 409;
    err.job = active;
    throw err;
  }

  const containers = await dockerApi('/containers/json?all=1');
  const capability = updateCapabilities(containers).get(project);
  if (!capability) {
    const err = new Error('project is not configured for portal updates');
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
  const configuredUser = target.Config && target.Config.User || '';
  const runnerUser = capability.runnerUser || (/^\d+(?::\d+)?$/.test(configuredUser) ? configuredUser : '0:0');
  const id = crypto.randomUUID();
  const runnerName = ('service-portal-update-' + project + '-' + id.slice(0, 8)).slice(0, 63);
  const scriptPath = path.posix.join(capability.projectDir, capability.script);
  const runnerEnv = [
    'HOME=/tmp',
    'SERVICE_PORTAL_UPDATE_DELEGATED=1',
    'SERVICE_PORTAL_UPDATE_JOB_ID=' + id,
    'DSH_UPDATE_DELEGATED=1',
    'DSH_UPDATE_CONTAINER_NAME=' + runnerName,
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
  const job = {
    id,
    project,
    state: 'queued',
    createdAt: new Date().toISOString(),
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
      'POST', '/containers/create?name=' + encodeURIComponent(runnerName), {
        Image: capability.runnerImage,
        Entrypoint: [scriptPath],
        Cmd: [],
        WorkingDir: capability.projectDir,
        User: runnerUser,
        Env: runnerEnv,
        Labels: {
          [MAINTENANCE_LABEL]: 'true',
          'io.service-portal.maintenance.job': id,
          'io.service-portal.maintenance.project': project,
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
      }, 30000);
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

loadMaintenanceJobs();
for (const job of maintenanceJobs.values()) monitorMaintenanceJob(job);

function toService(c, capability, job) {
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
  const project = safeProjectName(c.Labels && c.Labels['com.docker.compose.project']);
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
    project,
    update: capability ? {
      available: true,
      project: capability.project,
      job: publicMaintenanceJob(job, false),
    } : null,
  };
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://internal').pathname; } catch { pathname = req.url; }

  if (pathname === '/api/services') {
    dockerApi('/containers/json?all=1')
      .then((list) => {
        const visible = list.filter((c) => !(c.Labels && c.Labels[MAINTENANCE_LABEL] === 'true'));
        const capabilities = updateCapabilities(visible);
        const services = visible.map((c) => {
          const project = safeProjectName(c.Labels && c.Labels['com.docker.compose.project']);
          const capability = project ? capabilities.get(project) : null;
          return toService(c, capability, project ? latestMaintenanceJob(project) : null);
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
    // Docker allows a stopped container its 10 s grace period, so this gets a
    // longer budget than the read-only list fetch. The inspect is only for a
    // friendly name in the activity log — never let it fail the action.
    const action = svcAction[2];
    dockerApiRequest('GET', '/containers/' + svcAction[1] + '/json', 10000)
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

  const projectUpdate = pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9_.-]{0,62})\/update$/);
  if (projectUpdate) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (req.headers['x-service-portal-action'] !== 'update') {
      sendJson(res, 403, { error: 'missing update action header' });
      return;
    }
    startProjectUpdate(projectUpdate[1])
      .then((job) => sendJson(res, 202, { ok: true, job: publicMaintenanceJob(job, false) }))
      .catch((err) => {
        const body = { error: err.message };
        if (err.job) body.job = publicMaintenanceJob(err.job, false);
        sendJson(res, err.httpStatus || 502, body);
      });
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
     GET    /api/appearance/wallpapers/<id>        one wallpaper's bytes
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
  if (pathname === '/api/appearance/slots' || slotItem || slotWallpapersPath || slotMove) {
    const slotId = slotItem
      ? slotItem[1].toLowerCase()
      : ((slotWallpapersPath || slotMove) ? (slotWallpapersPath || slotMove)[1].toLowerCase() : null);
    if (pathname === '/api/appearance/slots' && req.method === 'POST') {
      withStateLock(() => {
        const current = loadAppearanceState();
        const slot = { id: crypto.randomUUID(), wallpapers: [] };
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
        for (const s of current.slots) for (const w of s.wallpapers) fs.rm(path.join(WALLPAPERS_DIR, w.id), () => {});
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
        for (const w of current.slots[slotIdx].wallpapers) fs.rm(path.join(WALLPAPERS_DIR, w.id), () => {});
        return { ok: true, settings };
      })
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, err.httpStatus || 500, { error: err.message }));
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

  if (pathname === '/api/appearance/wallpapers' || wallpaperItem) {
    const id = wallpaperItem ? wallpaperItem[1].toLowerCase() : null;
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
              const slot = { id: crypto.randomUUID(), wallpapers: [wallpaper] };
              settings = { ...current, slots: [slot], activeSlotId: slot.id };
            }
            fs.mkdirSync(WALLPAPERS_DIR, { recursive: true });
            saveAppearanceSettings(settings);
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
        for (const s of current.slots) for (const w of s.wallpapers) fs.rm(path.join(WALLPAPERS_DIR, w.id), () => {});
        return { ok: true, settings };
      })
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }
    if (id && req.method === 'GET') {
      fs.readFile(path.join(WALLPAPERS_DIR, id), (err, buf) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('wallpaper not found'); return; }
        res.writeHead(200, {
          'Content-Type': entry.type || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(buf);
      });
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
        fs.rm(path.join(WALLPAPERS_DIR, id), () => {});
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
      fs.readFile(path.join(WALLPAPERS_DIR, entry.id), (err, buf) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no background'); return; }
        res.writeHead(200, {
          'Content-Type': entry.type || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
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
              const fresh = { id: crypto.randomUUID(), wallpapers: [wallpaper] };
              settings = { ...current, slots: [...current.slots, fresh], activeSlotId: fresh.id };
            }
            fs.mkdirSync(WALLPAPERS_DIR, { recursive: true });
            saveAppearanceSettings(settings);
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
        fs.rm(path.join(WALLPAPERS_DIR, curFirst.id), () => {});
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
