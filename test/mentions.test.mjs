import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRequest, findMention } from '../src/mentions.mjs';

const found = (text) => findMention(text, ['claude']) !== null;

test('a mention anywhere in the text counts', () => {
  assert.equal(found('@claude please look'), true);
  assert.equal(found('Thanks, @claude, have another look.'), true);
  assert.equal(found('Ping @Claude'), true);
});

test('only whole words match', () => {
  assert.equal(found('@claude-fan says hi'), false);
  assert.equal(found('mail me at someone@claude.example'), false);
  assert.equal(found('@claudette'), false);
});

test('quoted lines do not count', () => {
  assert.equal(found('> @claude earlier you said this\nThanks'), false);
  assert.equal(found('  > @claude nested quote'), false);
});

test('fenced and inline code do not count', () => {
  assert.equal(found('```\n@claude in a code block\n```'), false);
  assert.equal(found('~~~\n@claude\n~~~\nafter'), false);
  assert.equal(found('Run `@claude do it` in the shell'), false);
});

test('text after a closed fence counts again', () => {
  assert.equal(found('```\ncode\n```\n@claude now'), true);
});

test('the design doc example captures the right request', () => {
  const comment = [
    '> @claude earlier you said this was a duplicate',
    'Thanks both.',
    '',
    "@claude this isn't a dupe of #41, the stack trace is different. Please triage it again.",
    'Also check the 13.x branch.',
    '',
    '@sam can you confirm the CMS version?',
  ].join('\n');
  assert.deepEqual(extractRequest(comment, ['claude']), {
    text: "this isn't a dupe of #41, the stack trace is different. Please triage it again.\nAlso check the 13.x branch.",
    cut: false,
  });
});

test('a later line starting with the same mention does not stop the request', () => {
  const r = extractRequest('@claude first\n@claude second', ['claude']);
  assert.equal(r.text, 'first\n@claude second');
});

test('quotes and fenced code inside the request are skipped, inline code is kept', () => {
  const r = extractRequest('@claude fix `SaveHandler`\n> quoted\n```\ncode\n```\nthanks', ['claude']);
  assert.equal(r.text, 'fix `SaveHandler`\nthanks');
});

test('a bare mention gives an empty request', () => {
  assert.deepEqual(extractRequest('@claude', ['claude']), { text: '', cut: false });
});

test('leading punctuation after the mention is dropped', () => {
  assert.equal(extractRequest('@claude: please retry', ['claude']).text, 'please retry');
});

test('long requests are cut and flagged', () => {
  const r = extractRequest(`@claude ${'x'.repeat(50)}`, ['claude'], 10);
  assert.deepEqual(r, { text: 'x'.repeat(10), cut: true });
});

test('no mention, no request', () => {
  assert.equal(extractRequest('nothing here', ['claude']), null);
});
