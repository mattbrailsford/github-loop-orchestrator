#!/usr/bin/env node
// Usage: fire.mjs --candidates <file> --config <file> [--hub owner/name]
// Runs the match step's candidates one at a time: checks and adds the claim, reacts, fires the
// routine, and catches up on comments left waiting. The workflow runs it one item at a time.
// Reads GITHUB_REPOSITORY, GH_TOKEN, LOOP_FIRE_URL, and LOOP_FIRE_TOKEN from the environment.
// Exit codes: 0 done, 1 a fire failed or something broke.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runCandidates } from '../src/fire.mjs';
import { githubLookup, githubWriter, routineFirer } from '../src/github.mjs';

const { values: args } = parseArgs({
  options: {
    candidates: { type: 'string' },
    config: { type: 'string' },
    hub: { type: 'string', default: '' },
  },
});

const warn = (m) => console.log(`::warning::${m}`);
try {
  const workflowRepo = process.env.GITHUB_REPOSITORY;
  const hubRepo = args.hub || workflowRepo;
  if (!process.env.LOOP_FIRE_URL || !process.env.LOOP_FIRE_TOKEN) {
    throw new Error('LOOP_FIRE_URL or LOOP_FIRE_TOKEN is not set on this repo');
  }
  const ok = await runCandidates({
    candidates: JSON.parse(readFileSync(args.candidates, 'utf8')),
    config: JSON.parse(readFileSync(args.config, 'utf8')),
    workflowRepo,
    hubRepo,
    lookup: githubLookup({ token: process.env.GH_TOKEN, warn }),
    gh: githubWriter({ token: process.env.GH_TOKEN, warn }),
    fireRoutine: routineFirer({ url: process.env.LOOP_FIRE_URL, token: process.env.LOOP_FIRE_TOKEN }),
    log: (m) => console.log(m),
  });
  if (!ok) process.exit(1);
} catch (err) {
  console.log(`::error::${err.message}`);
  process.exit(1);
}
