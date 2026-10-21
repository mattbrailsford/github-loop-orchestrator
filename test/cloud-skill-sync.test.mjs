import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/cloud-skill-sync.sh', import.meta.url));

function put(root, path, text = 'x') {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function sync(...sources) {
  const home = mkdtempSync(join(tmpdir(), 'loop-home-'));
  execFileSync('bash', [SCRIPT, ...sources], { env: { ...process.env, LOOP_HOME: home } });
  return {
    home,
    has: (path) => existsSync(join(home, path)),
    log: readFileSync(join(home, 'loop-setup.log'), 'utf8'),
    manifest: readFileSync(join(home, 'loop-env-manifest.md'), 'utf8'),
  };
}

function pluginRepo() {
  const root = mkdtempSync(join(tmpdir(), 'loop-src-'));
  put(root, 'plugins/kit/skills/issue-triage/SKILL.md');
  put(root, 'plugins/kit/skills/issue-triage/references/notes.md');
  put(root, 'plugins/kit/agents/issue-triager.md');
  put(root, 'skills/top-level/SKILL.md');
  put(root, 'agents/top-agent.md');
  put(root, '.claude/skills/repo-only/SKILL.md');
  put(root, 'plugins/kit/evals/case/prompt.md');
  return root;
}

test('copies plugin and top-level skills and agents, with their files', () => {
  const r = sync(pluginRepo());
  assert.ok(r.has('.claude/skills/issue-triage/SKILL.md'));
  assert.ok(r.has('.claude/skills/issue-triage/references/notes.md'));
  assert.ok(r.has('.claude/skills/top-level/SKILL.md'));
  assert.ok(r.has('.claude/agents/issue-triager.md'));
  assert.ok(r.has('.claude/agents/top-agent.md'));
});

test("never copies a repo's own .claude tools or its evals", () => {
  const r = sync(pluginRepo());
  assert.equal(r.has('.claude/skills/repo-only'), false);
  assert.equal(r.has('.claude/skills/case'), false);
});

test('writes a manifest of what was installed', () => {
  const r = sync(pluginRepo());
  assert.match(r.manifest, /\| skill \| `issue-triage` \|/);
  assert.match(r.manifest, /\| agent \| `issue-triager` \|/);
  assert.match(r.manifest, /without a plugin prefix/);
});

test('warns about hooks, which copied skills do not register', () => {
  const root = pluginRepo();
  put(root, 'plugins/kit/hooks/hooks.json', '{}');
  assert.match(sync(root).log, /has hooks \(kit\)/);
});

test('warns when a skill depends on CLAUDE_PLUGIN_ROOT', () => {
  const root = pluginRepo();
  put(root, 'plugins/kit/skills/needs-root/SKILL.md', 'run ${CLAUDE_PLUGIN_ROOT}/x.sh');
  assert.match(sync(root).log, /"needs-root" uses CLAUDE_PLUGIN_ROOT/);
});

test('a later source with the same skill name wins, with a warning', () => {
  const first = pluginRepo();
  const second = mkdtempSync(join(tmpdir(), 'loop-src-'));
  put(second, 'skills/issue-triage/SKILL.md', 'second');
  const r = sync(first, second);
  assert.equal(readFileSync(join(r.home, '.claude/skills/issue-triage/SKILL.md'), 'utf8'), 'second');
  assert.match(r.log, /"issue-triage" from .* replaces one/);
});

test('a source that cannot be fetched is logged, and the build still succeeds', () => {
  const r = sync(join(tmpdir(), 'does-not-exist-xyz'), pluginRepo());
  assert.match(r.log, /FAILED: could not fetch/);
  assert.ok(r.has('.claude/skills/issue-triage/SKILL.md'));
});

test('a source with nothing in it is flagged', () => {
  const empty = mkdtempSync(join(tmpdir(), 'loop-src-'));
  assert.match(sync(empty).log, /has no skills or agents/);
});
