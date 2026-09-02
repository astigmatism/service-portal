#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const child = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-update-script-'));
  const bin = path.join(root, 'fake-bin');
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(ROOT, 'update and restart'), path.join(root, 'update and restart'));
  fs.chmodSync(path.join(root, 'update and restart'), 0o755);
  fs.writeFileSync(path.join(root, 'compose.yaml'), 'services: {}\n');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$FAKE_GIT_LOG"
case "$*" in
  *'symbolic-ref --quiet --short HEAD'*) echo main ;;
  *'config --get branch.main.remote'*) echo origin ;;
  *'config --get branch.main.merge'*) echo refs/heads/main ;;
  *'remote get-url origin'*) echo https://github.com/astigmatism/service-portal.git ;;
  *'status --porcelain'*) [ -z "\${FAKE_DIRTY:-}" ] || printf '%s\\n' "$FAKE_DIRTY" ;;
  *'rev-parse HEAD'*) echo 1111111111111111111111111111111111111111 ;;
  *'rev-parse FETCH_HEAD'*) echo 2222222222222222222222222222222222222222 ;;
  *'merge-base --is-ancestor 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222'*)
    [ "\${FAKE_HISTORY:-behind}" = behind ] ;;
  *'merge-base --is-ancestor 2222222222222222222222222222222222222222 1111111111111111111111111111111111111111'*)
    [ "\${FAKE_HISTORY:-behind}" = ahead ] ;;
  *'fetch --prune origin main'*) exit 0 ;;
  *'merge --ff-only'*) exit 0 ;;
  *) echo "unexpected fake git call: $*" >&2; exit 2 ;;
esac
`);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$*" in
  'compose version'|'compose config --quiet'|'compose build'|\
  'compose up -d --wait --wait-timeout 120'|'compose ps') exit 0 ;;
  *) echo "unexpected fake docker call: $*" >&2; exit 2 ;;
esac
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  return root;
}

function run(root, { dirty = '', history = 'behind' } = {}) {
  const gitLog = path.join(root, 'git.log');
  const dockerLog = path.join(root, 'docker.log');
  fs.writeFileSync(gitLog, '');
  fs.writeFileSync(dockerLog, '');
  const result = child.spawnSync(path.join(root, 'update and restart'), [], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: path.join(root, 'fake-bin') + path.delimiter + process.env.PATH,
      FAKE_GIT_LOG: gitLog,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_DIRTY: dirty,
      FAKE_HISTORY: history
    }
  });
  return {
    ...result,
    gitLog: fs.readFileSync(gitLog, 'utf8'),
    dockerLog: fs.readFileSync(dockerLog, 'utf8')
  };
}

test('update script fails closed before interruption and deploys in safe order', async (t) => {
  await t.test('a dirty checkout is rejected before fetch, build, or recreation', () => {
    const root = fixture();
    try {
      const result = run(root, { dirty: ' M server.js' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /uncommitted changes/);
      assert.doesNotMatch(result.gitLog, /fetch --prune/);
      assert.doesNotMatch(result.dockerLog, /compose (config|build|up|ps)/);
      assert.equal(fs.existsSync(path.join(root, '.git', 'service-portal-update.lock')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('a clean fast-forward validates and builds before Compose recreates', () => {
    const root = fixture();
    try {
      const result = run(root);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Update complete: 1111.* -> 2222/);
      assert.match(result.gitLog, /fetch --prune origin main/);
      assert.match(result.gitLog, /merge --ff-only 222222/);
      const commands = result.dockerLog.trim().split('\n');
      assert.deepEqual(commands, [
        'compose version',
        'compose config --quiet',
        'compose build',
        'compose up -d --wait --wait-timeout 120',
        'compose ps'
      ]);
      assert.equal(fs.existsSync(path.join(root, '.git', 'service-portal-update.lock')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('a clean local-ahead checkout deploys committed HEAD without resetting it', () => {
    const root = fixture();
    try {
      const result = run(root, { history: 'ahead' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Local main is ahead of origin\/main/);
      assert.match(result.stdout, /Update complete: 1111.* -> 1111/);
      assert.doesNotMatch(result.gitLog, /merge --ff-only/);
      assert.match(result.dockerLog, /compose up -d --wait --wait-timeout 120/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('divergent history is rejected before build or recreation', () => {
    const root = fixture();
    try {
      const result = run(root, { history: 'diverged' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /divergent or rewritten/);
      assert.doesNotMatch(result.gitLog, /merge --ff-only/);
      assert.equal(result.dockerLog.trim(), 'compose version');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
