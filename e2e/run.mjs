#!/usr/bin/env node
// Usage: node e2e/run.mjs --repo owner/name [--only reply,chain] [--slow]
// Runs the end-to-end scenarios against a sandbox repo set up as e2e/README.md says. It switches
// the repo's LOOP_MODE variable to stub for the run, so no real routine starts, and puts it back
// after. Each scenario opens its own issue or PR and closes it when done.
// Needs a token that can write to the sandbox: GH_TOKEN, or the gh CLI's login.
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    only: { type: 'string', default: '' },
    slow: { type: 'boolean', default: false },
  },
});
if (!args.repo) {
  console.error('usage: node e2e/run.mjs --repo owner/name [--only a,b] [--slow]');
  process.exit(2);
}
const REPO = args.repo;
const BOT = 'github-actions[bot]';
const token = process.env.GH_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok && !(method === 'GET' && res.status === 404)) throw new Error(`${method} ${path}: HTTP ${res.status} ${text}`);
  return res.ok && text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, check, timeoutMs = 240_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5000);
  }
}

const reactions = async (path) => ((await gh('GET', `${path}/reactions?per_page=100`)) ?? []).filter((r) => r.user.login === BOT).map((r) => r.content);
const commentReactions = (id) => reactions(`/repos/${REPO}/issues/comments/${id}`);
const labels = async (n) => (await gh('GET', `/repos/${REPO}/issues/${n}`)).labels.map((l) => l.name);
const botComments = async (n) => ((await gh('GET', `/repos/${REPO}/issues/${n}/comments?per_page=100`)) ?? []).filter((c) => c.user.login === BOT).map((c) => c.body);
const comment = async (n, body) => String((await gh('POST', `/repos/${REPO}/issues/${n}/comments`, { body })).id);
const openIssue = async (title, body = '') => (await gh('POST', `/repos/${REPO}/issues`, { title: `e2e: ${title}`, body })).number;
const close = (n) => gh('PATCH', `/repos/${REPO}/issues/${n}`, { state: 'closed' });
const startedOrFailed = (id) => waitFor(`a 🚀 or 😕 on comment ${id}`, async () => {
  const r = await commentReactions(id);
  return r.includes('rocket') || r.includes('confused') ? r : null;
});

// Every run of the loop workflow since a time has finished, and at least one started.
async function settled(sinceMs) {
  await sleep(15000);
  await waitFor('the loop workflow to finish', async () => {
    const runs = (await gh('GET', `/repos/${REPO}/actions/runs?per_page=30`)).workflow_runs.filter((r) => Date.parse(r.created_at) >= sinceMs - 2000);
    return runs.length > 0 && runs.every((r) => r.status === 'completed');
  });
}

function expect(ok, message) {
  if (!ok) throw new Error(message);
}

async function noClaim(n) {
  await waitFor('the claim to come off', async () => !(await labels(n)).includes('loop/working'));
}

const scenarios = {
  async reply() {
    const n = await openIssue('a reply and a status comment');
    const id = await comment(n, '🤖 say hi');
    expect((await startedOrFailed(id)).includes('rocket'), 'the comment got no 🚀');
    await noClaim(n);
    const bodies = await botComments(n);
    expect(bodies.some((b) => b.includes(`<!-- loop:reply:say:${id} -->`)), 'no reply for the comment');
    expect(bodies.filter((b) => b.includes('<!-- loop:status -->')).length === 1, 'not exactly one status comment');
    return n;
  },

  async queue() {
    const n = await openIssue('two requests in quick succession');
    const first = await comment(n, '🤖 first: say hi');
    const second = await comment(n, '🤖 second: say bye');
    for (const id of [first, second]) expect((await startedOrFailed(id)).includes('rocket'), `comment ${id} got no 🚀`);
    await noClaim(n);
    const bodies = await botComments(n);
    expect(bodies.filter((b) => b.includes('<!-- loop:reply:say:')).length === 2, 'not two replies');
    expect(bodies.filter((b) => b.includes('<!-- loop:status -->')).length === 1, 'not exactly one status comment');
    return n;
  },

  async chain() {
    const n = await openIssue('an edge from one route to the next');
    const id = await comment(n, '🤖 chain please');
    expect((await startedOrFailed(id)).includes('rocket'), 'the comment got no 🚀');
    await waitFor('the second step', async () => (await botComments(n)).some((b) => b.includes('route "after" (hop 1)')));
    await noClaim(n);
    return n;
  },

  async refuse() {
    const n = await openIssue('a routine that fails to start', 'stub: refuse');
    const id = await comment(n, '🤖 say hi');
    expect((await startedOrFailed(id)).includes('confused'), 'the comment got no 😕');
    await settled(Date.now() - 60000);
    expect(!(await labels(n)).includes('loop/working'), 'the claim was left on');
    expect((await botComments(n)).length === 0, 'something was posted');
    return n;
  },

  async limit() {
    const n = await openIssue('the run limit');
    for (let i = 1; i <= 3; i++) {
      const id = await comment(n, `🤖 say ${i}`);
      expect((await startedOrFailed(id)).includes('rocket'), `run ${i} got no 🚀`);
      await noClaim(n);
    }
    const id = await comment(n, '🤖 say 4');
    expect((await startedOrFailed(id)).includes('confused'), 'the fourth run was not refused');
    expect((await labels(n)).includes('loop/limit'), 'the limit label is not on');
    return n;
  },

  async checks() {
    const main = await gh('GET', `/repos/${REPO}/git/ref/heads/main`);
    const branch = `e2e-checks-${Date.now()}`;
    await gh('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${branch}`, sha: main.object.sha });
    const file = await gh('PUT', `/repos/${REPO}/contents/e2e-${branch}.txt`, {
      message: 'e2e: a change for the checks scenario',
      content: Buffer.from('e2e\n').toString('base64'),
      branch,
    });
    const sha = file.commit.sha;
    const pr = (await gh('POST', `/repos/${REPO}/pulls`, { title: 'e2e: checks', head: branch, base: 'main', body: '' })).number;
    try {
      await gh('POST', `/repos/${REPO}/statuses/${sha}`, { state: 'failure', context: 'e2e' });
      const since = Date.now();
      const early = await comment(pr, '🤖 ready');
      await settled(since);
      expect((await commentReactions(early)).length === 0, 'a run was considered while checks were failing');

      await gh('POST', `/repos/${REPO}/statuses/${sha}`, { state: 'success', context: 'e2e' });
      const id = await comment(pr, '🤖 ready');
      expect((await startedOrFailed(id)).includes('rocket'), 'no run once checks passed');
      await waitFor('the reply', async () => (await botComments(pr)).some((b) => b.includes(`<!-- loop:reply:ready:${id} -->`)));
      return pr;
    } finally {
      await gh('PATCH', `/repos/${REPO}/pulls/${pr}`, { state: 'closed' });
      await gh('DELETE', `/repos/${REPO}/git/refs/heads/${branch}`);
    }
  },

  async shadow() {
    await setMode('shadow');
    try {
      const n = await openIssue('shadow mode writes nothing');
      const since = Date.now();
      const id = await comment(n, '🤖 say hi');
      await settled(since);
      expect((await commentReactions(id)).length === 0, 'a reaction was added');
      expect((await labels(n)).length === 0, 'a label was added');
      expect((await botComments(n)).length === 0, 'something was posted');
      return n;
    } finally {
      await setMode('stub');
    }
  },

  // Slow: waits for the claim to go stale (5 minutes in the sandbox config), then ticks.
  async sweep() {
    const n = await openIssue('a run that dies holding the claim', 'stub: silent');
    const id = await comment(n, '🤖 say hi');
    expect((await startedOrFailed(id)).includes('rocket'), 'the comment got no 🚀');
    expect((await labels(n)).includes('loop/working'), 'the silent run did not keep the claim');
    await sleep(5.5 * 60_000);
    await gh('POST', `/repos/${REPO}/dispatches`, { event_type: 'loop-tick' });
    await waitFor('the sweep to clear the claim', async () => !(await labels(n)).includes('loop/working'), 180_000);
    return n;
  },
};

const SLOW = new Set(['sweep']);

let previousMode;
async function setMode(value) {
  const path = `/repos/${REPO}/actions/variables/LOOP_MODE`;
  if (value === null) return gh('DELETE', path);
  if (await gh('GET', path)) return gh('PATCH', path, { name: 'LOOP_MODE', value });
  return gh('POST', `/repos/${REPO}/actions/variables`, { name: 'LOOP_MODE', value });
}

const names = args.only ? args.only.split(',') : Object.keys(scenarios).filter((s) => args.slow || !SLOW.has(s));
for (const name of names) if (!scenarios[name]) throw new Error(`no scenario "${name}"`);

previousMode = (await gh('GET', `/repos/${REPO}/actions/variables/LOOP_MODE`))?.value ?? null;
await setMode('stub');
let failed = 0;
try {
  for (const name of names) {
    const started = Date.now();
    try {
      const n = await scenarios[name]();
      if (n) await close(n).catch(() => {});
      console.log(`PASS ${name} (#${n}, ${Math.round((Date.now() - started) / 1000)}s)`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}: ${err.message}`);
    }
  }
} finally {
  await setMode(previousMode);
}
console.log(`${names.length - failed}/${names.length} passed`);
process.exit(failed ? 1 : 0);
