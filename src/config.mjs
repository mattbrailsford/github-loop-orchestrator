import { parseCron } from './cron.mjs';

export const EVENTS = [
  'issues.opened',
  'issues.labeled',
  'issue_comment.created',
  'pull_request.opened',
  'pull_request.labeled',
  'pr_comment.created',
  'edge',
  'schedule',
];

export const PLACEHOLDERS = [
  'repo',
  'tracker_repo',
  'code_repo',
  'code_private',
  'linked_issue',
  'number',
  'kind',
  'route',
  'event',
  'label',
  'actor',
  'actor_role',
  'comment_id',
  'hop',
  'next_hop',
  'request',
  'time',
];

// A scheduled run is about the whole repo, so nothing about one issue, PR, or person applies.
const SCHEDULE_PLACEHOLDERS = new Set(['repo', 'tracker_repo', 'code_repo', 'code_private', 'route', 'event', 'time']);

export const ACTORS = ['maintainer', 'author', 'maintainer_or_author', 'anyone'];

const COMMENT_EVENTS = new Set(['issue_comment.created', 'pr_comment.created']);
const OPENED_EVENTS = new Set(['issues.opened', 'pull_request.opened']);
const LABELED_EVENTS = new Set(['issues.labeled', 'pull_request.labeled']);

const TOP_KEYS = new Set(['version', 'bots', 'routine_login', 'max_hops', 'code_repo', 'claim', 'acknowledge', 'routes']);

export const DEFAULT_CLAIM = { label: 'loop/working', stale_after_minutes: 30 };
export const REACTIONS = ['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'];
export const DEFAULT_ACKNOWLEDGE = 'eyes';
const ROUTE_KEYS = new Set(['name', 'when', 'if', 'prompt', 'allow_from', 'code_repo', 'cron']);
const CONDITION_KEYS = new Set([
  'label',
  'has_label',
  'lacks_label',
  'actor',
  'comment_starts_with',
  'mentions',
  'addressed_with',
  'state',
  'in',
]);
const EDGE_CONDITION_KEYS = new Set(['has_label', 'lacks_label', 'state', 'in']);

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$/;
export const PLACEHOLDER_RE = /\{([A-Za-z_]+)\}/g;

export const DEFAULT_MAX_HOPS = 5;


const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.length > 0);

function checkLabelPattern(pattern, where, errors) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    errors.push(`${where}: a label must be a non-empty string`);
    return;
  }
  const star = pattern.indexOf('*');
  if (star !== -1 && star !== pattern.length - 1) {
    errors.push(`${where}: "${pattern}" may only have "*" at the end`);
  }
  if (pattern === '*') {
    errors.push(`${where}: "*" on its own matches every label; name a prefix, like "status/*"`);
  }
}

function checkConditions(route, where, errors) {
  const cond = route.if;
  if (cond === undefined) return;
  if (route.when === 'schedule') {
    errors.push(`${where}.if: a schedule route takes no conditions; it isn't about one issue or PR`);
    return;
  }
  if (!isObject(cond)) {
    errors.push(`${where}.if: must be a map of conditions`);
    return;
  }
  const allowed = route.when === 'edge' ? EDGE_CONDITION_KEYS : CONDITION_KEYS;
  for (const key of Object.keys(cond)) {
    if (!CONDITION_KEYS.has(key)) errors.push(`${where}.if: unknown condition "${key}"`);
    else if (!allowed.has(key)) errors.push(`${where}.if: "${key}" can't be used on an edge route`);
  }

  if ('label' in cond) {
    if (!LABELED_EVENTS.has(route.when)) errors.push(`${where}.if.label: only works with a *.labeled event`);
    checkLabelPattern(cond.label, `${where}.if.label`, errors);
  }
  for (const key of ['has_label', 'lacks_label']) {
    if (!(key in cond)) continue;
    if (!isStringArray(cond[key])) {
      errors.push(`${where}.if.${key}: must be a list of labels`);
      continue;
    }
    cond[key].forEach((p) => checkLabelPattern(p, `${where}.if.${key}`, errors));
  }
  if ('actor' in cond && !ACTORS.includes(cond.actor)) {
    errors.push(`${where}.if.actor: must be one of ${ACTORS.join(', ')}`);
  }
  if ('comment_starts_with' in cond) {
    if (!COMMENT_EVENTS.has(route.when)) errors.push(`${where}.if.comment_starts_with: only works with a comment event`);
    if (typeof cond.comment_starts_with !== 'string' || cond.comment_starts_with.length === 0) {
      errors.push(`${where}.if.comment_starts_with: must be non-empty text`);
    }
  }
  if ('mentions' in cond) {
    if (!COMMENT_EVENTS.has(route.when) && !OPENED_EVENTS.has(route.when)) {
      errors.push(`${where}.if.mentions: only works with a comment event or *.opened`);
    }
    if (!isStringArray(cond.mentions) || !cond.mentions.every((l) => LOGIN_RE.test(l))) {
      errors.push(`${where}.if.mentions: must be a list of GitHub logins, without "@"`);
    }
    if (cond.actor !== 'maintainer') {
      errors.push(`${where}.if.mentions: a mentions route must also say "actor: maintainer"`);
    }
  }
  if ('addressed_with' in cond) {
    if (!COMMENT_EVENTS.has(route.when) && !OPENED_EVENTS.has(route.when)) {
      errors.push(`${where}.if.addressed_with: only works with a comment event or *.opened`);
    }
    if (!isStringArray(cond.addressed_with) || !cond.addressed_with.every((p) => p.trim().length > 0 && p.length <= 20)) {
      errors.push(`${where}.if.addressed_with: must be a list of short prefixes, like "🤖"`);
    }
    if (cond.actor !== 'maintainer') {
      errors.push(`${where}.if.addressed_with: an addressed_with route must also say "actor: maintainer"`);
    }
    if ('mentions' in cond) {
      errors.push(`${where}.if: use mentions or addressed_with, not both`);
    }
  }
  if ('state' in cond && !['open', 'closed'].includes(cond.state)) {
    errors.push(`${where}.if.state: must be "open" or "closed"`);
  }
  if ('in' in cond && !['tracker', 'code'].includes(cond.in)) {
    errors.push(`${where}.if.in: must be "tracker" or "code"`);
  }
}

function checkPrompt(route, where, errors) {
  if (typeof route.prompt !== 'string' || route.prompt.trim().length === 0) {
    errors.push(`${where}.prompt: required, and must be text`);
    return;
  }
  for (const [, name] of route.prompt.matchAll(PLACEHOLDER_RE)) {
    if (!PLACEHOLDERS.includes(name)) errors.push(`${where}.prompt: unknown placeholder "{${name}}"`);
    else if (route.when === 'schedule' && !SCHEDULE_PLACEHOLDERS.has(name)) {
      errors.push(`${where}.prompt: "{${name}}" is about one issue or PR, so a schedule route can't use it`);
    }
    if (name === 'request' && !(isObject(route.if) && ('mentions' in route.if || 'addressed_with' in route.if))) {
      errors.push(`${where}.prompt: "{request}" only works in a route with a "mentions" or "addressed_with" condition`);
    }
  }
}

export function validateConfig(config) {
  const errors = [];
  if (!isObject(config)) return ['the config must be a map at the top level'];

  for (const key of Object.keys(config)) {
    if (!TOP_KEYS.has(key)) errors.push(`unknown top-level key "${key}"`);
  }
  if (config.version !== 1) errors.push('version: must be 1');
  if ('bots' in config && !(Array.isArray(config.bots) && config.bots.every((b) => typeof b === 'string' && b.length > 0))) {
    errors.push('bots: must be a list of logins');
  }
  if ('max_hops' in config) {
    const m = config.max_hops;
    if (!Number.isInteger(m) || m < 1 || m > 50) errors.push('max_hops: must be a whole number from 1 to 50');
  }
  if ('code_repo' in config && !(typeof config.code_repo === 'string' && REPO_RE.test(config.code_repo))) {
    errors.push('code_repo: must be "owner/name"');
  }
  if ('claim' in config && config.claim !== false) {
    const c = config.claim;
    if (!isObject(c)) errors.push('claim: must be false, or a map with label and stale_after_minutes');
    else {
      for (const key of Object.keys(c)) {
        if (!['label', 'stale_after_minutes'].includes(key)) errors.push(`claim: unknown key "${key}"`);
      }
      if ('label' in c && !(typeof c.label === 'string' && c.label.length > 0 && c.label.length <= 50 && !c.label.includes('*'))) {
        errors.push('claim.label: must be a label name, without "*"');
      }
      if ('stale_after_minutes' in c && !(Number.isInteger(c.stale_after_minutes) && c.stale_after_minutes >= 5 && c.stale_after_minutes <= 1440)) {
        errors.push('claim.stale_after_minutes: must be a whole number from 5 to 1440');
      }
    }
  }
  if ('acknowledge' in config && config.acknowledge !== false && !REACTIONS.includes(config.acknowledge)) {
    errors.push(`acknowledge: must be false or one of ${REACTIONS.join(', ')}`);
  }
  if ('routine_login' in config && !(typeof config.routine_login === 'string' && LOGIN_RE.test(config.routine_login))) {
    errors.push('routine_login: must be the GitHub login the routine posts as, without "@"');
  }

  if (!Array.isArray(config.routes) || config.routes.length === 0) {
    errors.push('routes: must be a list with at least one route');
    return errors;
  }

  const names = new Set();
  config.routes.forEach((route, i) => {
    const where = `routes[${i}]${isObject(route) && typeof route.name === 'string' ? ` (${route.name})` : ''}`;
    if (!isObject(route)) {
      errors.push(`${where}: must be a map`);
      return;
    }
    for (const key of Object.keys(route)) {
      if (key === 'on') errors.push(`${where}: use "when", not "on"; some YAML parsers read a bare "on" as true`);
      else if (!ROUTE_KEYS.has(key)) errors.push(`${where}: unknown key "${key}"`);
    }
    if (typeof route.name !== 'string' || !NAME_RE.test(route.name)) {
      errors.push(`${where}.name: required; lowercase letters, numbers, and dashes`);
    } else if (names.has(route.name)) {
      errors.push(`${where}.name: "${route.name}" is used by another route`);
    } else {
      names.add(route.name);
    }
    if (!EVENTS.includes(route.when)) {
      errors.push(`${where}.when: must be one of ${EVENTS.join(', ')}`);
    }
    if ('code_repo' in route && !(typeof route.code_repo === 'string' && REPO_RE.test(route.code_repo))) {
      errors.push(`${where}.code_repo: must be "owner/name"`);
    }
    if (route.when === 'schedule') {
      try {
        parseCron(route.cron);
      } catch (err) {
        errors.push(`${where}.cron: ${route.cron === undefined ? 'a schedule route needs one, like "0 7 * * 1-5"' : err.message}`);
      }
    } else if ('cron' in route) {
      errors.push(`${where}.cron: only a schedule route takes cron`);
    }
    if (route.when === 'edge') {
      if (!isStringArray(route.allow_from)) errors.push(`${where}.allow_from: an edge route needs a list of routes it accepts edges from`);
    } else if ('allow_from' in route) {
      errors.push(`${where}.allow_from: only an edge route takes allow_from`);
    }
    checkConditions(route, where, errors);
    checkPrompt(route, where, errors);
  });

  config.routes.forEach((route, i) => {
    if (!isObject(route) || !Array.isArray(route.allow_from)) return;
    for (const from of route.allow_from) {
      const source = config.routes.find((r) => isObject(r) && r.name === from);
      if (!source) errors.push(`routes[${i}] (${route.name}).allow_from: no route named "${from}"`);
      else if (source.when === 'schedule') {
        errors.push(`routes[${i}] (${route.name}).allow_from: "${from}" is a schedule route, which has no issue to hand on`);
      }
    }
  });

  return errors;
}

export function labelMatches(pattern, label) {
  const p = pattern.toLowerCase();
  const l = label.toLowerCase();
  return p.endsWith('*') ? l.startsWith(p.slice(0, -1)) : l === p;
}

export function codeReposOf(config) {
  const repos = new Set();
  if (config.code_repo) repos.add(config.code_repo.toLowerCase());
  for (const route of config.routes) if (route.code_repo) repos.add(route.code_repo.toLowerCase());
  return repos;
}

export function claimOf(config) {
  if (config.claim === false) return null;
  return { ...DEFAULT_CLAIM, ...(config.claim ?? {}) };
}

export function acknowledgeOf(config) {
  if (config.acknowledge === false) return null;
  return config.acknowledge ?? DEFAULT_ACKNOWLEDGE;
}
