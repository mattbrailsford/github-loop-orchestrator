import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { normalizeEvent } from '../src/event.mjs';
import { matchEvent } from '../src/match.mjs';
import { HUB, baseConfig, commentEvent, fakeLookup, issueEvent } from './helpers.mjs';

const run = (event, { config = baseConfig(), lookup = fakeLookup() } = {}) =>
  matchEvent({ config, event, workflowRepo: HUB, hubRepo: HUB, lookup });

const claimed = (labels, age) =>
  fakeLookup({
    permissions: { maint: 'admin' },
    issues: { [`${HUB}#7`]: { kind: 'issue', labels, state: 'open', author: 'reporter' } },
    labelAges: age === undefined ? {} : { [`${HUB}#7:loop/working`]: age },
  });

test('a match claims the item with the default label, and the prompt says how to release it', async () => {
  const r = await run(issueEvent());
  assert.deepEqual(r.fires[0].claim, { repo: HUB, number: 7, label: 'loop/working' });
  assert.match(r.prompt, /holds the claim: the label "loop\/working" on acme\/tracker#7/);
  assert.match(r.prompt, /as your last step, whatever happened, remove the "loop\/working" label/);
  assert.match(r.prompt, /if you fired a loop-edge, leave the label on/);
});

test('the label comes from the config', async () => {
  const config = baseConfig({ claim: { label: 'bot/busy', stale_after_minutes: 10 } });
  const r = await run(issueEvent(), { config });
  assert.equal(r.fires[0].claim.label, 'bot/busy');
  assert.match(r.prompt, /"bot\/busy"/);
});

test('an item someone else is working on is skipped', async () => {
  const lookup = claimed(['loop/working'], 3);
  const r = await run(commentEvent('@claude look', { labels: [] }), { lookup });
  assert.deepEqual(r.fires, []);
  assert.match(r.log, /matched route "maintainer-asks", but another run holds the claim, 3 min ago; skipped/);
});

test('the claim is read from the item now, not from the event', async () => {
  const lookup = claimed(['loop/working'], 1);
  const r = await run(issueEvent({ labels: [] }), { lookup });
  assert.deepEqual(r.fires, []);
});

test('a claim older than the limit is taken over', async () => {
  const lookup = claimed(['loop/working'], 45);
  const r = await run(issueEvent(), { lookup });
  assert.equal(r.route, 'new-issue');
  assert.match(r.log, /took over a claim left for 45 min/);
});

test('a claim whose age is unknown counts as held', async () => {
  const lookup = claimed(['loop/working']);
  const r = await run(issueEvent(), { lookup });
  assert.deepEqual(r.fires, []);
});

test('claims can be turned off', async () => {
  const lookup = claimed(['loop/working'], 1);
  const r = await run(issueEvent(), { config: baseConfig({ claim: false }), lookup });
  assert.equal(r.route, 'new-issue');
  assert.equal(r.fires[0].claim, null);
  assert.doesNotMatch(r.prompt, /holds the claim/);
});

test('an edge passes a claim, since its sender holds it, and takes the claim over', async () => {
  const lookup = fakeLookup({
    issues: { [`${HUB}#7`]: { kind: 'issue', labels: ['loop/working'], state: 'open', author: 'r' } },
    labelAges: { [`${HUB}#7:loop/working`]: 1 },
  });
  const event = normalizeEvent(
    'repository_dispatch',
    { action: 'loop-edge', client_payload: { route: 'investigate', from: 'maintainer-decides', number: 7, hop: 1 } },
    HUB,
  );
  const r = await run(event, { lookup });
  assert.equal(r.route, 'investigate');
  assert.deepEqual(r.fires[0].claim, { repo: HUB, number: 7, label: 'loop/working' });
});

test('a schedule never claims', async () => {
  const config = baseConfig({ routes: [{ name: 's', when: 'schedule', cron: '0 * * * *', prompt: 'x' }] });
  const event = normalizeEvent('repository_dispatch', { action: 'loop-tick' }, HUB, new Date('2026-10-19T07:00:00Z'));
  const r = await run(event, { config });
  assert.equal(r.fires[0].claim, undefined);
});

test('the triggering comment gets 👀 by default; an opened issue gets it on the issue', async () => {
  const lookup = fakeLookup({ permissions: { maint: 'admin' } });
  const comment = await run(commentEvent('@claude go'), { lookup });
  assert.deepEqual(comment.fires[0].ack, { path: 'repos/acme/tracker/issues/comments/555/reactions', content: 'eyes' });
  const opened = await run(issueEvent());
  assert.deepEqual(opened.fires[0].ack, { path: 'repos/acme/tracker/issues/7/reactions', content: 'eyes' });
});

test('a label event gets no reaction, and the reaction can be changed or turned off', async () => {
  const labeled = issueEvent({ when: 'issues.labeled', label: 'state/ready', labels: ['state/drafted', 'state/ready'], actor: 'maint' });
  const r = await run(labeled, { lookup: fakeLookup({ permissions: { maint: 'write' } }) });
  assert.equal(r.fires[0].ack, null);
  assert.equal((await run(issueEvent(), { config: baseConfig({ acknowledge: 'rocket' }) })).fires[0].ack.content, 'rocket');
  assert.equal((await run(issueEvent(), { config: baseConfig({ acknowledge: false }) })).fires[0].ack, null);
});

test('claim and acknowledge settings are checked', () => {
  const errorsFor = (extra) => validateConfig(baseConfig(extra));
  assert.ok(errorsFor({ claim: { label: 'loop/*' } }).some((e) => e.includes('claim.label')));
  assert.ok(errorsFor({ claim: { stale_after_minutes: 1 } }).some((e) => e.includes('stale_after_minutes')));
  assert.ok(errorsFor({ claim: { lable: 'x' } }).some((e) => e.includes('unknown key "lable"')));
  assert.ok(errorsFor({ acknowledge: 'thumbsup' }).some((e) => e.includes('acknowledge')));
  assert.deepEqual(errorsFor({ claim: false, acknowledge: false }), []);
});
