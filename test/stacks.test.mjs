import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SETUP = join(ROOT, 'stacks/umbraco/setup.sh');
const RUN = join(ROOT, 'stacks/umbraco/run-umbraco.sh');
const SYNC = join(ROOT, 'scripts/cloud-skill-sync.sh');

// A fake dotnet that already has the 10.0 SDK, so setup.sh skips the real install.
function fakeDotnet(home) {
  const bin = join(home, '.dotnet');
  mkdirSync(bin, { recursive: true });
  const file = join(bin, 'dotnet');
  writeFileSync(
    file,
    '#!/usr/bin/env bash\ncase "$1" in --list-sdks) echo "10.0.102 [/x]";; --version) echo 10.0.102;; esac\n',
  );
  chmodSync(file, 0o755);
}

function setup(home, ...args) {
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  execFileSync('bash', [SETUP, ...args], { env: { ...process.env, LOOP_HOME: home, LOOP_BIN_DIR: binDir } });
  return readFileSync(join(home, 'loop-env-manifest.md'), 'utf8');
}

test('with the SDK present, setup links it, copies run-umbraco.sh, and reports ready', () => {
  const home = mkdtempSync(join(tmpdir(), 'loop-home-'));
  fakeDotnet(home);
  const manifest = setup(home, '--channel', '10.0');
  assert.match(manifest, /## Umbraco: ready/);
  assert.match(manifest, /10\.0\.102 \(channel 10\.0\)/);
  assert.match(manifest, /SQLite only/);
  assert.ok(existsSync(join(home, '.loop/run-umbraco.sh')));
  assert.ok(existsSync(join(home, 'bin/dotnet')));
});

test('setup adds to the manifest the skill sync wrote, instead of replacing it', () => {
  const home = mkdtempSync(join(tmpdir(), 'loop-home-'));
  fakeDotnet(home);
  execFileSync('bash', [SYNC, ROOT], { env: { ...process.env, LOOP_HOME: home } });
  const manifest = setup(home);
  assert.match(manifest, /# Loop environment/);
  assert.match(manifest, /## Umbraco/);
});

test('an unknown provider falls back to sqlite and says so', () => {
  const home = mkdtempSync(join(tmpdir(), 'loop-home-'));
  fakeDotnet(home);
  setup(home, '--provider', 'oracle');
  assert.match(readFileSync(join(home, 'loop-setup.log'), 'utf8'), /unknown provider "oracle"; using sqlite/);
});

test("the orchestrator's own skills install from its root, and its .claude folder doesn't", () => {
  const home = mkdtempSync(join(tmpdir(), 'loop-home-'));
  execFileSync('bash', [SYNC, ROOT], { env: { ...process.env, LOOP_HOME: home } });
  assert.ok(existsSync(join(home, '.claude/skills/loop-notify/SKILL.md')));
});

test('run-umbraco.sh needs a boot command', () => {
  const r = spawnSync('bash', [RUN], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--boot "<command>" is required/);
});

test('run-umbraco.sh rejects an unknown provider', () => {
  const r = spawnSync('bash', [RUN, '--boot', 'true', '--provider', 'oracle'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown --provider "oracle"/);
});
