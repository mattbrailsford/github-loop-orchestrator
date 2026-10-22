import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modeOf, runLimitOf, validateConfig } from '../src/config.mjs';
import { normalizeEvent } from '../src/event.mjs';
import { runCandidates, shadowFirer, shadowWriter } from '../src/fire.mjs';
import { matchEvent } from '../src/match.mjs';
import { parseRunBlock, stubPlan, stubRoutine } from '../src/stub.mjs';
import { HUB, T0, baseConfig, commentEvent, fakeLookup, world } from './helpers.mjs';

const min = (m) => T0 + m * 60000;

const run = (w, candidates, { config = baseConfig(), fireRoutine = w.fireRoutine, gh = w.gh } = {}) =>
  runCandidates({
    candidates,
    config,
    workflowRepo: HUB,
    hubRepo: HUB,
    lookup: w.lookup,
    gh,
    fireRoutine,
    log: (m) => w.state.log.push(m),
    now: min(1),
  });

const fireFor = (extra = {}) => ({
  type: 'fire',
  route: 'maintainer-asks',
  prompt: 'do it',
  item: { repo: HUB, number: 7 },
  claim: { repo: HUB, number: 7, label: 'loop/working', stale_after_minutes: 60 },
  edge: null,
  trigger: { type: 'comment', repo: HUB, id: '555' },
  ...extra,
});

const errorsFor = (extra) => validateConfig(baseConfig(extra));

// --- settings -----------------------------------------------------------------------------

test('mode is live, shadow, or stub, and the caller variable overrides the config', () => {
  assert.deepEqual(errorsFor({ mode: 'shadow' }), []);
  assert.ok(errorsFor({ mode: 'dry-run' }).some((e) => e.startsWith('mode:')));
  assert.equal(modeOf(baseConfig()), 'live');
  assert.equal(modeOf(baseConfig({ mode: 'shadow' })), 'shadow');
  assert.equal(modeOf(baseConfig({ mode: 'shadow' }), 'stub'), 'stub');
});

test('run_limit takes a number of runs and a label, which must not be the claim label', () => {
  assert.deepEqual(errorsFor({ run_limit: { runs: 10 } }), []);
  assert.deepEqual(runLimitOf(baseConfig({ run_limit: { runs: 10 } })), { runs: 10, label: 'loop/limit' });
  assert.equal(runLimitOf(baseConfig()), null);
  assert.ok(errorsFor({ run_limit: { runs: 0 } }).some((e) => e.includes('run_limit.runs')));
  assert.ok(errorsFor({ run_limit: 10 }).some((e) => e.startsWith('run_limit:')));
  assert.ok(errorsFor({ run_limit: { runs: 5, label: 'loop/working' } }).some((e) => e.includes('must differ')));
  assert.ok(errorsFor({ run_limit: { runs: 5, max: 1 } }).some((e) => e.includes('unknown key "max"')));
});

test('checks is passed, failed, or pending, and only on a pull request event or an edge', () => {
  const route = (when, checks = 'passed') => ({ name: 'r', when, if: { checks }, prompt: 'x', ...(when === 'edge' ? { allow_from: ['new-issue'] } : {}) });
  const routes = (r) => ({ routes: [baseConfig().routes[0], r] });
  assert.deepEqual(errorsFor(routes(route('pr_comment.created'))), []);
  assert.deepEqual(errorsFor(routes(route('edge'))), []);
  assert.ok(errorsFor(routes(route('issue_comment.created'))).some((e) => e.includes('if.checks: only works')));
  assert.ok(errorsFor(routes(route('pr_comment.created', 'green'))).some((e) => e.includes('if.checks: must be one of')));
});

// --- the checks condition -----------------------------------------------------------------

const checksConfig = () =>
  baseConfig({
    routes: [
      { name: 'merge', when: 'pr_comment.created', if: { addressed_with: ['🤖 merge'], actor: 'maintainer', checks: 'passed' }, prompt: 'Merge {number}.' },
    ],
  });
const prComment = (body) => commentEvent(body, { when: 'pr_comment.created', kind: 'pr' });
const checksLookup = (state) => ({ ...fakeLookup({ permissions: { maint: 'admin' } }), checks: async () => state });

test('a checks route matches only when the PR is in that state', async () => {
  const match = (state) => matchEvent({ config: checksConfig(), event: prComment('🤖 merge'), workflowRepo: HUB, hubRepo: HUB, lookup: checksLookup(state) });
  assert.equal((await match('passed')).route, 'merge');
  for (const state of ['failed', 'pending', 'none', null]) assert.equal((await match(state)).route, null, String(state));
  assert.equal((await match('passed')).fires[0].recheck.checks, 'passed');
});

test("an issue never matches a checks condition, and its checks aren't read", async () => {
  const calls = [];
  const lookup = { ...fakeLookup({ permissions: { maint: 'admin' } }), checks: async () => (calls.push(1), 'passed') };
  const config = baseConfig({
    routes: [{ name: 'go', when: 'edge', allow_from: ['x'], if: { checks: 'passed' }, prompt: 'x' }, { name: 'x', when: 'issues.opened', prompt: 'x' }],
  });
  lookup.issue = async () => ({ kind: 'issue', labels: [], state: 'open', author: 'r' });
  const edge = normalizeEvent('repository_dispatch', { action: 'loop-edge', client_payload: { route: 'go', from: 'x', number: 7, hop: 1 } }, HUB);
  assert.equal((await matchEvent({ config, event: edge, workflowRepo: HUB, hubRepo: HUB, lookup })).route, null);
  assert.equal(calls.length, 0);
});

test('checks are read again before firing, and a change since the event skips it', async () => {
  const w = world({ checks: 'failed' });
  await run(w, [fireFor({ recheck: { has_label: null, lacks_label: null, state: null, checks: 'passed' } })]);
  assert.equal(w.state.fired.length, 0);
  assert.match(w.state.log.join('\n'), /its checks are failed now, not passed; skipped/);
});

// --- the run limit ------------------------------------------------------------------------

const limited = (runs = 2) => baseConfig({ run_limit: { runs } });

test('under the limit, a run fires as usual', async () => {
  const w = world({ reactions: { c1: { rocket: 1 } } });
  w.state.startedAt.c1 = min(0);
  await run(w, [fireFor()], { config: limited(2) });
  assert.equal(w.state.fired.length, 1);
});

test('at the limit, the run is refused: 😕, and the limit label goes on for a person', async () => {
  const w = world({ reactions: { c1: { rocket: 1 }, c2: { rocket: 2 }, c555: { eyes: 3 } } });
  await run(w, [fireFor()], { config: limited(2) });
  assert.equal(w.state.fired.length, 0);
  assert.ok(w.state.labels.has('loop/limit'));
  assert.equal(w.state.labels.has('loop/working'), false, 'no claim was taken');
  assert.deepEqual(Object.keys(w.state.reactions.c555), ['confused'], 'the 👀 is swapped for 😕');
  assert.match(w.state.log.join('\n'), /2 runs already, the limit is 2/);
});

test('while the limit label is on, nothing runs', async () => {
  const w = world({ labels: ['loop/limit'] });
  await run(w, [fireFor()], { config: limited(5) });
  assert.equal(w.state.fired.length, 0);
  assert.ok(w.state.reactions.c555.confused);
});

test('taking the label off starts the count again from then', async () => {
  const w = world({ reactions: { c1: { rocket: 1 }, c2: { rocket: 2 } }, removedAt: { 'loop/limit': min(0.5) } });
  w.state.startedAt = { c1: min(0), c2: min(0.2) };
  await run(w, [fireFor()], { config: limited(2) });
  assert.equal(w.state.fired.length, 1);
});

test("edges don't count against the limit, and aren't stopped by it", async () => {
  const w = world({ labels: ['loop/working', 'loop/limit'], claimAt: min(0) });
  await run(w, [fireFor({ trigger: null, edge: { sentAt: min(0.5) } })], { config: limited(1) });
  assert.equal(w.state.fired.length, 1);
});

test("if the runs can't be counted, nothing fires", async () => {
  const w = world({ unreadable: ['runs'] });
  await run(w, [fireFor()], { config: limited(2) });
  assert.equal(w.state.fired.length, 0);
  assert.match(w.state.log.join('\n'), /couldn't count its runs/);
});

test('over the limit, a catch-up marks every waiting comment 😕, so none is left owed a run', async () => {
  const comment = (id, at) => ({ id, body: '@claude go', login: 'maint', isBot: false, createdAt: at });
  const w = world({
    claimAt: min(0),
    labels: ['loop/limit'],
    comments: [comment('901', min(1)), comment('902', min(2))],
    reactions: { c901: { eyes: 1 }, c902: { eyes: 2 } },
  });
  await run(w, [{ type: 'catch-up', item: { repo: HUB, number: 7 } }], { config: limited(2) });
  assert.equal(w.state.fired.length, 0);
  assert.ok(w.state.reactions.c901.confused && w.state.reactions.c902.confused);
});

// --- shadow mode --------------------------------------------------------------------------

test('shadow mode decides as usual, writes nothing, and fires nothing', async () => {
  const w = world();
  const log = (m) => w.state.log.push(m);
  const ok = await run(w, [fireFor({ prompt: 'secret request text' })], { gh: shadowWriter(log), fireRoutine: shadowFirer(log) });
  assert.equal(ok, true);
  assert.equal(w.state.labels.size, 0);
  assert.deepEqual(w.state.reactions, {});
  assert.equal(w.state.fired.length, 0);
  const text = w.state.log.join('\n');
  assert.match(text, /\[shadow\] would add "loop\/working" to #7/);
  assert.match(text, /\[shadow\] would fire the routine for "maintainer-asks"/);
  assert.doesNotMatch(text, /secret request text/, 'the prompt stays out of the log');
});

// --- stub mode ----------------------------------------------------------------------------

const stubConfig = () =>
  baseConfig({
    routes: [
      { name: 'chain', when: 'issue_comment.created', if: { addressed_with: ['🤖 chain'], actor: 'maintainer' }, prompt: 'Hand on with `/loop-edge after`.' },
      { name: 'say', when: 'issue_comment.created', if: { addressed_with: ['🤖'], actor: 'maintainer' }, prompt: 'Reply with /loop-comment, then update /loop-comment status.' },
      { name: 'after', when: 'edge', allow_from: ['chain'], prompt: 'Say the edge arrived.' },
    ],
  });

async function stubRun(w, body, { config = stubConfig(), id = '555' } = {}) {
  const lookup = { ...w.lookup, issue: async () => ({ kind: 'issue', labels: [...w.state.labels], state: 'open', author: 'r', body: w.issueBody ?? '', createdAt: min(-600) }) };
  w.lookup = lookup;
  w.state.comments.push({ id, body, login: 'maint', isBot: false, createdAt: min(0.5) });
  const fires = (await matchEvent({ config, event: commentEvent(body, { commentId: id }), workflowRepo: HUB, hubRepo: HUB, lookup })).fires;
  const log = (m) => w.state.log.push(m);
  const stub = stubRoutine({ lookup, gh: w.gh, hubRepo: HUB, log, now: () => new Date(w.state.clock + 500) });
  const fireRoutine = async (prompt, c) => (w.state.fired.push(c.route), stub(prompt, c));
  return runCandidates({ candidates: fires, config, workflowRepo: HUB, hubRepo: HUB, lookup, gh: w.gh, fireRoutine, log, now: min(1) });
}

const bodies = (w) => w.state.comments.filter((c) => c.isBot).map((c) => c.body);

test('the stub reads the run block and what the instruction asks for', () => {
  assert.deepEqual(parseRunBlock('x\n\n<loop-run>\nrepo: a/b\nhop: 2\n</loop-run>\n'), { repo: 'a/b', hop: '2' });
  assert.deepEqual(stubPlan('Reply with /loop-comment, then /loop-comment status. <loop-run>/loop-edge x'), { comments: [null, 'status'], edge: null });
  assert.deepEqual(stubPlan('Hand on with `/loop-edge after`.'), { comments: [null], edge: 'after' });
});

test('stub: a reply and a living comment, then the claim comes off', async () => {
  const w = world();
  assert.equal(await stubRun(w, '🤖 say hi'), true);
  assert.deepEqual(bodies(w), [
    '<!-- loop:reply:say:555 -->\nStub: a reply from route "say" (hop 0).',
    '<!-- loop:status -->\nStub: route "say" keeps "status" up to date (hop 0).',
  ]);
  assert.equal(w.state.labels.has('loop/working'), false);
  assert.ok(w.state.reactions.c555.rocket);
});

test('stub: a second request edits the living comment and adds its own reply', async () => {
  const w = world();
  await stubRun(w, '🤖 say hi');
  await stubRun(w, '🤖 say bye', { id: '557' });
  assert.equal(bodies(w).filter((b) => b.includes('loop:status')).length, 1);
  assert.equal(bodies(w).filter((b) => b.includes('loop:reply:say:')).length, 2);
});

test('stub: an edge is handed on and run, which then releases the claim', async () => {
  const w = world();
  await stubRun(w, '🤖 chain please');
  assert.deepEqual(w.state.fired, ['chain', 'after']);
  assert.match(bodies(w).at(-1), /route "after" \(hop 1\)/);
  assert.equal(w.state.labels.has('loop/working'), false);
});

test('stub: after releasing, a comment that waited is caught up', async () => {
  const w = world();
  w.state.comments.push({ id: '556', body: '🤖 say again', login: 'maint', isBot: false, createdAt: min(0.6) });
  w.state.reactions.c556 = { eyes: 99 };
  await stubRun(w, '🤖 say hi');
  assert.deepEqual(w.state.fired, ['say', 'say']);
  assert.ok(w.state.reactions.c556.rocket);
});

test('stub: "stub: refuse" fails the fire, and "stub: silent" leaves the claim on', async () => {
  const refused = world();
  refused.issueBody = 'stub: refuse';
  assert.equal(await stubRun(refused, '🤖 say hi'), false);
  assert.ok(refused.state.reactions.c555.confused);
  assert.equal(refused.state.labels.has('loop/working'), false);

  const silent = world();
  await stubRun(silent, '🤖 say hi stub: silent');
  assert.equal(bodies(silent).length, 0);
  assert.ok(silent.state.labels.has('loop/working'), 'like a run that died');
});
