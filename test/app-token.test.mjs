import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const SCRIPT = fileURLToPath(new URL('../scripts/app-token.sh', import.meta.url));
const run = promisify(execFile);

const dir = mkdtempSync(join(tmpdir(), 'app-token-'));
const keyFile = join(dir, 'key.pem');
const pubFile = join(dir, 'pub.pem');
execFileSync('openssl', ['genrsa', '-out', keyFile, '2048'], { stdio: 'ignore' });
execFileSync('openssl', ['rsa', '-in', keyFile, '-pubout', '-out', pubFile], { stdio: 'ignore' });

const env = (extra = {}) => ({ ...process.env, LOOP_APP_ID: '123456', LOOP_APP_KEY_FILE: keyFile, ...extra });
const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

test('the JWT names the app, is short-lived, and verifies with the public key', async () => {
  const { stdout } = await run('bash', [SCRIPT, '--jwt-only'], { env: env() });
  const [header, payload, signature] = stdout.trim().split('.');
  assert.deepEqual(JSON.parse(fromB64url(header)), { alg: 'RS256', typ: 'JWT' });

  const claims = JSON.parse(fromB64url(payload));
  const now = Math.floor(Date.now() / 1000);
  assert.equal(claims.iss, '123456');
  assert.ok(claims.iat <= now && claims.iat >= now - 120);
  assert.ok(claims.exp - claims.iat <= 600, 'GitHub refuses JWTs that live over 10 minutes');

  const signed = join(dir, 'signed.txt');
  const sig = join(dir, 'sig.bin');
  writeFileSync(signed, `${header}.${payload}`);
  writeFileSync(sig, fromB64url(signature));
  const verify = execFileSync('openssl', ['dgst', '-sha256', '-verify', pubFile, '-signature', sig, signed], {
    encoding: 'utf8',
  });
  assert.match(verify, /Verified OK/);
});

test('the key can come straight from LOOP_APP_KEY', async () => {
  const pem = execFileSync('cat', [keyFile], { encoding: 'utf8' });
  const { stdout } = await run('bash', [SCRIPT, '--jwt-only'], { env: env({ LOOP_APP_KEY_FILE: '', LOOP_APP_KEY: pem }) });
  assert.equal(stdout.trim().split('.').length, 3);
});

test('it finds the installation and asks for a token scoped to the named repos', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/repos/acme/tracker/installation') return res.end('{"id":42}');
      if (req.method === 'POST' && req.url === '/app/installations/42/access_tokens') {
        return res.end('{"token":"ghs_fake","expires_at":"2026-10-21T15:00:00Z"}');
      }
      res.statusCode = 404;
      res.end('{"message":"Not Found"}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await run('bash', [SCRIPT, '--repo', 'acme/tracker', '--repo', 'acme/code'], {
      env: env({ LOOP_GITHUB_API: api }),
    });
    assert.equal(stdout.trim(), 'ghs_fake');
    assert.equal(seen.length, 2);
    assert.ok(seen.every((s) => /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(s.auth)));
    assert.deepEqual(JSON.parse(seen[1].body), { repositories: ['tracker', 'code'] });
  } finally {
    server.close();
  }
});

test('a repo the app is not installed on fails with the reason', async () => {
  const server = createServer((req, res) => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"message":"Not Found"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      run('bash', [SCRIPT, '--repo', 'acme/nope'], { env: env({ LOOP_GITHUB_API: `http://127.0.0.1:${server.address().port}` }) }),
      (err) => /HTTP 404: Not Found/.test(err.stderr) && err.stdout === '',
    );
  } finally {
    server.close();
  }
});

test('missing settings fail clearly', async () => {
  await assert.rejects(run('bash', [SCRIPT, '--jwt-only'], { env: { ...process.env, LOOP_APP_ID: '' } }), (err) =>
    /LOOP_APP_ID isn't set/.test(err.stderr),
  );
  await assert.rejects(run('bash', [SCRIPT], { env: env() }), (err) => /at least one --repo/.test(err.stderr));
});
