#!/usr/bin/env node
// Usage: fire.mjs --candidates <file> --config <file> [--hub owner/name] [--mode live|shadow|stub]
// Runs the match step's candidates one at a time: checks and adds the claim, reacts, fires the
// routine, and catches up on comments left waiting. The workflow runs it one item at a time.
// --mode overrides the config's mode. Reads GITHUB_REPOSITORY, GITHUB_RUN_ID, GH_TOKEN,
// LOOP_FIRE_URL, and LOOP_FIRE_TOKEN from the environment; shadow and stub need no fire secrets.
// Exit codes: 0 done, 1 a fire failed or something broke.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { MODES, modeOf } from '../src/config.mjs';
import { runCandidates, shadowFirer, shadowWriter } from '../src/fire.mjs';
import { githubLookup, githubWriter, routineFirer } from '../src/github.mjs';
import { stubRoutine } from '../src/stub.mjs';

const { values: args } = parseArgs({
  options: {
    candidates: { type: 'string' },
    config: { type: 'string' },
    hub: { type: 'string', default: '' },
    mode: { type: 'string', default: '' },
  },
});

const warn = (m) => console.log(`::warning::${m}`);
try {
  const workflowRepo = process.env.GITHUB_REPOSITORY;
  const hubRepo = args.hub || workflowRepo;
  const config = JSON.parse(readFileSync(args.config, 'utf8'));
  if (args.mode && !MODES.includes(args.mode)) throw new Error(`LOOP_MODE must be one of ${MODES.join(', ')}, not "${args.mode}"`);
  const mode = modeOf(config, args.mode);
  const log = (m) => console.log(m);
  const lookup = githubLookup({ token: process.env.GH_TOKEN, warn, runRepo: workflowRepo, runId: process.env.GITHUB_RUN_ID ?? '' });
  let gh = githubWriter({ token: process.env.GH_TOKEN, warn });
  let fireRoutine;
  if (mode === 'shadow') {
    log('shadow mode: deciding only; nothing is written and no routine is started');
    gh = shadowWriter(log);
    fireRoutine = shadowFirer(log);
  } else if (mode === 'stub') {
    log('stub mode: a scripted stand-in acts the routine out');
    fireRoutine = stubRoutine({ lookup, gh, hubRepo, log });
  } else {
    if (!process.env.LOOP_FIRE_URL || !process.env.LOOP_FIRE_TOKEN) {
      throw new Error('LOOP_FIRE_URL or LOOP_FIRE_TOKEN is not set on this repo');
    }
    fireRoutine = routineFirer({ url: process.env.LOOP_FIRE_URL, token: process.env.LOOP_FIRE_TOKEN });
  }
  const ok = await runCandidates({
    candidates: JSON.parse(readFileSync(args.candidates, 'utf8')),
    config,
    workflowRepo,
    hubRepo,
    lookup,
    gh,
    fireRoutine,
    log,
  });
  if (!ok) process.exit(1);
} catch (err) {
  console.log(`::error::${err.message}`);
  process.exit(1);
}
