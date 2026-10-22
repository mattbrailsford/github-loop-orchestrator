import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { normalizeEvent } from '../src/event.mjs';
import { CATCH_UP_LEAD_MS, pendingComments, runCandidates } from '../src/fire.mjs';
import { matchEvent } from '../src/match.mjs';
import { HUB, baseConfig, commentEvent, fakeLookup, issueEvent } from './helpers.mjs';

const T0 = Date.parse('2026-10-21T16:00:00Z');
const min = (m) => T0 + m * 60000;
const NONE = { eyes: null, rocket: null, confused: null };

// --- the match step: what it hands over -------------------------------------------------

const match = (event, { config = baseConfig(), lookup = fakeLookup({ permissions: { maint: 'admin' } }) } = {}) =>
  matchEvent({ config, event, workflowRepo: HUB, hubRepo: HUB, lookup });

test('a match hands over a claim with the default label, and the prompt says how to release it', async () => {
  const r = await match(issueEvent());
  const f = r.fires[0];
  assert.equal(f.type, 'fire');
  assert.deepEqual(f.claim, { repo: HUB, number: 7, label: 'loop/working', stale_after_minutes: 60 });
  assert.deepEqual(f.trigger, { type: 'issue', repo: HUB, number: 7 });
  assert.match(f.prompt, /holds the claim: the label "loop\/working" on acme\/tracker#7/);
  assert.match(f.prompt, /As your last step, whatever happened, remove the "loop\/working" label/);
  assert.match(f.prompt, /if you handed on with \/loop-edge, leave it on/);
});

test('every prompt carries the run details in a fixed block', async () => {
  const r = await match(commentEvent('@claude look'));
  assert.match(
    r.fires[0].prompt,
    /<loop-run>\nhub: acme\/tracker\nrepo: acme\/tracker\nnumber: 7\nkind: issue\nroute: maintainer-asks\nhop: 0\nclaim: loop\/working\n<\/loop-run>/,
  );
});

test('an edge run sees its hop, and a schedule run sees its time and no item', async () => {
  const lookup = fakeLookup({ issues: { [`${HUB}#7`]: { kind: 'issue', labels: [], state: 'open', author: 'r' } } });
  const edge = normalizeEvent(
    'repository_dispatch',
    { action: 'loop-edge', client_payload: { route: 'investigate', from: 'maintainer-decides', number: 7, hop: 2 } },
    HUB,
  );
  assert.match((await match(edge, { lookup })).fires[0].prompt, /route: investigate\nhop: 2\n/);

  const config = baseConfig({ claim: false, routes: [{ name: 's', when: 'schedule', cron: '0 * * * *', prompt: 'x' }] });
  const tick = normalizeEvent('repository_dispatch', { action: 'loop-tick' }, HUB, new Date(min(0)));
  const prompt = (await match(tick, { config })).fires[0].prompt;
  assert.match(prompt, /<loop-run>\nhub: acme\/tracker\nrepo: acme\/tracker\ntime: 2026-10-21T16:00Z\nroute: s\n<\/loop-run>/);
});

test('the label and expiry come from the config', async () => {
  const r = await match(issueEvent(), { config: baseConfig({ claim: { label: 'bot/busy', stale_after_minutes: 10 } }) });
  assert.equal(r.fires[0].claim.label, 'bot/busy');
  assert.equal(r.fires[0].claim.stale_after_minutes, 10);
});

test('a comment is the trigger for its fire', async () => {
  const r = await match(commentEvent('@claude look'));
  assert.deepEqual(r.fires[0].trigger, { type: 'comment', repo: HUB, id: '555' });
});

test('with claims off, there is no claim and no claim line', async () => {
  const r = await match(issueEvent(), { config: baseConfig({ claim: false }) });
  assert.equal(r.fires[0].claim, null);
  assert.doesNotMatch(r.fires[0].prompt, /holds the claim/);
});

test('the claim label coming off asks for a catch-up; another label coming off does nothing', async () => {
  const released = (label) => issueEvent({ when: 'released', label, actor: 'matt' });
  const r = await match(released('loop/working'));
  assert.deepEqual(r.fires, [{ type: 'catch-up', item: { repo: HUB, number: 7 } }]);
  assert.deepEqual((await match(released('state/drafted'))).fires, []);
  assert.deepEqual((await match(released('loop/working'), { config: baseConfig({ claim: false }) })).fires, []);
});

test('a tick lists stale claims, and only stale ones', async () => {
  const tick = normalizeEvent('repository_dispatch', { action: 'loop-tick' }, HUB, new Date(min(0)));
  const lookup = fakeLookup({
    claimed: [7, 8],
    labelAges: { [`${HUB}#7:loop/working`]: 90, [`${HUB}#8:loop/working`]: 5 },
  });
  const r = await match(tick, { lookup });
  assert.deepEqual(r.fires, []);
  assert.deepEqual(r.stale, [7]);
  assert.match(r.log, /stale claims on #7/);
});

test('claim settings are checked', () => {
  const errorsFor = (extra) => validateConfig(baseConfig(extra));
  assert.ok(errorsFor({ claim: { label: 'loop/*' } }).some((e) => e.includes('claim.label')));
  assert.ok(errorsFor({ claim: { stale_after_minutes: 1 } }).some((e) => e.includes('stale_after_minutes')));
  assert.ok(errorsFor({ claim: { lable: 'x' } }).some((e) => e.includes('unknown key "lable"')));
  assert.ok(errorsFor({ acknowledge: 'eyes' }).some((e) => e.includes('unknown top-level key "acknowledge"')));
  assert.deepEqual(errorsFor({ claim: false }), []);
});

// --- the claim-and-fire step ------------------------------------------------------------

// A fake GitHub that keeps labels and reactions, so a test can check what ended up where.
function world({ labels = [], claimAt = null, comments = [], reactions = {}, fireOk = true, permissions = { maint: 'admin' }, item = {}, unreadable = [] } = {}) {
  const state = { labels: new Set(labels), claimAt, reactions: structuredClone(reactions), fired: [], log: [], clock: min(1) };
  const key = (t) => (t.type === 'comment' ? `c${t.id}` : `i${t.number}`);
  const lookup = {
    ...fakeLookup({ permissions }),
    async issue() {
      return { kind: 'issue', labels: [...state.labels], state: 'open', author: 'reporter', body: '', createdAt: min(-600), ...item };
    },
    async labelAge(repo, number, label, now) {
      return state.labels.has(label) && state.claimAt !== null ? (now - state.claimAt) / 60000 : null;
    },
    async labelAddedAt() {
      return state.claimAt;
    },
    async orchestratorReactions(t) {
      if (unreadable.includes(key(t))) return null;
      return { ...NONE, ...(state.reactions[key(t)] ?? {}) };
    },
    async commentsWithReactions() {
      return comments.map((c) => ({
        ...c,
        orchestrator: unreadable.includes(`c${c.id}`) ? null : { ...NONE, ...(state.reactions[`c${c.id}`] ?? {}) },
      }));
    },
    async claimedItems() {
      return state.labels.has('loop/working') ? [7] : [];
    },
  };
  let nextId = 1;
  const gh = {
    async addLabel(repo, number, label) {
      if (!state.labels.has(label)) state.claimAt = state.clock;
      state.labels.add(label);
      return true;
    },
    async removeLabel(repo, number, label) {
      state.labels.delete(label);
      return true;
    },
    async react(t, content) {
      const id = nextId++;
      state.reactions[key(t)] = { ...(state.reactions[key(t)] ?? {}), [content]: id };
      return id;
    },
    async unreact(t, id) {
      const r = state.reactions[key(t)] ?? {};
      for (const k of Object.keys(r)) if (r[k] === id) delete r[k];
      return true;
    },
  };
  const fireRoutine = async (prompt) => {
    state.fired.push(prompt);
    return fireOk;
  };
  return { state, lookup, gh, fireRoutine };
}

const run = (w, candidates, { config = baseConfig(), now = min(1) } = {}) =>
  runCandidates({
    candidates,
    config,
    workflowRepo: HUB,
    hubRepo: HUB,
    lookup: w.lookup,
    gh: w.gh,
    fireRoutine: w.fireRoutine,
    log: (m) => w.state.log.push(m),
    now,
  });

const fireFor = (trigger = { type: 'comment', repo: HUB, id: '555' }) => ({
  type: 'fire',
  route: 'maintainer-asks',
  prompt: 'do it',
  item: { repo: HUB, number: 7 },
  claim: { repo: HUB, number: 7, label: 'loop/working', stale_after_minutes: 60 },
  edge: false,
  trigger,
});

test('a free item: claim it, 👀 the comment, fire, then 🚀', async () => {
  const w = world();
  assert.equal(await run(w, [fireFor()]), true);
  assert.ok(w.state.labels.has('loop/working'));
  assert.deepEqual(Object.keys(w.state.reactions.c555).sort(), ['eyes', 'rocket']);
  assert.equal(w.state.fired.length, 1);
});

test('a claimed item: the comment gets 👀 and waits; nothing fires', async () => {
  const w = world({ labels: ['loop/working'], claimAt: min(0) });
  await run(w, [fireFor()]);
  assert.equal(w.state.fired.length, 0);
  assert.deepEqual(Object.keys(w.state.reactions.c555), ['eyes']);
  assert.match(w.state.log.join('\n'), /another run holds the claim; waiting its turn/);
});

test('a claim whose age is unknown counts as held', async () => {
  const w = world({ labels: ['loop/working'], claimAt: null });
  await run(w, [fireFor()]);
  assert.equal(w.state.fired.length, 0);
});

test('a stale claim is taken over', async () => {
  const w = world({ labels: ['loop/working'], claimAt: min(-90) });
  await run(w, [fireFor()]);
  assert.equal(w.state.fired.length, 1);
  assert.match(w.state.log.join('\n'), /taking over a claim left for 91 min/);
});

test('a comment a run already started for is never fired again', async () => {
  const w = world({ reactions: { c555: { eyes: 1, rocket: 2 } } });
  await run(w, [fireFor()]);
  assert.equal(w.state.fired.length, 0);
  assert.match(w.state.log.join('\n'), /already started/);
});

test("a fire that fails gives back the claim, swaps 👀 for 😕, and fails the job", async () => {
  const w = world({ fireOk: false });
  assert.equal(await run(w, [fireFor()]), false);
  assert.equal(w.state.labels.has('loop/working'), false);
  assert.deepEqual(Object.keys(w.state.reactions.c555), ['confused']);
});

test('an edge passes a held claim, takes it over afresh, and has nothing to react to', async () => {
  const w = world({ labels: ['loop/working'], claimAt: min(0) });
  await run(w, [{ ...fireFor(null), edge: { sentAt: min(0.5) } }]);
  assert.equal(w.state.fired.length, 1);
  assert.ok(w.state.labels.has('loop/working'));
  assert.equal(w.state.claimAt, w.state.clock, 'the claim time marks the handover');
  assert.deepEqual(w.state.reactions, {});
});

test('the same edge sent twice fires once', async () => {
  const w = world({ labels: ['loop/working'], claimAt: min(0) });
  const edge = { ...fireFor(null), edge: { sentAt: min(0.5) } };
  await run(w, [edge, edge]);
  assert.equal(w.state.fired.length, 1);
  assert.match(w.state.log.join('\n'), /already handed on; skipped as a repeat/);
});

test('the next run in a chain can still hand on, since it sends after taking over', async () => {
  const w = world({ labels: ['loop/working'], claimAt: min(0) });
  await run(w, [{ ...fireFor(null), edge: { sentAt: min(0.5) } }]);
  w.state.clock = min(3);
  await run(w, [{ ...fireFor(null), edge: { sentAt: min(2) } }]);
  assert.equal(w.state.fired.length, 2);
});

test('a label route skips while the item is claimed, and says so', async () => {
  const w = world({ labels: ['loop/working'], claimAt: min(0) });
  await run(w, [{ ...fireFor(null), if_claimed: 'skip' }]);
  assert.equal(w.state.fired.length, 0);
  assert.match(w.state.log.join('\n'), /label route skips while claimed/);
});

test('a label route must say it accepts being skipped while claims are on', () => {
  const route = { name: 'l', when: 'issues.labeled', if: { label: 'go' }, prompt: 'x' };
  assert.ok(validateConfig(baseConfig({ routes: [route] })).some((e) => e.includes('if_claimed: skip')));
  assert.deepEqual(validateConfig(baseConfig({ routes: [{ ...route, if_claimed: 'skip' }] })), []);
  assert.deepEqual(validateConfig(baseConfig({ claim: false, routes: [route] })), []);
  assert.ok(
    validateConfig(baseConfig({ routes: [{ name: 'c', when: 'issues.opened', if_claimed: 'skip', prompt: 'x' }] })).some((e) =>
      e.includes('only a *.labeled route'),
    ),
  );
});

test("if a comment's reactions can't be read, it isn't fired", async () => {
  const w = world({ unreadable: ['c555'] });
  await run(w, [fireFor()]);
  assert.equal(w.state.fired.length, 0);
  assert.match(w.state.log.join('\n'), /couldn't read its reactions/);
});

test('a schedule fire has no claim and no reaction', async () => {
  const w = world();
  await run(w, [{ type: 'fire', route: 's', prompt: 'x', item: null, claim: null, edge: false, trigger: null }]);
  assert.equal(w.state.fired.length, 1);
  assert.equal(w.state.labels.size, 0);
});

// --- catching up ---------------------------------------------------------------------------

const comment = (id, body, createdAt, extra = {}) => ({ id, body, login: 'maint', isBot: false, createdAt, ...extra });

test('pending: 👀 without 🚀, or posted during the claim and never seen; oldest first', () => {
  const list = [
    { ...comment('3', 'c', min(5)), orchestrator: { ...NONE, eyes: 1 } },
    { ...comment('1', 'a', min(-60)), orchestrator: NONE },
    { ...comment('2', 'b', min(2)), orchestrator: NONE },
    { ...comment('4', 'd', min(3)), orchestrator: { ...NONE, eyes: 1, rocket: 2 } },
    { ...comment('5', 'e', min(4)), orchestrator: { ...NONE, confused: 3 } },
    { ...comment('6', 'f', min(4), { isBot: true }), orchestrator: NONE },
    { ...comment('7', 'g', min(-30)), orchestrator: { ...NONE, eyes: 1 } },
  ];
  assert.deepEqual(
    pendingComments(list, min(0)).map((c) => c.id),
    ['7', '2', '3'],
  );
  assert.ok(CATCH_UP_LEAD_MS >= 5 * 60000);
});

test('on release, the oldest waiting comment is replayed through its own route', async () => {
  const w = world({
    claimAt: min(0),
    comments: [comment('900', '@claude first', min(-0.2)), comment('902', '@claude second', min(1)), comment('903', 'thanks', min(2))],
    reactions: { c900: { eyes: 1, rocket: 2 }, c902: { eyes: 3 } },
  });
  await run(w, [{ type: 'catch-up', item: { repo: HUB, number: 7 } }], { now: min(3) });
  assert.equal(w.state.fired.length, 1);
  assert.match(w.state.fired[0], /second/);
  assert.ok(w.state.reactions.c902.rocket, 'the replayed comment is marked as started');
  assert.ok(w.state.labels.has('loop/working'), 'the replay claims the item again');
});

test('on release, nothing waiting means nothing fires', async () => {
  const w = world({
    claimAt: min(0),
    comments: [comment('900', '@claude first', min(-0.2))],
    reactions: { c900: { eyes: 1, rocket: 2 } },
  });
  await run(w, [{ type: 'catch-up', item: { repo: HUB, number: 7 } }]);
  assert.equal(w.state.fired.length, 0);
  assert.match(w.state.log.join('\n'), /nothing was waiting/);
});

test("a waiting comment no route wants is passed over for the next one", async () => {
  const w = world({
    claimAt: min(0),
    comments: [comment('910', 'just chatting', min(1), { login: 'someone' }), comment('911', '@claude go', min(2))],
  });
  await run(w, [{ type: 'catch-up', item: { repo: HUB, number: 7 } }]);
  assert.equal(w.state.fired.length, 1);
  assert.ok(w.state.reactions.c911.rocket);
});

test('a run that posts nothing cannot loop: its trigger has 🚀, so it is never replayed', async () => {
  const w = world({ comments: [comment('555', '@claude look', min(0))] });
  await run(w, [fireFor()]);
  w.state.labels.delete('loop/working');
  await run(w, [{ type: 'catch-up', item: { repo: HUB, number: 7 } }]);
  assert.equal(w.state.fired.length, 1);
});

test('a sweep clears a stale claim and catches up on what waited', async () => {
  const w = world({
    labels: ['loop/working'],
    claimAt: min(-120),
    comments: [comment('920', '@claude still there?', min(-100))],
    reactions: { c920: { eyes: 1 } },
  });
  await run(w, [{ type: 'sweep-item', item: { repo: HUB, number: 7 } }]);
  assert.match(w.state.log.join('\n'), /clearing a claim left for 121 min/);
  assert.equal(w.state.fired.length, 1);
  assert.ok(w.state.reactions.c920.rocket);
});

test('a sweep leaves a fresh claim alone', async () => {
  const w = world({ labels: ['loop/working'], claimAt: min(-5) });
  await run(w, [{ type: 'sweep-item', item: { repo: HUB, number: 7 } }]);
  assert.ok(w.state.labels.has('loop/working'));
  assert.equal(w.state.fired.length, 0);
});

test("the catch-up passes over a comment whose reactions can't be read", async () => {
  const w = world({
    claimAt: min(0),
    comments: [comment('930', '@claude a', min(1)), comment('931', '@claude b', min(2))],
    unreadable: ['c930'],
  });
  await run(w, [{ type: 'catch-up', item: { repo: HUB, number: 7 } }]);
  assert.equal(w.state.fired.length, 1);
  assert.ok(w.state.reactions.c931.rocket);
});

test('a new issue that waited behind a claim is caught up before its comments', async () => {
  const w = world({
    claimAt: min(0),
    item: { body: 'it crashes', createdAt: min(1) },
    reactions: { i7: { eyes: 1 } },
    comments: [comment('940', '@claude look', min(2))],
  });
  await run(w, [{ type: 'catch-up', item: { repo: HUB, number: 7 } }]);
  assert.equal(w.state.fired.length, 1);
  assert.match(w.state.fired[0], /^Triage acme\/tracker#7/);
  assert.ok(w.state.reactions.i7.rocket);
  assert.match(w.state.log.join('\n'), /the issue itself was waiting/);
});

test('a new issue that already ran is not caught up', async () => {
  const w = world({ claimAt: min(0), item: { createdAt: min(1) }, reactions: { i7: { eyes: 1, rocket: 2 } } });
  await run(w, [{ type: 'catch-up', item: { repo: HUB, number: 7 } }]);
  assert.equal(w.state.fired.length, 0);
});
