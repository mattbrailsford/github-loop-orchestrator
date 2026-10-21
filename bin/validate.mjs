#!/usr/bin/env node
// Usage: validate.mjs <config.json>
// Checks a config converted from YAML (yq -o=json). Exit 0 when valid, 2 when not.
import { readFileSync } from 'node:fs';
import { validateConfig } from '../src/config.mjs';

const path = process.argv[2];
if (!path) {
  console.error('usage: validate.mjs <config.json>');
  process.exit(1);
}
const errors = validateConfig(JSON.parse(readFileSync(path, 'utf8')));
if (errors.length === 0) {
  console.log('config is valid');
} else {
  console.error(`config is not valid:\n- ${errors.join('\n- ')}`);
  process.exit(2);
}
