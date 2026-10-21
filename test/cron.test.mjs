import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronDue, parseCron } from '../src/cron.mjs';

// 2026-10-19 is a Monday.
const at = (iso) => new Date(iso);

test('a weekday morning schedule is due on a weekday at that hour', () => {
  assert.equal(cronDue('0 7 * * 1-5', at('2026-10-19T07:00:00Z')), true);
  assert.equal(cronDue('0 7 * * 1-5', at('2026-10-19T07:40:00Z')), true);
  assert.equal(cronDue('0 7 * * 1-5', at('2026-10-19T08:00:00Z')), false);
  assert.equal(cronDue('0 7 * * 1-5', at('2026-10-18T07:00:00Z')), false);
});

test('every hour is due every hour', () => {
  assert.equal(cronDue('0 * * * *', at('2026-10-19T13:00:00Z')), true);
});

test('steps and lists work', () => {
  assert.equal(cronDue('0 */6 * * *', at('2026-10-19T12:00:00Z')), true);
  assert.equal(cronDue('0 */6 * * *', at('2026-10-19T13:00:00Z')), false);
  assert.equal(cronDue('0 9,17 * * *', at('2026-10-19T17:00:00Z')), true);
  assert.equal(cronDue('0 8-18/2 * * *', at('2026-10-19T10:00:00Z')), true);
  assert.equal(cronDue('0 8-18/2 * * *', at('2026-10-19T11:00:00Z')), false);
});

test('7 means Sunday, like 0', () => {
  assert.equal(cronDue('0 7 * * 7', at('2026-10-18T07:00:00Z')), true);
});

test('with both day fields set, either one matching is enough', () => {
  assert.equal(cronDue('0 7 1 * 1', at('2026-10-19T07:00:00Z')), true);
  assert.equal(cronDue('0 7 1 * 1', at('2026-11-01T07:00:00Z')), true);
  assert.equal(cronDue('0 7 1 * 1', at('2026-10-20T07:00:00Z')), false);
});

test('schedules use UTC', () => {
  assert.equal(cronDue('0 23 * * *', at('2026-10-20T01:00:00+02:00')), true);
});

test('the minute must be 0', () => {
  assert.throws(() => parseCron('30 7 * * *'), /minute must be 0/);
});

test('malformed schedules are rejected with a reason', () => {
  assert.throws(() => parseCron('0 7 * *'), /needs 5 fields/);
  assert.throws(() => parseCron('0 25 * * *'), /hour.*outside 0-23/);
  assert.throws(() => parseCron('0 7 * * MON'), /names like MON/);
  assert.throws(() => parseCron('0 9-5 * * *'), /outside/);
});
