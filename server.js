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
const DEFAULT_PORTAL_TITLE = 'Service Portal';
const PORTAL_TITLE = String(process.env.PORTAL_TITLE || DEFAULT_PORTAL_TITLE)
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120) || DEFAULT_PORTAL_TITLE;

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
const MAINTENANCE_DIR = path.join(DATA_DIR, 'maintenance');
const MAX_IMAGE_BYTES = 209715200; // 200 MB, matches the client input cap
const SERVER_BG_TOKEN = 'server';
const MAX_JOB_LOG_BYTES = 131072;
const ACTIVE_JOB_STATES = new Set(['queued', 'running']);
const UPDATE_LABELS = {
  enabled: 'io.service-portal.update.enabled',
  script: 'io.service-portal.update.script',
  image: 'io.service-portal.update.image',
  user: 'io.service-portal.update.user',
};
const MAINTENANCE_LABEL = 'io.service-portal.maintenance';

const APPEARANCE_DEFAULTS = {
  backgroundImage: '',
  backgroundPosition: 'center',
  imageDark: false,
  backgroundOpacity: 1,
  backgroundBlur: 0,
  scrim: 0,
  surfaceAlpha: 1, // service-list background opacity (table and sidebar)
  glassBlur: 0,
  accent: '', // sampled wallpaper accent (#rrggbb); '' = stock palette
  accentTouched: false, // true once a sample/reset decided the accent for the current wallpaper
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
  fs.mkdirSync(MAINTENANCE_DIR, { recursive: true });
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
  if (typeof raw.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.accent)) out.accent = raw.accent.toLowerCase();
  if (typeof raw.accentTouched === 'boolean') out.accentTouched = raw.accentTouched;
  else if (raw.accentTouched === 0) out.accentTouched = false;
  else if (raw.accentTouched === 1) out.accentTouched = true;
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

function updateCapability(c) {
  const dockerLabels = c && c.Labels || {};
  if (dockerLabels[UPDATE_LABELS.enabled] !== 'true') return null;
  const project = safeProjectName(dockerLabels['com.docker.compose.project']);
  const projectDir = dockerLabels['com.docker.compose.project.working_dir'];
  const script = safeRelativeScript(dockerLabels[UPDATE_LABELS.script]);
  const runnerImage = dockerLabels[UPDATE_LABELS.image] || c.Image;
  const runnerUser = dockerLabels[UPDATE_LABELS.user] || '';
  if (!project || typeof projectDir !== 'string' || !path.posix.isAbsolute(projectDir) ||
      projectDir === '/' || projectDir.includes(':') || projectDir.includes('\0') || !script) return null;
  if (typeof runnerImage !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(runnerImage)) return null;
  if (runnerUser && !/^\d+:\d+$/.test(runnerUser)) return null;
  return { project, projectDir, script, runnerImage, runnerUser, targetId: c.Id };
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
      existing.runnerUser === capability.runnerUser;
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
        Env: [
          'HOME=/tmp',
          'SERVICE_PORTAL_UPDATE_DELEGATED=1',
          'SERVICE_PORTAL_UPDATE_JOB_ID=' + id,
          'DSH_UPDATE_DELEGATED=1',
          'DSH_UPDATE_CONTAINER_NAME=' + runnerName,
        ],
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
    // longer budget than the read-only list fetch.
    dockerApiRequest('POST', '/containers/' + svcAction[1] + '/' + svcAction[2], 35000)
      .then(() => sendJson(res, 200, { ok: true, action: svcAction[2] }))
      .catch((err) => sendJson(res, 502, { error: 'docker api error: ' + err.message }));
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
      res.end(buf.toString('utf8').replace(/\{\{PORTAL_TITLE\}\}/g, escapeHtmlText(PORTAL_TITLE)));
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
