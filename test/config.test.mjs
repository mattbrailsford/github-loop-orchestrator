import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { labelMatches, validateConfig } from '../src/config.mjs';
import { baseConfig } from './helpers.mjs';

const errorsFor = (config) => validateConfig(config);
const withRoute = (route) => baseConfig({ routes: [route] });
const expectError = (config, fragment) => {
  const errors = errorsFor(config);
  assert.ok(
    errors.some((e) => e.includes(fragment)),
    `expected an error containing "${fragment}", got:\n${errors.join('\n')}`,
  );
};

test('a well-formed config has no errors', () => {
  assert.deepEqual(errorsFor(baseConfig()), []);
});

test('version must be 1', () => {
  expectError(baseConfig({ version: 2 }), 'version');
});

test('unknown top-level keys are rejected', () => {
  expectError(baseConfig({ extra: true }), 'unknown top-level key "extra"');
});

test('"on" gets a pointer to "when"', () => {
  expectError(withRoute({ name: 'a', on: 'issues.opened', prompt: 'x' }), 'use "when", not "on"');
});

test('an unknown event is an error, not a silent no-op', () => {
  expectError(withRoute({ name: 'a', when: 'issues.closed', prompt: 'x' }), '.when: must be one of');
});

test('route names must be unique', () => {
  const r = { name: 'a', when: 'issues.opened', prompt: 'x' };
  expectError(baseConfig({ routes: [r, { ...r }] }), 'used by another route');
});

test('unknown placeholders are rejected', () => {
  expectError(withRoute({ name: 'a', when: 'issues.opened', prompt: 'Title: {title}' }), 'unknown placeholder "{title}"');
});

test('{request} needs a mentions route', () => {
  expectError(withRoute({ name: 'a', when: 'issue_comment.created', prompt: '{request}' }), '"{request}" only works');
});

test('a mentions route must be maintainer-only', () => {
  expectError(
    withRoute({ name: 'a', when: 'issue_comment.created', if: { mentions: ['claude'] }, prompt: 'x' }),
    'must also say "actor: maintainer"',
  );
  expectError(
    withRoute({ name: 'a', when: 'issue_comment.created', if: { mentions: ['claude'], actor: 'anyone' }, prompt: 'x' }),
    'must also say "actor: maintainer"',
  );
});

test('mentions only work on comments and opened events', () => {
  expectError(
    withRoute({ name: 'a', when: 'issues.labeled', if: { mentions: ['claude'], actor: 'maintainer' }, prompt: 'x' }),
    'only works with a comment event or *.opened',
  );
});

test('mention logins are written without "@"', () => {
  expectError(
    withRoute({ name: 'a', when: 'issue_comment.created', if: { mentions: ['@claude'], actor: 'maintainer' }, prompt: 'x' }),
    'without "@"',
  );
});

test('label only works on labeled events', () => {
  expectError(withRoute({ name: 'a', when: 'issues.opened', if: { label: 'x' }, prompt: 'x' }), 'only works with a *.labeled');
});

test('"*" is only allowed at the end of a label', () => {
  expectError(withRoute({ name: 'a', when: 'issues.opened', if: { has_label: ['*/bug'] }, prompt: 'x' }), 'only have "*" at the end');
  expectError(withRoute({ name: 'a', when: 'issues.opened', if: { has_label: ['*'] }, prompt: 'x' }), 'matches every label');
});

test('edge routes need allow_from naming real routes', () => {
  expectError(withRoute({ name: 'a', when: 'edge', prompt: 'x' }), 'needs a list of routes');
  expectError(withRoute({ name: 'a', when: 'edge', allow_from: ['ghost'], prompt: 'x' }), 'no route named "ghost"');
});

test('allow_from is only for edge routes', () => {
  expectError(withRoute({ name: 'a', when: 'issues.opened', allow_from: ['a'], prompt: 'x' }), 'only an edge route takes allow_from');
});

test('edge routes cannot check the actor', () => {
  const config = baseConfig();
  config.routes[4].if = { actor: 'maintainer' };
  expectError(config, `"actor" can't be used on an edge route`);
});

test('code_repo must look like owner/name', () => {
  expectError(baseConfig({ code_repo: 'just-a-name' }), 'code_repo: must be "owner/name"');
});

test('label patterns match exactly or by prefix, ignoring case', () => {
  assert.equal(labelMatches('state/*', 'State/Ready'), true);
  assert.equal(labelMatches('state/*', 'status/ready'), false);
  assert.equal(labelMatches('bug', 'Bug'), true);
  assert.equal(labelMatches('bug', 'bugfix'), false);
});

test('the example config is valid', (t) => {
  let json;
  try {
    const path = fileURLToPath(new URL('../examples/triage/loop-orchestrator.yml', import.meta.url));
    json = execFileSync('yq', ['-o=json', '.', path], { encoding: 'utf8' });
  } catch {
    t.skip('yq is not installed');
    return;
  }
  assert.deepEqual(validateConfig(JSON.parse(json)), []);
});
