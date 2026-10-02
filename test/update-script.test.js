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
  *'cat-file -e '*) [ "\${FAKE_KNOWN:-yes}" = yes ] ;;
  *'^{commit}'*) printf '%s\\n' "\${SERVICE_PORTAL_DEPLOYED_REVISION:-}" ;;
  *'merge-base --is-ancestor 3333333333333333333333333333333333333333 2222222222222222222222222222222222222222'*) exit 0 ;;
  *'rev-list --count '*) echo 2 ;;
  *'log -n 10 --format=service-portal-check-commit: %H %cI %s '*)
    echo 'service-portal-check-commit: 2222222222222222222222222222222222222222 2026-10-01T12:00:00+00:00 Second change'
    echo 'service-portal-check-commit: 4444444444444444444444444444444444444444 2026-09-30T12:00:00+00:00 First change' ;;
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
[ "$*" != 'compose build' ] || printf '%s\\n' "\${SERVICE_PORTAL_SOURCE_REVISION:-}" >"$FAKE_DOCKER_LOG.rev"
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

function run(root, { dirty = '', history = 'behind', args = [], deployed, known = 'yes' } = {}) {
  const gitLog = path.join(root, 'git.log');
  const dockerLog = path.join(root, 'docker.log');
  fs.writeFileSync(gitLog, '');
  fs.writeFileSync(dockerLog, '');
  const env = {
    ...process.env,
    PATH: path.join(root, 'fake-bin') + path.delimiter + process.env.PATH,
    FAKE_GIT_LOG: gitLog,
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_DIRTY: dirty,
    FAKE_HISTORY: history,
    FAKE_KNOWN: known
  };
  delete env.SERVICE_PORTAL_DEPLOYED_REVISION;
  delete env.SERVICE_PORTAL_SOURCE_REVISION;
  if (deployed !== undefined) env.SERVICE_PORTAL_DEPLOYED_REVISION = deployed;
  const result = child.spawnSync(path.join(root, 'update and restart'), args, {
    cwd: root,
    encoding: 'utf8',
    env
  });
  const revFile = dockerLog + '.rev';
  return {
    ...result,
    gitLog: fs.readFileSync(gitLog, 'utf8'),
    dockerLog: fs.readFileSync(dockerLog, 'utf8'),
    buildRevision: fs.existsSync(revFile) ? fs.readFileSync(revFile, 'utf8').trim() : null
  };
}

const ONE = '1'.repeat(40);
const TWO = '2'.repeat(40);
const THREE = '3'.repeat(40);

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
      assert.equal(result.buildRevision, TWO, 'the image records the deployed source revision');
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
      assert.equal(result.buildRevision, ONE);
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

test('update script check mode reports without changing the checkout or any container', async (t) => {
  const lockGone = (root) => assert.equal(fs.existsSync(path.join(root, '.git', 'service-portal-update.lock')), false);

  await t.test('a deployment behind origin/main reports the distance and the pending commits', () => {
    const root = fixture();
    try {
      const result = run(root, { args: ['check'], deployed: THREE });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(
        '^service-portal-check: status=available behind=2 deployed=' + THREE + ' target=' + TWO + '$', 'm'));
      assert.match(result.stdout, /^service-portal-check-commit: 2{40} 2026-10-01T12:00:00\+00:00 Second change$/m);
      assert.match(result.stdout, /^service-portal-check-commit: 4{40} .* First change$/m);
      assert.match(result.gitLog, /fetch --prune origin main/);
      assert.match(result.gitLog, new RegExp('rev-list --count ' + THREE + '\\.\\.' + TWO));
      assert.doesNotMatch(result.gitLog, /merge --ff-only/);
      assert.equal(result.dockerLog, '', 'a check needs no Docker at all');
      lockGone(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('a deployment at the update target is current', () => {
    const root = fixture();
    try {
      const result = run(root, { args: ['check'], deployed: TWO });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(
        '^service-portal-check: status=current behind=0 deployed=' + TWO + ' target=' + TWO + '$', 'm'));
      assert.doesNotMatch(result.stdout, /service-portal-check-commit/);
      assert.equal(result.dockerLog, '');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('without a recorded revision the checkout HEAD stands in, with a note', () => {
    const root = fixture();
    try {
      const result = run(root, { args: ['check'] });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^service-portal-check-note: The running image does not record its source revision/m);
      assert.match(result.stdout, new RegExp('status=available behind=2 deployed=' + ONE + ' target=' + TWO));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('a local-ahead checkout compares with the committed local HEAD', () => {
    const root = fixture();
    try {
      const result = run(root, { args: ['check'], history: 'ahead', deployed: ONE });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^service-portal-check-note: Local main is ahead of origin\/main/m);
      assert.match(result.stdout, new RegExp('status=current behind=0 deployed=' + ONE + ' target=' + ONE));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('a running revision missing from the checkout is available at an unknown distance', () => {
    const root = fixture();
    try {
      const result = run(root, { args: ['check'], deployed: THREE, known: 'no' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp('status=available behind=unknown deployed=unknown target=' + TWO));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('a dirty checkout fails the check before fetching', () => {
    const root = fixture();
    try {
      const result = run(root, { args: ['check'], dirty: ' M server.js', deployed: TWO });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /uncommitted changes/);
      assert.doesNotMatch(result.gitLog, /fetch/);
      assert.doesNotMatch(result.stdout, /service-portal-check:/);
      lockGone(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('divergent history fails the check', () => {
    const root = fixture();
    try {
      const result = run(root, { args: ['check'], history: 'diverged', deployed: ONE });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /divergent or rewritten/);
      assert.doesNotMatch(result.stdout, /service-portal-check:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('any other argument is refused before any work', () => {
    for (const args of [['stop'], ['check', 'extra'], ['']]) {
      const root = fixture();
      try {
        const result = run(root, { args });
        assert.equal(result.status, 2, JSON.stringify(args));
        assert.match(result.stderr, /usage/);
        assert.equal(result.gitLog, '');
        assert.equal(result.dockerLog, '');
        lockGone(root);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
