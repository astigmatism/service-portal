#!/usr/bin/env node
'use strict';
/*
 * Power monitor host sampler, against a fake docker API (no GPU host or RAPL
 * counter needed). Covers:
 *   - a GPU + RAPL host: CPU watts from two counter readings, GPU watts, and
 *     the hardened sampler container spec (root, no network, read-only,
 *     capabilities dropped, host /sys read-only, all GPUs requested);
 *   - a host with neither (a VM): the GPU request is refused, the sampler
 *     reports nothing, so it is removed and CPU/GPU rows carry their notes;
 *   - every host always reports CPU, GPU and baseline rows.
 *
 *   node test/power-monitor.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPowerMonitor, parseSamplerBlocks, SAMPLER_SCRIPT } = require('../power-monitor');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeDocker({ gpuRefused, blocks }) {
  const calls = [];
  const specs = [];
  let clock = 1000; // host uptime the fake sampler stamps
  let served = 0;
  const live = new Set();
  const dockerJson = async (method, pathname, body) => {
    calls.push({ method, pathname });
    if (method === 'GET' && pathname === '/containers/portal/json') return { Config: { Image: 'portal:test' } };
    if (method === 'GET' && pathname.startsWith('/containers/json?all=1&filters=')) return [];
    if (method === 'POST' && pathname === '/containers/create') {
      specs.push(body);
      if (gpuRefused && body.HostConfig.DeviceRequests.length) {
        const err = new Error('could not select device driver "nvidia" with capabilities: [[gpu]]');
        err.statusCode = 400;
        throw err;
      }
      const id = 'sampler' + specs.length;
      live.add(id);
      return { Id: id };
    }
    if (method === 'POST' && /^\/containers\/sampler\d+\/start$/.test(pathname)) return {};
    if (method === 'DELETE') { live.delete(pathname.split('/')[2].split('?')[0]); return {}; }
    throw new Error('unexpected docker call ' + method + ' ' + pathname);
  };
  const dockerLogs = async (pathname) => {
    const id = pathname.split('/')[2];
    if (!live.has(id)) { const err = new Error('no such container'); err.statusCode = 404; throw err; }
    // Each read reveals one more block, stamped 5 s after the previous one.
    const shown = blocks.slice(0, Math.min(blocks.length, ++served));
    clock = 1000 + Math.max(0, shown.length - 1) * 5;
    return shown.map((b, i) => 'S ' + (1000 + i * 5).toFixed(2) + '\n' + b + 'E\n').join('');
  };
  return { calls, specs, live, dockerJson, dockerLogs, uptime: () => clock + 0.5 };
}

function monitorFor(fake, dir, extra) {
  return createPowerMonitor({
    stateFile: path.join(dir, 'power-state.json'),
    baselineW: 50,
    selfName: 'portal',
    tickMs: 60,
    dockerJson: fake.dockerJson,
    dockerLogs: fake.dockerLogs,
    uptime: fake.uptime,
    ...extra,
  });
}

async function waitFor(fn, what) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await sleep(30);
  }
  throw new Error('timed out waiting for ' + what);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'power-monitor-test-'));
  try {
    /* ---- block parsing (multiplex residue, partial trailing block) ---- */
    const parsed = parseSamplerBlocks(
      '\u0001\u0000S 10.00\nR intel-rapl:0 5000000 262143328850 package-0\nG 0, NVIDIA GeForce RTX 5080, 247.68\nE\n' +
      'S 15.00\nR intel-rapl:0 6000000 262143328850 package-0\n'); // still being written
    assert.strictEqual(parsed.length, 1, 'only complete blocks count');
    assert.deepStrictEqual(parsed[0].rapl, [{ id: 'intel-rapl:0', uj: 5000000, range: 262143328850, name: 'package-0' }]);
    assert.deepStrictEqual(parsed[0].gpus, [{ index: 0, name: 'NVIDIA GeForce RTX 5080', watts: 247.68 }]);
    assert.ok(/intel-rapl:\*:\*\) continue/.test(SAMPLER_SCRIPT), 'sampler reads package zones only');

    /* ---- GPU + RAPL host ---- */
    const gpuHost = fakeDocker({
      blocks: [
        'R intel-rapl:0 100000000 262143328850 package-0\nG 0, NVIDIA GeForce RTX 5080, 247.68\n',
        'R intel-rapl:0 400000000 262143328850 package-0\nG 0, NVIDIA GeForce RTX 5080, 250.00\n', // +300 J in 5 s
        'R intel-rapl:0 700000000 262143328850 package-0\nG 0, NVIDIA GeForce RTX 5080, 250.00\n',
      ],
    });
    const m1 = monitorFor(gpuHost, dir);
    m1.start();
    await waitFor(() => m1.snapshot().cpuAvailable && m1.snapshot().gpuAvailable, 'CPU and GPU readings');
    const s1 = m1.snapshot();
    await m1.stop();

    const spec = gpuHost.specs[0];
    assert.strictEqual(spec.Image, 'portal:test', 'the sampler runs in the portal\'s own image');
    assert.strictEqual(spec.User, '0:0', 'root inside the sampler (the RAPL counter is root-only)');
    assert.deepStrictEqual(spec.Entrypoint.slice(0, 2), ['sh', '-c']);
    assert.ok(spec.Env.includes('GPU=1'));
    assert.strictEqual(spec.Labels['io.service-portal.maintenance'], 'true', 'hidden from the service list');
    assert.strictEqual(spec.Labels['io.service-portal.power-sampler'], 'portal');
    assert.strictEqual(spec.NetworkDisabled, true);
    const hc = spec.HostConfig;
    assert.deepStrictEqual(hc.Binds, ['/sys:/host/sys:ro'], 'only the host /sys, read-only');
    assert.strictEqual(hc.NetworkMode, 'none');
    assert.strictEqual(hc.ReadonlyRootfs, true);
    assert.deepStrictEqual(hc.CapDrop, ['ALL']);
    assert.deepStrictEqual(hc.SecurityOpt, ['no-new-privileges:true']);
    assert.strictEqual(hc.AutoRemove, true);
    assert.deepStrictEqual(hc.DeviceRequests, [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }],
      'all GPUs (Count -1, as `--gpus all`)');
    assert.strictEqual(gpuHost.specs.length, 1, 'one long-lived sampler, not a container per tick');

    assert.deepStrictEqual(s1.sources.map((s) => s.kind), ['rapl', 'gpu', 'baseline']);
    assert.strictEqual(s1.sources[0].name, 'CPU (package-0)');
    assert.strictEqual(s1.sources[0].w, 60, '300 J over 5 s = 60 W');
    assert.strictEqual(s1.sources[1].name, 'NVIDIA GeForce RTX 5080');
    assert.strictEqual(s1.sources[1].w, 250);
    assert.strictEqual(s1.sources[2].w, 50);
    assert.ok(gpuHost.calls.some((c) => c.method === 'DELETE' && c.pathname.startsWith('/containers/sampler1')),
      'the sampler is removed when the monitor stops');

    /* ---- host with no RAPL and no NVIDIA toolkit (a VM) ---- */
    fs.rmSync(path.join(dir, 'power-state.json'), { force: true });
    const vm = fakeDocker({ gpuRefused: true, blocks: [''] });
    const m2 = monitorFor(vm, dir);
    m2.start();
    await waitFor(() => vm.calls.some((c) => c.method === 'DELETE'), 'the idle sampler to be removed');
    const s2 = m2.snapshot();
    await m2.stop();
    assert.strictEqual(vm.specs.length, 2, 'GPU request refused, then a CPU-only sampler');
    assert.ok(vm.specs[1].Env.includes('GPU=0'));
    assert.deepStrictEqual(vm.specs[1].HostConfig.DeviceRequests, []);
    assert.deepStrictEqual(s2.sources.map((s) => [s.kind, s.name, s.w, s.note]), [
      ['cpu', 'CPU', null, 'not measurable on this host'],
      ['gpu', 'GPU', null, 'none detected on this host'],
      ['baseline', 'Baseline (board, RAM, fans — estimate)', 50, null],
    ], 'all three rows, with notes for what the host cannot measure');
    assert.strictEqual(s2.cpuAvailable, false);
    assert.strictEqual(s2.gpuAvailable, false);
    assert.strictEqual(vm.live.size, 0, 'no sampler left running on a host with nothing to measure');

    /* ---- sampler off: still three rows ---- */
    const m3 = monitorFor(fakeDocker({ blocks: [] }), dir, { sampler: false });
    m3.start();
    await sleep(100);
    const s3 = m3.snapshot();
    await m3.stop();
    assert.deepStrictEqual(s3.sources.map((s) => s.kind), ['cpu', 'gpu', 'baseline']);

    console.log('power-monitor host sampler: ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
