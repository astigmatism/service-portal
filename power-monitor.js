'use strict';
// Local host power monitor for the efficiency panel.
//
// The portal measures the machine it is deployed on, not a fixed remote box,
// and reports three sources, always in this order:
//
//   CPU (Intel RAPL)  - the host's powercap energy counter per CPU package
//     (/sys/class/powercap/intel-rapl:N/energy_uj). Present on physical Intel
//     hosts; absent in VMs and on AMD boxes ("not measurable on this host").
//   NVIDIA GPUs       - nvidia-smi power.draw per GPU. Present on hosts with
//     an NVIDIA driver and the NVIDIA container toolkit ("none detected on
//     this host" otherwise).
//   Baseline          - a flat wattage standing in for the unmeasured
//     board/RAM/fans. Always on (configurable, default 50 W).
//
// The RAPL counter is root-only on current kernels and docker masks the host
// powercap tree inside containers, so the portal (which may run as a
// non-root UID) does not read it itself. Instead it runs one small "host
// sampler" container over the docker socket: the portal's own image, as
// root, with the host /sys bound read-only, no network, a read-only root
// filesystem and every capability dropped, plus the GPUs when the host has
// the NVIDIA toolkit (the toolkit injects the host's nvidia-smi; the image
// is glibc-based so it can run). The sampler prints one reading block every
// 5 s and exits after ~15 min; the portal reads its log and starts a fresh
// one, which is also when GPU detection is retried. A host that exposes
// neither source gets a re-check every 15 min instead of a running sampler.
// If the sampler cannot run at all, counters the portal can read directly
// (/host/sys bind, root deployments) are used as a fallback.
//
// Energy is integrated between 5 s ticks and persisted to a JSON file so
// lifetime totals survive portal restarts (the RAPL counter keeps counting
// while the portal is down, so that CPU energy is still captured). Totals
// are estimates to the extent they include the baseline: there is no
// whole-system meter in these deployments.

const fs = require('fs');
const path = require('path');

const TICK_MS = 5000;
const WINDOW_SAMPLES = 61;               // 5-minute rolling window
const SAMPLER_PERIOD_S = 5;              // sampler reading cadence
const SAMPLER_ITERATIONS = 180;          // ~15 min, then the portal starts a fresh sampler
const RECHECK_MS = 15 * 60 * 1000;       // re-detect a host that exposed nothing
const FAILURE_BACKOFF_MS = 60 * 1000;    // retry after the sampler could not be started
const STALE_S = 30;                      // a reading older than this no longer counts as current
const DT_CLAMP_S = [0.4, 300];           // sane window for instantaneous W
const RAPL_ROOTS = ['/host/sys/class/powercap', '/sys/class/powercap'];
const SAMPLER_LABEL = 'io.service-portal.power-sampler';
const MAINTENANCE_LABEL = 'io.service-portal.maintenance';
const GPU_NONE_NOTE = 'none detected on this host';
const CPU_NONE_NOTE = 'not measurable on this host';

// POSIX sh (dash) loop run inside the sampler container. One block per
// reading:  S <host uptime s> / R <zone> <uJ> <range uJ> <name> /
// Q <zone> unreadable / G <nvidia-smi csv> / X <nvidia-smi error> / E
const SAMPLER_SCRIPT = [
  'i=0',
  'while [ "$i" -lt "$ITER" ]; do',
  '  i=$((i+1))',
  '  read up _ < /proc/uptime',
  '  echo "S $up"',
  '  for z in /host/sys/class/powercap/intel-rapl:*; do',
  '    [ -e "$z" ] || continue',
  '    n=${z##*/}',
  '    case "$n" in intel-rapl:*:*) continue;; esac',
  '    if [ -r "$z/energy_uj" ]; then',
  '      printf \'R %s %s %s %s\\n\' "$n" "$(cat "$z/energy_uj")" "$(cat "$z/max_energy_range_uj")" "$(cat "$z/name")"',
  '    else',
  '      echo "Q $n unreadable"',
  '    fi',
  '  done',
  '  if [ "$GPU" = 1 ]; then',
  '    if out=$(nvidia-smi --query-gpu=index,name,power.draw --format=csv,noheader,nounits 2>&1); then',
  '      printf \'%s\\n\' "$out" | sed \'s/^/G /\'',
  '    else',
  '      printf \'X %s\\n\' "$(printf \'%s\' "$out" | head -n 1)"',
  '    fi',
  '  fi',
  '  echo E',
  '  sleep "$PERIOD"',
  'done',
].join('\n');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readUptimeSeconds() {
  try {
    // /proc/uptime is not namespaced: this is the host uptime, the same
    // clock the sampler stamps its readings with.
    return parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
  } catch {
    return 0;
  }
}

// Package zones the portal can read itself (fallback path).
function discoverDirectRaplZones() {
  const zones = [];
  for (const root of RAPL_ROOTS) {
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^intel-rapl:\d+$/.test(entry)) continue;
      const dir = path.join(root, entry);
      try {
        fs.readFileSync(path.join(dir, 'energy_uj'), 'utf8');
        const range = Number(fs.readFileSync(path.join(dir, 'max_energy_range_uj'), 'utf8').trim());
        if (!Number.isFinite(range) || range <= 0) continue;
        let name = entry;
        try { name = fs.readFileSync(path.join(dir, 'name'), 'utf8').trim() || entry; } catch { /* keep id */ }
        zones.push({ id: entry, name, range, energyPath: path.join(dir, 'energy_uj') });
      } catch {
        // unreadable zone: skip
      }
    }
    if (zones.length) break; // /host/sys wins when present
  }
  return zones;
}

function parseGpuLine(text) {
  const parts = text.replace(/[\u0000-\u0008]/g, '').split(',').map((p) => p.trim());
  if (parts.length < 3) return null;
  const index = Number(parts[0]);
  const watts = Number(parts[2]);
  if (!Number.isInteger(index) || !Number.isFinite(watts)) return null;
  return { index, name: parts[1] || ('GPU ' + index), watts: Math.max(0, watts) };
}

// Complete reading blocks from the sampler's log text, oldest first.
function parseSamplerBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/[\u0000-\u0008\r]/g, '').trim();
    if (!line) continue;
    if (line === 'E') {
      if (cur) blocks.push(cur);
      cur = null;
      continue;
    }
    const tag = line.slice(0, 2);
    const rest = line.slice(2).trim();
    if (tag === 'S ') {
      const t = parseFloat(rest);
      cur = Number.isFinite(t) ? { t, rapl: [], unreadable: [], gpus: [], gpuError: null } : null;
      continue;
    }
    if (!cur) continue;
    if (tag === 'R ') {
      const parts = rest.split(/\s+/);
      const uj = Number(parts[1]);
      const range = Number(parts[2]);
      if (/^intel-rapl:\d+$/.test(parts[0]) && Number.isFinite(uj) && Number.isFinite(range) && range > 0) {
        cur.rapl.push({ id: parts[0], uj, range, name: parts.slice(3).join(' ') || parts[0] });
      }
    } else if (tag === 'Q ') {
      cur.unreadable.push(rest.split(/\s+/)[0]);
    } else if (tag === 'G ') {
      const device = parseGpuLine(rest);
      if (device) cur.gpus.push(device);
    } else if (tag === 'X ') {
      cur.gpuError = rest || 'nvidia-smi failed';
    }
  }
  for (const block of blocks) block.gpus.sort((a, b) => a.index - b.index);
  return blocks;
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
  // (pathname) -> Promise<string>: demultiplexed container log text.
  const dockerLogs = options.dockerLogs;
  const log = options.log || (() => {});
  const selfName = options.selfName || '';
  const owner = selfName || 'service-portal';
  const imageOverride = options.image || '';
  const samplerEnabled = options.sampler !== false;
  const tickMs = options.tickMs || TICK_MS;
  const uptime = options.uptime || readUptimeSeconds;
  const samplerPeriodS = options.samplerPeriodS || SAMPLER_PERIOD_S;

  let baselineW = options.baselineW;
  let state = loadState(stateFile);
  const directZones = discoverDirectRaplZones();

  // zone id -> { id, name, range, t, w, energyJSinceBoot }
  const cpu = { zones: new Map(), none: false, unreadable: false };
  const gpu = { devices: [], t: null, none: false, error: null };
  const sampler = {
    id: null, withGpu: false, image: imageOverride, startedMs: 0,
    nextAttemptMs: 0, lastError: null, reaped: false,
  };
  const announced = new Map(); // topic -> last logged message (state-change logging)
  const samples = []; // { t, total, cpu, gpu, base }
  let tickTimer = null;
  let started = false;
  let stopping = false;
  let ticking = false;

  function announce(topic, message) {
    if (announced.get(topic) === message) return;
    announced.set(topic, message);
    log('power monitor: ' + message);
  }

  function persistState() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
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
      announce('save', 'could not save state: ' + err.message);
    }
  }

  function fresh(t) {
    return t !== null && uptime() - t <= STALE_S;
  }

  // One counter reading { id, name, uj, range, t }: accumulates the energy
  // since the previous reading and derives the zone's watts.
  function applyRaplReading(r) {
    let zone = cpu.zones.get(r.id);
    if (!zone) {
      zone = { id: r.id, name: r.name || r.id, range: r.range, t: null, w: null, energyJSinceBoot: null };
      cpu.zones.set(r.id, zone);
    }
    if (zone.t !== null && r.t === zone.t) return; // already applied
    zone.name = r.name || zone.name;
    zone.range = r.range || zone.range;
    const prev = state.rapl[r.id];
    let deltaUj = 0;
    if (Number.isFinite(prev)) {
      deltaUj = r.uj - prev;
      if (deltaUj < 0) {
        // Either the counter wrapped, or the host rebooted and the counter
        // restarted from zero. A wrap moves us forward by one range; a reset
        // contributes the energy since (re)boot.
        deltaUj = (prev - r.uj <= zone.range) ? r.uj + zone.range - prev : r.uj;
      }
    }
    state.rapl[r.id] = r.uj;
    if (deltaUj > 0) state.lifetimeJ += deltaUj / 1e6; // uJ -> J
    if (zone.t !== null) {
      const dt = r.t - zone.t;
      if (dt >= DT_CLAMP_S[0] && dt <= DT_CLAMP_S[1]) zone.w = Math.max(0, deltaUj / 1e6 / dt);
    }
    zone.t = r.t;
    zone.energyJSinceBoot = r.uj / 1e6;
  }

  function readDirect() {
    for (const zone of directZones) {
      let uj;
      try {
        uj = Number(fs.readFileSync(zone.energyPath, 'utf8').trim());
      } catch {
        continue;
      }
      if (Number.isFinite(uj)) applyRaplReading({ id: zone.id, name: zone.name, uj, range: zone.range, t: uptime() });
    }
  }

  async function resolveImage() {
    if (sampler.image) return;
    // Our own image: glibc-based, so the host nvidia-smi injected by the
    // NVIDIA toolkit runs in it.
    try {
      if (selfName) {
        const info = await dockerJson('GET', '/containers/' + encodeURIComponent(selfName) + '/json', null, 5000);
        if (info && info.Config && info.Config.Image) sampler.image = info.Config.Image;
      }
    } catch {
      // fall through
    }
    if (!sampler.image) sampler.image = 'service-portal:latest';
  }

  async function removeContainer(id) {
    try {
      await dockerJson('DELETE', '/containers/' + id + '?force=1&v=1', null, 10000);
    } catch {
      // best effort (AutoRemove may already have removed it)
    }
  }

  // Leftover samplers from an earlier portal process (crash, restart).
  async function reapSamplers() {
    const filters = encodeURIComponent(JSON.stringify({ label: [SAMPLER_LABEL + '=' + owner] }));
    const list = await dockerJson('GET', '/containers/json?all=1&filters=' + filters, null, 5000);
    for (const c of Array.isArray(list) ? list : []) {
      if (c && c.Id && c.Id !== sampler.id) await removeContainer(c.Id);
    }
  }

  function samplerSpec(withGpu) {
    return {
      Image: sampler.image,
      User: '0:0',
      Entrypoint: ['sh', '-c', SAMPLER_SCRIPT],
      Cmd: [],
      Env: ['GPU=' + (withGpu ? 1 : 0), 'PERIOD=' + samplerPeriodS, 'ITER=' + SAMPLER_ITERATIONS],
      // Maintenance-labelled so the portal's service list never shows it.
      Labels: { [MAINTENANCE_LABEL]: 'true', [SAMPLER_LABEL]: owner },
      NetworkDisabled: true,
      HostConfig: {
        AutoRemove: true,
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Binds: ['/sys:/host/sys:ro'],
        // Count -1 = all GPUs (what `docker run --gpus all` sends).
        DeviceRequests: withGpu ? [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }] : [],
      },
    };
  }

  async function createAndStart(withGpu) {
    const created = await dockerJson('POST', '/containers/create', samplerSpec(withGpu), 15000);
    const id = created && created.Id;
    if (!id) throw new Error('docker did not return a container id');
    try {
      await dockerJson('POST', '/containers/' + id + '/start', null, 20000);
    } catch (err) {
      await removeContainer(id);
      throw err;
    }
    return id;
  }

  async function startSampler() {
    try {
      await resolveImage();
      await reapSamplers();
      let id = null;
      let withGpu = true;
      let gpuReason = null;
      try {
        id = await createAndStart(true);
      } catch (err) {
        // No NVIDIA toolkit/driver: the daemon refuses the GPU request.
        withGpu = false;
        gpuReason = err.message;
        id = await createAndStart(false);
      }
      sampler.id = id;
      sampler.withGpu = withGpu;
      sampler.startedMs = Date.now();
      sampler.lastError = null;
      if (!withGpu) {
        gpu.devices = [];
        gpu.t = null;
        gpu.none = true;
        gpu.error = null;
        announce('gpu', 'GPU: ' + GPU_NONE_NOTE + ' (' + gpuReason + ')');
      }
      return true;
    } catch (err) {
      sampler.id = null;
      sampler.lastError = err.message;
      sampler.nextAttemptMs = Date.now() + FAILURE_BACKOFF_MS;
      announce('sampler', 'could not start the host sampler: ' + err.message);
      return false;
    }
  }

  async function latestBlock() {
    let text;
    try {
      text = await dockerLogs('/containers/' + sampler.id + '/logs?stdout=1&stderr=0&tail=60');
    } catch (err) {
      // Gone: it finished its run (AutoRemove) or was removed. Start a fresh
      // one on this tick.
      sampler.id = null;
      if (err.statusCode !== 404) sampler.lastError = err.message;
      return null;
    }
    const blocks = parseSamplerBlocks(text);
    const block = blocks[blocks.length - 1] || null;
    if (block && uptime() - block.t > STALE_S) {
      // Exited but not yet removed, or stuck: replace it.
      const id = sampler.id;
      sampler.id = null;
      await removeContainer(id);
      return null;
    }
    return block;
  }

  function applyBlock(block) {
    for (const r of block.rapl) applyRaplReading({ ...r, t: block.t });
    cpu.unreadable = block.rapl.length === 0 && block.unreadable.length > 0;
    cpu.none = block.rapl.length === 0 && block.unreadable.length === 0;
    if (block.rapl.length) {
      announce('cpu', 'CPU: ' + block.rapl.map((r) => r.name + ' (' + r.id + ')').join(', '));
    } else {
      announce('cpu', 'CPU: ' + (cpu.unreadable ? 'power counter not readable' : CPU_NONE_NOTE));
    }
    if (sampler.withGpu) {
      if (block.gpus.length) {
        gpu.devices = block.gpus;
        gpu.t = block.t;
        gpu.none = false;
        gpu.error = null;
        announce('gpu', 'GPU: ' + block.gpus.map((d) => d.name).join(', '));
      } else {
        gpu.devices = [];
        gpu.t = null;
        gpu.none = !block.gpuError;
        gpu.error = block.gpuError ? 'nvidia-smi failed: ' + block.gpuError : null;
        announce('gpu', 'GPU: ' + (gpu.error || GPU_NONE_NOTE));
      }
    }
  }

  async function collect() {
    if (!samplerEnabled) {
      readDirect();
      cpu.none = directZones.length === 0;
      return;
    }
    if (!sampler.id) {
      if (Date.now() < sampler.nextAttemptMs) {
        readDirect();
        return;
      }
      if (!(await startSampler())) {
        readDirect();
        return;
      }
      await sleep(Math.min(1500, tickMs)); // let it print its first block
    }
    const block = await latestBlock();
    if (!block) {
      readDirect();
      return;
    }
    applyBlock(block);
    const measuresSomething = block.rapl.length > 0 || block.unreadable.length > 0 || (sampler.withGpu && !gpu.none);
    if (!measuresSomething) {
      // Nothing on this host to sample: stop the sampler and re-check later
      // (a GPU or driver can be added without redeploying the portal).
      const id = sampler.id;
      sampler.id = null;
      sampler.nextAttemptMs = Date.now() + RECHECK_MS;
      await removeContainer(id);
    }
  }

  async function tick() {
    if (stopping || ticking) return;
    ticking = true;
    try {
      try {
        await collect();
      } catch (err) {
        announce('collect', 'reading failed: ' + err.message);
      }
      const now = Date.now();
      if (state.lastTickMs === null) {
        // First tick after install: seed only, no energy yet.
        state.lastTickMs = now;
        persistState();
        return;
      }
      const dt = Math.min(Math.max((now - state.lastTickMs) / 1000, DT_CLAMP_S[0]), DT_CLAMP_S[1]);
      state.lastTickMs = now;
      const cpuW = currentCpuW();
      const gpuW = currentGpuW();
      // CPU energy comes from the counter deltas (applyRaplReading); GPU and
      // baseline are integrated over the tick.
      state.lifetimeJ += (gpuW + baselineW) * dt;
      samples.push({
        t: now,
        total: round1(cpuW + gpuW + baselineW),
        cpu: round1(cpuW),
        gpu: round1(gpuW),
        base: round1(baselineW),
      });
      while (samples.length > WINDOW_SAMPLES) samples.shift();
      persistState();
    } finally {
      ticking = false;
    }
  }

  function freshZones() {
    return [...cpu.zones.values()].filter((z) => fresh(z.t));
  }

  function currentCpuW() {
    return freshZones().reduce((sum, z) => sum + (z.w || 0), 0);
  }

  function freshGpus() {
    return fresh(gpu.t) ? gpu.devices : [];
  }

  function currentGpuW() {
    return freshGpus().reduce((sum, d) => sum + d.watts, 0);
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function cpuNote() {
    if (cpu.unreadable) return 'power counter not readable';
    if (cpu.none) return CPU_NONE_NOTE;
    if (sampler.lastError) return 'unavailable: ' + sampler.lastError;
    return 'detecting…';
  }

  function gpuNote() {
    if (!samplerEnabled) return 'GPU measurement is turned off';
    if (gpu.error) return gpu.error;
    if (gpu.none) return GPU_NONE_NOTE;
    if (sampler.lastError) return 'unavailable: ' + sampler.lastError;
    return 'detecting…';
  }

  function snapshot() {
    const sources = [];
    const zones = freshZones();
    if (zones.length) {
      for (const z of zones) {
        sources.push({
          kind: 'rapl',
          id: z.id,
          name: 'CPU (' + z.name + ')',
          w: z.w === null ? null : round1(z.w),
          note: z.w === null ? 'measuring…' : null,
          energyJSinceBoot: z.energyJSinceBoot,
        });
      }
    } else {
      sources.push({ kind: 'cpu', id: 'cpu', name: 'CPU', w: null, note: cpuNote() });
    }
    const gpus = freshGpus();
    if (gpus.length) {
      for (const d of gpus) sources.push({ kind: 'gpu', id: d.index, name: d.name, w: round1(d.watts), note: null });
    } else {
      sources.push({ kind: 'gpu', id: 'gpu', name: 'GPU', w: null, note: gpuNote() });
    }
    sources.push({ kind: 'baseline', id: 'baseline', name: 'Baseline (board, RAM, fans — estimate)', w: baselineW, note: null });

    const last = samples[samples.length - 1];
    const hours = Math.max(0, (Date.now() - state.installedAtMs) / 3600000);
    return {
      uptimeS: uptime(),
      baselineW,
      totalW: round1(last ? last.total : baselineW),
      cpuAvailable: zones.some((z) => z.w !== null),
      gpuAvailable: gpus.length > 0,
      sources,
      lifetime: {
        j: state.lifetimeJ,
        kwh: state.lifetimeJ / 3.6e6,
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
      log('power monitor: started (baseline ' + baselineW + ' W' +
        (samplerEnabled ? '' : ', host sampler off') + ')');
      tick().catch((err) => log('power monitor: tick failed: ' + err.message));
      tickTimer = setInterval(() => {
        tick().catch((err) => log('power monitor: tick failed: ' + err.message));
      }, tickMs);
    },
    async stop() {
      stopping = true;
      if (tickTimer) clearInterval(tickTimer);
      persistState();
      if (sampler.id) {
        const id = sampler.id;
        sampler.id = null;
        await removeContainer(id);
      }
    },
    setBaseline(watts) {
      baselineW = Math.min(Math.max(watts, 0), 1000);
    },
    snapshot,
  };
}

module.exports = { createPowerMonitor, parseSamplerBlocks, SAMPLER_SCRIPT };
