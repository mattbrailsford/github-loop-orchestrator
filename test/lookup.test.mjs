import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { githubLookup } from '../src/github.mjs';

// A fake GitHub API: each path (without the query) answers with its fixed body, or a 404.
async function api(routes) {
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const body = routes[path + query] ?? routes[path];
    res.statusCode = body === undefined ? 404 : 200;
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const R = '/repos/acme/code';
const run = (id, suite, status, conclusion = null) => ({ id, status, conclusion, check_suite: { id: suite } });

async function checksWith({ runs = [], statuses = [], own = null }) {
  const routes = {
    [`${R}/pulls/4`]: { head: { sha: 'abc' } },
    [`${R}/commits/abc/check-runs`]: { check_runs: runs },
    [`${R}/commits/abc/status`]: { statuses },
  };
  if (own) {
    routes[`${R}/actions/runs/99`] = { check_suite_id: own.suite, workflow_id: 5 };
    routes[`${R}/actions/workflows/5/runs`] = { workflow_runs: own.others.map((s) => ({ check_suite_id: s })) };
  }
  const s = await api(routes);
  try {
    return await githubLookup({ token: 't', apiUrl: s.url, runRepo: 'acme/code', runId: own ? '99' : '' }).checks('acme/code', 4);
  } finally {
    s.close();
  }
}

test('checks: all passing is passed; skipped and neutral count as passing', async () => {
  assert.equal(await checksWith({ runs: [run(1, 10, 'completed', 'success'), run(2, 10, 'completed', 'skipped')], statuses: [{ state: 'success' }] }), 'passed');
});

test('checks: any failure is failed, even while others run', async () => {
  assert.equal(await checksWith({ runs: [run(1, 10, 'in_progress'), run(2, 11, 'completed', 'failure')] }), 'failed');
  assert.equal(await checksWith({ runs: [run(1, 10, 'completed', 'success')], statuses: [{ state: 'error' }] }), 'failed');
});

test('checks: anything still running, and nothing failed, is pending', async () => {
  assert.equal(await checksWith({ runs: [run(1, 10, 'queued')], statuses: [{ state: 'success' }] }), 'pending');
  assert.equal(await checksWith({ statuses: [{ state: 'pending' }] }), 'pending');
});

test('checks: none at all is none', async () => {
  assert.equal(await checksWith({}), 'none');
});

test("checks: the loop workflow's own runs don't count, or it would always be pending", async () => {
  const runs = [run(1, 10, 'completed', 'success'), run(2, 20, 'in_progress'), run(3, 21, 'queued')];
  assert.equal(await checksWith({ runs, own: { suite: 20, others: [21] } }), 'passed');
});

test("checks: a PR that can't be read is null", async () => {
  const s = await api({});
  try {
    assert.equal(await githubLookup({ token: 't', apiUrl: s.url }).checks('acme/code', 4), null);
  } finally {
    s.close();
  }
});

test('runsStarted counts only the workflow’s 🚀, on the body and comments, after a time', async () => {
  const mine = (at) => ({ user: { login: 'github-actions[bot]' }, content: 'rocket', created_at: at });
  const theirs = { user: { login: 'matt' }, content: 'rocket', created_at: '2026-10-21T16:05:00Z' };
  const s = await api({
    [`${R}/issues/4/reactions`]: [mine('2026-10-21T16:00:00Z'), theirs],
    [`${R}/issues/4/comments`]: [
      { id: 1, reactions: { rocket: 2 } },
      { id: 2, reactions: { rocket: 0 } },
    ],
    [`${R}/issues/comments/1/reactions`]: [mine('2026-10-21T16:10:00Z'), theirs],
  });
  try {
    const lookup = githubLookup({ token: 't', apiUrl: s.url });
    assert.equal(await lookup.runsStarted('acme/code', 4), 2);
    assert.equal(await lookup.runsStarted('acme/code', 4, Date.parse('2026-10-21T16:01:00Z')), 1);
  } finally {
    s.close();
  }
});
