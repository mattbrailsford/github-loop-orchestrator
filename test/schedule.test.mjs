import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { normalizeEvent } from '../src/event.mjs';
import { matchEvent } from '../src/match.mjs';
import { SCHEDULED_RECHECK } from '../src/prompt.mjs';
import { CODE, HUB, baseConfig, fakeLookup } from './helpers.mjs';

const MONDAY_7 = new Date('2026-10-19T07:05:00Z');

function scheduleConfig(extra = {}) {
  return baseConfig({
    routes: [
      ...baseConfig().routes,
      { name: 'morning', when: 'schedule', cron: '0 7 * * 1-5', prompt: 'Sweep {repo} at {time}, code in {code_repo}.' },
      { name: 'hourly', when: 'schedule', cron: '0 * * * *', prompt: 'Hourly check of {repo}.' },
      { name: 'weekend', when: 'schedule', cron: '0 7 * * 0,6', prompt: 'Weekend check.' },
    ],
    ...extra,
  });
}

const tick = (now = MONDAY_7, workflowRepo = HUB) =>
  normalizeEvent('repository_dispatch', { action: 'loop-tick' }, workflowRepo, now);

const run = (event, { config = scheduleConfig(), workflowRepo = HUB, lookup = fakeLookup() } = {}) =>
  matchEvent({ config, event, workflowRepo, hubRepo: HUB, lookup });

test('a tick and GitHub schedule both become schedule events', () => {
  assert.equal(tick().when, 'schedule');
  assert.equal(tick().source, 'tick');
  assert.equal(normalizeEvent('schedule', { schedule: '0 * * * *' }, HUB, MONDAY_7).source, 'github-schedule');
});

test('every due route fires, and only those', async () => {
  const r = await run(tick());
  assert.deepEqual(
    r.fires.filter((f) => f.type === 'fire').map((f) => f.route),
    ['morning', 'hourly'],
  );
  assert.match(r.log, /due at 2026-10-19T07:00Z \(tick\): "morning", "hourly"/);
});

test('a scheduled prompt fills repo, time, and code repo, and ends with the scheduled re-check', async () => {
  const r = await run(tick(), { config: scheduleConfig({ code_repo: CODE }) });
  const morning = r.fires.find((f) => f.route === 'morning').prompt;
  assert.ok(morning.startsWith(`Sweep ${HUB} at 2026-10-19T07:00Z, code in ${CODE}.`));
  assert.ok(morning.endsWith(SCHEDULED_RECHECK));
});

test('nothing due means no fires', async () => {
  const config = baseConfig({
    claim: false,
    routes: [{ name: 'weekend', when: 'schedule', cron: '0 7 * * 0,6', prompt: 'x' }],
  });
  const r = await run(tick(), { config });
  assert.deepEqual(r.fires, []);
  assert.match(r.log, /no schedule route is due at 2026-10-19T07:00Z/);
});

test('a schedule only runs in the hub', async () => {
  const config = scheduleConfig({ code_repo: CODE });
  const r = await run(tick(MONDAY_7, CODE), { config, workflowRepo: CODE });
  assert.deepEqual(r.fires, []);
  assert.match(r.log, /must run in the hub/);
});

test('a non-schedule event never fires a schedule route', async () => {
  const event = normalizeEvent('issues', {
    action: 'opened',
    repository: { full_name: HUB },
    sender: { login: 'r', type: 'User' },
    issue: { number: 1, user: { login: 'r' }, labels: [{ name: 'state/x' }], state: 'open', body: '' },
  });
  const r = await run(event);
  assert.deepEqual(r.fires, []);
});

test('schedule routes need a valid cron, take no conditions, and only use repo-wide placeholders', () => {
  const errorsFor = (route) => validateConfig(baseConfig({ routes: [route] }));
  assert.ok(errorsFor({ name: 's', when: 'schedule', prompt: 'x' }).some((e) => e.includes('needs one')));
  assert.ok(errorsFor({ name: 's', when: 'schedule', cron: '15 7 * * *', prompt: 'x' }).some((e) => e.includes('minute must be 0')));
  assert.ok(
    errorsFor({ name: 's', when: 'schedule', cron: '0 7 * * *', if: { state: 'open' }, prompt: 'x' }).some((e) =>
      e.includes('takes no conditions'),
    ),
  );
  assert.ok(
    errorsFor({ name: 's', when: 'schedule', cron: '0 7 * * *', prompt: 'Issue {number}' }).some((e) =>
      e.includes('"{number}" is about one issue or PR'),
    ),
  );
  assert.ok(errorsFor({ name: 's', when: 'issues.opened', cron: '0 7 * * *', prompt: 'x' }).some((e) => e.includes('only a schedule route takes cron')));
});

test('an edge cannot come from a schedule route', () => {
  const errors = validateConfig(
    baseConfig({
      routes: [
        { name: 's', when: 'schedule', cron: '0 7 * * *', prompt: 'x' },
        { name: 'e', when: 'edge', allow_from: ['s'], prompt: 'x' },
      ],
    }),
  );
  assert.ok(errors.some((e) => e.includes('"s" is a schedule route')));
});
