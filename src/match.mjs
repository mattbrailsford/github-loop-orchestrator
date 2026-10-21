import { DEFAULT_MAX_HOPS, codeReposOf, labelMatches, validateConfig } from './config.mjs';
import { cronDue } from './cron.mjs';
import { extractRequest, findMention } from './mentions.mjs';
import { buildPrompt, usesPlaceholder } from './prompt.mjs';

export class ConfigError extends Error {
  constructor(errors) {
    super(`the config is not valid:\n- ${errors.join('\n- ')}`);
    this.errors = errors;
  }
}

const WRITE_LEVELS = new Set(['admin', 'maintain', 'write']);
const none = (log) => ({ route: null, prompt: '', fires: [], log });
const one = (route, prompt, log) => ({ route, prompt, fires: [{ route, prompt }], log });

export function hourStamp(date) {
  return `${date.toISOString().slice(0, 13)}:00Z`;
}
const lower = (s) => (s ?? '').toLowerCase();

// lookup is how the matcher reaches GitHub; see github.mjs. Tests pass a fake.
export async function matchEvent({ config, event, workflowRepo, hubRepo, lookup }) {
  const errors = validateConfig(config);
  if (errors.length > 0) throw new ConfigError(errors);

  if (!event) return none('not an event any route can match');
  if (event.invalid) return none(`ignored a loop-edge: ${event.invalid}`);

  const hub = lower(hubRepo);
  const codeRepos = codeReposOf(config);
  const allowed = new Set([hub, ...codeRepos]);
  const eventRepo = lower(event.repo);
  const fromHub = eventRepo === hub;
  const tellNumber = (text) => (fromHub ? `${text} (#${event.number})` : text);

  if (!allowed.has(lower(workflowRepo))) {
    return none('this repo is not listed in the hub config, so its events are ignored');
  }
  if (!allowed.has(eventRepo)) {
    return none('the event is about a repo the hub config does not list');
  }

  if (event.when !== 'edge' && event.when !== 'schedule') {
    const bots = new Set((config.bots ?? []).map(lower));
    if (event.senderIsBot || bots.has(lower(event.actor))) return none('the event came from a bot');
  }

  // Every due route fires, so two schedules that share an hour both run.
  if (event.when === 'schedule') {
    if (lower(workflowRepo) !== hub) return none('a schedule must run in the hub repo');
    const stamp = hourStamp(event.time);
    const due = config.routes.filter((r) => r.when === 'schedule' && cronDue(r.cron, event.time));
    if (due.length === 0) return none(`no schedule route is due at ${stamp}`);
    const fires = [];
    for (const route of due) {
      const codeRepo = route.code_repo ?? config.code_repo ?? hubRepo;
      const needsPrivacy = usesPlaceholder(route.prompt, 'code_private');
      const values = {
        repo: hubRepo,
        tracker_repo: hubRepo,
        code_repo: codeRepo,
        code_private: String(needsPrivacy ? await lookup.isPrivate(codeRepo) : false),
        route: route.name,
        event: 'schedule',
        time: stamp,
      };
      fires.push({ route: route.name, prompt: buildPrompt(route.prompt, values, null, { scheduled: true }) });
    }
    return {
      route: fires[0].route,
      prompt: fires[0].prompt,
      fires,
      log: `due at ${stamp} (${event.source}): ${fires.map((f) => `"${f.route}"`).join(', ')}`,
    };
  }

  let candidates = config.routes;
  if (event.when === 'edge') {
    if (lower(workflowRepo) !== hub) return none('an edge must be sent to the hub repo');
    const target = config.routes.find((r) => r.name === event.edge.route);
    if (!target || target.when !== 'edge') return none(`edge to "${event.edge.route}": no edge route by that name`);
    if (!target.allow_from.includes(event.edge.from)) {
      return none(`edge to "${target.name}": not allowed from "${event.edge.from}"`);
    }
    const max = config.max_hops ?? DEFAULT_MAX_HOPS;
    if (event.edge.hop > max) return none(tellNumber(`edge to "${target.name}": hop ${event.edge.hop} is over the cap of ${max}`));
    const item = await lookup.issue(event.repo, event.number);
    if (!item) return none('edge: could not read the issue or PR it points at');
    Object.assign(event, item);
    candidates = [target];
  }

  // One repo plays both parts when no code_repo is set.
  const inTracker = fromHub;
  const inCode = !fromHub || codeRepos.size === 0 || codeRepos.has(hub);

  let role = null;
  const getRole = async () => {
    if (role) return role;
    const permission = event.actor ? await lookup.permission(event.repo, event.actor) : 'none';
    const maintainer = WRITE_LEVELS.has(permission);
    const author = event.actor !== '' && lower(event.actor) === lower(event.author);
    role = { maintainer, author, name: maintainer ? 'maintainer' : author ? 'author' : 'other' };
    return role;
  };

  const mentionText = () => (event.when.endsWith('.opened') ? event.body : event.commentBody);

  for (const route of candidates) {
    if (route.when !== event.when) continue;
    const c = route.if ?? {};

    if ('label' in c && !labelMatches(c.label, event.label)) continue;
    if ('has_label' in c && !event.labels.some((l) => c.has_label.some((p) => labelMatches(p, l)))) continue;
    if ('lacks_label' in c && event.labels.some((l) => c.lacks_label.some((p) => labelMatches(p, l)))) continue;
    if ('state' in c && event.state !== c.state) continue;
    if ('in' in c && !(c.in === 'tracker' ? inTracker : inCode)) continue;
    if ('comment_starts_with' in c && !event.commentBody.trimStart().startsWith(c.comment_starts_with)) continue;
    if ('mentions' in c && !findMention(mentionText(), c.mentions)) continue;
    if ('actor' in c && c.actor !== 'anyone') {
      const r = await getRole();
      const ok =
        c.actor === 'maintainer' ? r.maintainer : c.actor === 'author' ? r.author : r.maintainer || r.author;
      if (!ok) continue;
    }

    const codeRepo = fromHub ? route.code_repo ?? config.code_repo ?? event.repo : event.repo;
    const needsPrivacy = usesPlaceholder(route.prompt, 'code_private') || lower(codeRepo) !== hub;
    const codePrivate = needsPrivacy ? await lookup.isPrivate(codeRepo) : false;
    const linkedIssue =
      event.kind === 'pr' && usesPlaceholder(route.prompt, 'linked_issue')
        ? await lookup.linkedIssue(event.repo, event.number)
        : '';
    const actorRole =
      event.when === 'edge' ? '' : usesPlaceholder(route.prompt, 'actor_role') ? (await getRole()).name : '';
    const hop = event.edge?.hop ?? 0;

    const values = {
      repo: event.repo,
      tracker_repo: hubRepo,
      code_repo: codeRepo,
      code_private: String(codePrivate),
      linked_issue: linkedIssue,
      number: event.number,
      kind: event.kind,
      route: route.name,
      event: event.when,
      label: event.label,
      actor: event.actor,
      actor_role: actorRole,
      comment_id: event.commentId,
      hop,
      next_hop: hop + 1,
    };
    const request = 'mentions' in c ? extractRequest(mentionText(), c.mentions) : null;

    return one(route.name, buildPrompt(route.prompt, values, request), tellNumber(`matched route "${route.name}"`));
  }

  return none(tellNumber(`no route matched ${event.when}`));
}
