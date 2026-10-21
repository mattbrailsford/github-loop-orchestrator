import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../src/event.mjs';

const repository = { full_name: 'acme/tracker' };
const user = { login: 'reporter', type: 'User' };

test('an opened issue keeps its body for mention checks', () => {
  const e = normalizeEvent('issues', {
    action: 'opened',
    repository,
    sender: user,
    issue: { number: 3, user, labels: [{ name: 'bug' }], state: 'open', body: 'hi @claude' },
  });
  assert.equal(e.when, 'issues.opened');
  assert.equal(e.kind, 'issue');
  assert.deepEqual(e.labels, ['bug']);
  assert.equal(e.body, 'hi @claude');
});

test('a labeled issue records the label just added', () => {
  const e = normalizeEvent('issues', {
    action: 'labeled',
    repository,
    sender: { login: 'maint', type: 'User' },
    label: { name: 'state/ready' },
    issue: { number: 3, user, labels: [], state: 'open', body: 'ignored' },
  });
  assert.equal(e.label, 'state/ready');
  assert.equal(e.body, '');
});

test('a comment on a PR becomes pr_comment.created', () => {
  const e = normalizeEvent('issue_comment', {
    action: 'created',
    repository,
    sender: { login: 'maint', type: 'User' },
    issue: { number: 9, user, labels: [], state: 'open', pull_request: {} },
    comment: { id: 42, body: '@claude look', user: { login: 'maint', type: 'User' } },
  });
  assert.equal(e.when, 'pr_comment.created');
  assert.equal(e.kind, 'pr');
  assert.equal(e.commentId, '42');
});

test('a bot comment is marked as a bot', () => {
  const e = normalizeEvent('issue_comment', {
    action: 'created',
    repository,
    sender: { login: 'claude[bot]', type: 'Bot' },
    issue: { number: 9, user, labels: [], state: 'open' },
    comment: { id: 1, body: 'x', user: { login: 'claude[bot]', type: 'Bot' } },
  });
  assert.equal(e.senderIsBot, true);
});

test('pull_request_target is treated as pull_request', () => {
  const e = normalizeEvent('pull_request_target', {
    action: 'opened',
    repository,
    sender: user,
    pull_request: { number: 5, user, labels: [], state: 'open', body: '' },
  });
  assert.equal(e.when, 'pull_request.opened');
  assert.equal(e.kind, 'pr');
});

test('actions we do not route are ignored', () => {
  assert.equal(normalizeEvent('issues', { action: 'closed', repository }), null);
  assert.equal(normalizeEvent('issue_comment', { action: 'edited', repository }), null);
  assert.equal(normalizeEvent('push', {}), null);
  assert.equal(normalizeEvent('repository_dispatch', { action: 'other' }), null);
});

test('a loop-edge reads its payload, defaulting the repo to the workflow repo', () => {
  const e = normalizeEvent(
    'repository_dispatch',
    { action: 'loop-edge', client_payload: { route: 'investigate', from: 'decide', number: 4, hop: 1 } },
    'acme/tracker',
  );
  assert.equal(e.when, 'edge');
  assert.equal(e.repo, 'acme/tracker');
  assert.deepEqual(e.edge, { route: 'investigate', from: 'decide', hop: 1 });
});

test('a malformed loop-edge is flagged, not routed', () => {
  const e = normalizeEvent('repository_dispatch', { action: 'loop-edge', client_payload: { route: 'x', number: 4 } }, 'acme/tracker');
  assert.ok(e.invalid);
});
