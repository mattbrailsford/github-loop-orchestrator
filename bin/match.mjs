#!/usr/bin/env node
// Usage: match.mjs --config <config.json> --event-name <name> --event-path <payload.json> [--hub owner/name]
// Reads GITHUB_REPOSITORY, GH_TOKEN, and GITHUB_OUTPUT from the environment.
// Exit codes: 0 matched or no match, 2 the config is broken, 1 anything else.
import { appendFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { normalizeEvent } from '../src/event.mjs';
import { githubLookup } from '../src/github.mjs';
import { ConfigError, matchEvent } from '../src/match.mjs';

const { values: args } = parseArgs({
  options: {
    config: { type: 'string' },
    'event-name': { type: 'string' },
    'event-path': { type: 'string' },
    hub: { type: 'string', default: '' },
  },
});

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `EOF_${randomBytes(8).toString('hex')}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

try {
  const workflowRepo = process.env.GITHUB_REPOSITORY;
  const hubRepo = args.hub || workflowRepo;
  const config = JSON.parse(readFileSync(args.config, 'utf8'));
  const payload = JSON.parse(readFileSync(args['event-path'], 'utf8'));
  const event = normalizeEvent(args['event-name'], payload, workflowRepo);
  const lookup = githubLookup({ token: process.env.GH_TOKEN, warn: (m) => console.log(`::warning::${m}`) });

  const result = await matchEvent({ config, event, workflowRepo, hubRepo, lookup });
  console.log(result.log);
  setOutput('count', String(result.fires.length));
  setOutput('candidates', JSON.stringify(result.fires));
  setOutput('config', JSON.stringify(config));
} catch (err) {
  if (err instanceof ConfigError) {
    console.log(`::error::${err.message.replaceAll('\n', '%0A')}`);
    process.exit(2);
  }
  console.log(`::error::${err.message}`);
  process.exit(1);
}
