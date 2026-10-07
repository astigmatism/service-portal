#!/usr/bin/env node
'use strict';
/*
 * GPU probe path of the power monitor, against a fake docker API. A GPU host
 * is not needed: the fake records the create request and returns what the
 * real daemon returns, so the request shape (all GPUs) and the log handling
 * (text, not JSON) are both checked.
 *
 *   node test/power-monitor.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPowerMonitor } = require('../power-monitor');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'power-monitor-test-'));
  const calls = [];
  let created = null;
  const dockerJson = async (method, pathname, body) => {
    calls.push({ method, pathname });
    if (method === 'GET' && pathname === '/containers/portal/json') return { Config: { Image: 'portal:test' } };
    if (method === 'POST' && pathname === '/containers/create') { created = body; return { Id: 'probe1' }; }
    if (method === 'POST' && pathname === '/containers/probe1/start') return {};
    if (method === 'GET' && pathname === '/containers/probe1/json') return { State: { Status: 'exited', ExitCode: 0 } };
    if (method === 'DELETE') return {};
    throw new Error('unexpected docker call ' + method + ' ' + pathname);
  };
  const logPaths = [];
  const dockerLogs = async (pathname) => {
    logPaths.push(pathname);
    return '0, NVIDIA GeForce RTX 5080, 247.68\n1, NVIDIA GeForce RTX 4090, 31.5\n';
  };

  const monitor = createPowerMonitor({
    stateFile: path.join(dir, 'power-state.json'),
    baselineW: 50,
    selfName: 'portal',
    dockerJson,
    dockerLogs,
  });
  monitor.start();
  for (let i = 0; i < 50 && !monitor.snapshot().gpuAvailable; i++) await sleep(50);
  const snap = monitor.snapshot();
  monitor.stop();

  assert.ok(created, 'the probe container was created');
  assert.strictEqual(created.Image, 'portal:test', 'the probe runs in the portal\'s own image');
  assert.deepStrictEqual(created.Entrypoint, ['nvidia-smi']);
  assert.deepStrictEqual(created.HostConfig.DeviceRequests,
    [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }],
    'all GPUs are requested (Count -1, as `--gpus all`); Count 0 requests none');
  assert.strictEqual(created.Labels['io.service-portal.maintenance'], 'true',
    'the probe is hidden from the service list');
  assert.deepStrictEqual(logPaths, ['/containers/probe1/logs?stdout=1&stderr=0'],
    'probe output is read as log text');
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.pathname.startsWith('/containers/probe1')),
    'the probe container is removed');

  assert.strictEqual(snap.gpuAvailable, true, 'GPU reported available: ' + snap.gpuProbeError);
  const gpus = snap.sources.filter((s) => s.kind === 'gpu');
  assert.deepStrictEqual(gpus.map((g) => [g.id, g.name, g.w]),
    [[0, 'NVIDIA GeForce RTX 5080', 247.68], [1, 'NVIDIA GeForce RTX 4090', 31.5]]);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('power-monitor GPU probe: ok');
})().catch((err) => { console.error(err); process.exit(1); });
