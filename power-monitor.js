'use strict';
// Local host power monitor for the efficiency panel.
//
// The portal measures the machine it is deployed on, not a fixed remote box.
// At start it detects which power sources the host actually exposes and
// degrades gracefully to whatever is present:
//
//   CPU (Intel RAPL)  - the host powercap sysfs counter
//     (/host/sys/class/powercap/intel-rapl:N/energy_uj; deployments bind the
//     host /sys read-only at /host/sys). Present on physical Intel hosts
//     where the kernel registers RAPL zones; absent in VMs and AMD boxes.
//   NVIDIA GPUs       - a short-lived `nvidia-smi` container run over the
//     docker socket with --gpus (the NVIDIA container toolkit injects the
//     host driver into the container). The probe runs in the portal's own
//     image, which must be glibc-based because the host nvidia-smi is a
//     glibc binary (a musl/alpine base cannot execute it). Present on
//     hosts with an NVIDIA driver and container toolkit.
//   Baseline          - a flat wattage standing in for the unmeasured
//     board/RAM/fans. Always on (configurable, default 50 W).
//
// It integrates energy between 5 s ticks and persists its state to a JSON
// file so lifetime totals survive portal restarts (the RAPL counter keeps
// counting while the portal is down, so that energy is still captured).
// Every total is an estimate to the extent it includes the baseline: there
// is no whole-system meter in these deployments.

const fs = require('fs');
const path = require('path');

const TICK_MS = 5000;
const WINDOW_SAMPLES = 61;               // 5-minute rolling window
const GPU_RETRY_MS = 15 * 60 * 1000;     // re-probe GPUs after a failed probe
const GPU_FAIL_STRIKES = 6;              // consecutive probe failures before a GPU is treated as gone
const DT_CLAMP_S = [0.4, 300];           // sane window for instantaneous W
const RAPL_ROOTS = ['/host/sys/class/powercap', '/sys/class/powercap'];
const GPU_PROBE_CMD = ['--query-gpu=index,name,power.draw', '--format=csv,noheader,nounits'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readUptimeSeconds() {
  try {
    // /proc/uptime is not namespaced: this is the host uptime.
    return parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
  } catch {
    return 0;
  }
}

function discoverRaplZones() {
  const zones = [];
  for (const root of RAPL_ROOTS) {
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const m = /^intel-rapl:(\d+)$/.exec(entry);
      if (!m) continue;
      const dir = path.join(root, entry);
      try {
        // Verify both counter files read before accepting the zone.
        fs.readFileSync(path.join(dir, 'energy_uj'), 'utf8');
        const rangeRaw = fs.readFileSync(path.join(dir, 'max_energy_range_uj'), 'utf8').trim();
        const range = Number(rangeRaw);
        if (!Number.isFinite(range) || range <= 0) continue;
        zones.push({
          id: entry,
          dir,
          energyPath: path.join(dir, 'energy_uj'),
          rangePath: path.join(dir, 'max_energy_range_uj'),
          range,
          energyJSinceBoot: null,
        });
      } catch {
        // unreadable zone: skip
      }
    }
    if (zones.length) break; // /host/sys wins when present
  }
  return zones;
}

function parseGpuProbeOutput(text) {
  const devices = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/[\u0000-\u0008]/g, '').trim();
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 3) continue;
    const index = Number(parts[0]);
    const watts = Number(parts[2]);
    if (!Number.isInteger(index) || !Number.isFinite(watts)) continue;
    devices.push({ index, name: parts[1] || ('GPU ' + index), watts: Math.max(0, watts) });
  }
  devices.sort((a, b) => a.index - b.index);
  return devices;
}

function loadState(stateFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (raw && typeof raw === 'object' && raw.version === 1 && Number.isFinite(raw.lifetime_j)) {
      return {
        version: 1,
        installedAtMs: Number.isFinite(raw.installed_at_ms) ? raw.installed_at_ms : Date.now(),
        lastTickMs: Number.isFinite(raw.last_tick_ms) ? raw.last_tick_ms : null,
        lifetimeJ: Math.max(0, raw.lifetime_j),
        rapl: raw.rapl && typeof raw.rapl === 'object' ? raw.rapl : {},
      };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('power monitor: could not read state: ' + err.message);
  }
  return { version: 1, installedAtMs: Date.now(), lastTickMs: null, lifetimeJ: 0, rapl: {} };
}

function createPowerMonitor(options) {
  const stateFile = options.stateFile;
  const dockerJson = options.dockerJson;
  const log = options.log || (() => {});
  const selfName = options.selfName || '';
  const gpuImageOverride = options.gpuImage || '';
  const gpuProbeEnabled = options.gpuProbe !== false;

  let baselineW = options.baselineW;
  let state = loadState(stateFile);
  let zones = discoverRaplZones();
  const gpu = { available: false, devices: [], lastWatts: 0, probeError: null, strikes: 0, timer: null, image: gpuImageOverride, failureLogged: false };
  const samples = []; // { t, total, cpu, gpu, base }
  let tickTimer = null;
  let started = false;
  let stopping = false;
  let currentDt = 1; // seconds of the most recent tick (used for RAPL watts)

  function persistState() {
    try {
      const dir = path.dirname(stateFile);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        version: 1,
        installed_at_ms: state.installedAtMs,
        last_tick_ms: state.lastTickMs,
        lifetime_j: state.lifetimeJ,
        rapl: state.rapl,
      }, null, 2) + '\n');
      fs.renameSync(tmp, stateFile);
    } catch (err) {
      log('power monitor: could not save state: ' + err.message);
    }
  }

  function readRapl() {
    let watts = 0;
    let any = false;
    for (const zone of zones) {
      let curUj;
      try {
        curUj = Number(fs.readFileSync(zone.energyPath, 'utf8').trim());
        if (!Number.isFinite(curUj)) throw new Error('unreadable counter');
      } catch (err) {
        zone.energyJSinceBoot = null;
        log('power monitor: RAPL ' + zone.id + ' unreadable: ' + err.message);
        continue;
      }
      zone.energyJSinceBoot = curUj / 1e6; // uJ -> J
      const prev = state.rapl[zone.id];
      let deltaUj;
      if (prev === undefined || !Number.isFinite(prev)) {
        deltaUj = 0; // first sighting: seed only
      } else {
        deltaUj = curUj - prev;
        if (deltaUj < 0) {
          // Either the counter wrapped, or the host rebooted and the
          // counter restarted from zero. A wrap moves us forward by one
          // range; a reset contributes the energy since (re)boot.
          deltaUj = (prev - curUj <= zone.range) ? curUj + zone.range - prev : curUj;
        }
      }
      state.rapl[zone.id] = curUj;
      if (deltaUj > 0) state.lifetimeJ += deltaUj / 1e6; // uJ -> J
      watts += deltaUj / 1e6 / currentDt; // J / s
      any = true;
    }
    return any ? Math.max(0, watts) : null;
  }

  async function runGpuProbe() {
    const image = gpu.image;
    if (!image) throw new Error('no GPU probe image resolved');
    const created = await dockerJson('POST', '/containers/create', {
      Image: image,
      Entrypoint: ['nvidia-smi'],
      Cmd: GPU_PROBE_CMD,
      // Maintenance-labelled so the portal's own service list never shows
      // the probe during the second or so that it exists.
      Labels: { 'io.service-portal.maintenance': 'true', 'io.service-portal.power-probe': 'true' },
      // Count -1 = all GPUs (what `docker run --gpus all` sends); Count 0
      // would request no devices and the toolkit would inject nothing.
      HostConfig: { DeviceRequests: [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }] },
    }, 15000);
    const id = created && created.Id;
    if (!id) throw new Error('docker did not return a container id');
    try {
      await dockerJson('POST', '/containers/' + id + '/start', null, 20000);
      let info = null;
      for (let i = 0; i < 25; i++) { // up to ~10 s
        await sleep(400);
        info = await dockerJson('GET', '/containers/' + id + '/json', null, 5000);
        if (info && info.State && info.State.Status === 'exited') break;
      }
      if (!info || !info.State || info.State.Status !== 'exited') {
        throw new Error('nvidia-smi probe did not finish');
      }
      if (info.State.ExitCode !== 0) {
        throw new Error('nvidia-smi exited with code ' + info.State.ExitCode);
      }
      const logs = await dockerJson('GET', '/containers/' + id + '/logs?stdout=1&stderr=1', null, 5000);
      const devices = parseGpuProbeOutput((logs && logs.stdout) || '');
      if (!devices.length) throw new Error('nvidia-smi returned no GPU data');
      return devices;
    } finally {
      try {
        await dockerJson('DELETE', '/containers/' + id + '?force=1&v=1', null, 10000);
      } catch {
        // best effort
      }
    }
  }

  async function probeGpu(reason) {
    if (!gpu.image) {
      // Resolve our own image name from the running portal container; the
      // NVIDIA toolkit injects nvidia-smi into any image, so ours suffices.
      try {
        if (selfName) {
          const info = await dockerJson('GET', '/containers/' + encodeURIComponent(selfName) + '/json', null, 5000);
          if (info && info.Config && info.Config.Image) gpu.image = info.Config.Image;
        }
      } catch {
        // fall through
      }
      if (!gpu.image) gpu.image = 'service-portal:latest';
    }
    try {
      const devices = await runGpuProbe();
      gpu.devices = devices;
      gpu.lastWatts = devices.reduce((sum, d) => sum + d.watts, 0);
      gpu.available = true;
      gpu.strikes = 0;
      gpu.probeError = null;
      log('power monitor: GPU probe ok (' + devices.map((d) => d.name + ' ' + d.watts.toFixed(0) + ' W').join(', ') + ')' + (reason ? ' [' + reason + ']' : ''));
      return true;
    } catch (err) {
      gpu.strikes += 1;
      gpu.probeError = err.message;
      if (gpu.available && gpu.strikes < GPU_FAIL_STRIKES) {
        // Transient probe failure: keep serving the last known watts.
        log('power monitor: GPU probe failed (strike ' + gpu.strikes + '): ' + err.message);
        return false;
      }
      if (gpu.available) {
        log('power monitor: GPU no longer available: ' + err.message);
      } else if (!gpu.failureLogged) {
        // The first failure is worth a log line too: a host without a GPU
        // (or without the NVIDIA container toolkit) would otherwise fail
        // silently until the next manual investigation.
        log('power monitor: GPU probe unavailable, will retry later: ' + err.message);
        gpu.failureLogged = true;
      }
      gpu.available = false;
      gpu.devices = [];
      gpu.lastWatts = 0;
      scheduleGpuRetry();
      return false;
    }
  }

  function scheduleGpuRetry() {
    if (stopping || gpu.timer) return;
    gpu.timer = setTimeout(() => {
      gpu.timer = null;
      if (!stopping) probeGpu('retry').catch((err) => log('power monitor: GPU retry failed: ' + err.message));
    }, GPU_RETRY_MS);
  }

  async function tick() {
    if (stopping) return;
    const now = Date.now();
    if (state.lastTickMs === null) {
      // First tick after (re)start: seed counters, no energy yet.
      readRapl();
      state.lastTickMs = now;
      persistState();
      return;
    }
    let dt = (now - state.lastTickMs) / 1000;
    state.lastTickMs = now;
    currentDt = Math.min(Math.max(dt, DT_CLAMP_S[0]), DT_CLAMP_S[1]);

    const cpuW = readRapl(); // also accumulates RAPL lifetime energy

    let gpuW = 0;
    if (gpu.available) {
      const ok = await probeGpu();
      if (ok) gpuW = gpu.lastWatts;
      else if (gpu.strikes < GPU_FAIL_STRIKES) gpuW = gpu.lastWatts; // transient: hold last value
    }
    state.lifetimeJ += gpuW * currentDt;
    state.lifetimeJ += baselineW * currentDt;

    const total = (cpuW || 0) + gpuW + baselineW;
    samples.push({
      t: now,
      total: round1(total),
      cpu: round1(cpuW || 0),
      gpu: round1(gpuW),
      base: round1(baselineW),
    });
    while (samples.length > WINDOW_SAMPLES) samples.shift();
    persistState();
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function snapshot() {
    const sources = [];
    let totalW = 0;
    for (const zone of zones) {
      if (zone.energyJSinceBoot === null) continue;
      const last = samples[samples.length - 1];
      sources.push({
        kind: 'rapl',
        id: zone.id,
        name: 'CPU (RAPL ' + zone.id + ')',
        w: last ? last.cpu : 0,
        energyJSinceBoot: zone.energyJSinceBoot,
      });
    }
    for (const device of gpu.devices) {
      sources.push({ kind: 'gpu', id: device.index, name: device.name, w: device.watts });
    }
    sources.push({ kind: 'baseline', id: 'baseline', name: 'Baseline (board, RAM, fans — estimate)', w: baselineW });
    const last = samples[samples.length - 1];
    totalW = last ? last.total : baselineW;

    const hours = Math.max(0, (Date.now() - state.installedAtMs) / 3600000);
    const lifetimeKwh = state.lifetimeJ / 3.6e6;
    return {
      uptimeS: readUptimeSeconds(),
      baselineW,
      totalW: round1(totalW),
      gpuAvailable: gpu.available,
      gpuProbeError: gpu.probeError,
      sources,
      lifetime: {
        j: state.lifetimeJ,
        kwh: lifetimeKwh,
        sinceMs: state.installedAtMs,
        hours,
        avgW: hours > 0 ? state.lifetimeJ / (hours * 3600) : 0,
      },
      samples: samples.slice(),
    };
  }

  return {
    start() {
      if (started) return;
      started = true;
      stopping = false;
      log('power monitor: started (baseline ' + baselineW + ' W, RAPL zones: ' +
        (zones.length ? zones.map((z) => z.id).join(', ') : 'none') + ')');
      tickTimer = setInterval(() => {
        tick().catch((err) => log('power monitor: tick failed: ' + err.message));
      }, TICK_MS);
      if (gpuProbeEnabled) {
        probeGpu('startup').catch((err) => log('power monitor: GPU probe failed: ' + err.message));
      }
    },
    stop() {
      stopping = true;
      if (tickTimer) clearInterval(tickTimer);
      if (gpu.timer) clearTimeout(gpu.timer);
      persistState();
    },
    setBaseline(watts) {
      baselineW = Math.min(Math.max(watts, 0), 1000);
    },
    snapshot,
  };
}

module.exports = { createPowerMonitor };
