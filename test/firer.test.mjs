import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { routineFirer } from '../src/github.mjs';

async function serve(statuses) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, beta: req.headers['anthropic-beta'], body: JSON.parse(body) });
      res.statusCode = statuses[Math.min(seen.length - 1, statuses.length - 1)];
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/fire`, seen, close: () => server.close() };
}

test('a fire sends the prompt as text, with the token and beta header', async () => {
  const s = await serve([200]);
  try {
    assert.equal(await routineFirer({ url: s.url, token: 'tok' })('hello'), true);
    assert.deepEqual(s.seen, [{ auth: 'Bearer tok', beta: 'experimental-cc-routine-2026-04-01', body: { text: 'hello' } }]);
  } finally {
    s.close();
  }
});

test('a server error is retried', async () => {
  const s = await serve([502, 500, 200]);
  try {
    assert.equal(await routineFirer({ url: s.url, token: 't', delayMs: 1 })('x'), true);
    assert.equal(s.seen.length, 3);
  } finally {
    s.close();
  }
});

test('a bad token is not retried', async () => {
  const s = await serve([401]);
  try {
    assert.equal(await routineFirer({ url: s.url, token: 't', delayMs: 1 })('x'), false);
    assert.equal(s.seen.length, 1);
  } finally {
    s.close();
  }
});

test('hitting the hourly limit is retried, then gives up', async () => {
  const s = await serve([429]);
  try {
    assert.equal(await routineFirer({ url: s.url, token: 't', delayMs: 1, attempts: 2 })('x'), false);
    assert.equal(s.seen.length, 2);
  } finally {
    s.close();
  }
});
