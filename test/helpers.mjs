export const HUB = 'acme/tracker';
export const CODE = 'acme/code';
export const T0 = Date.parse('2026-10-21T16:00:00Z');
export const NONE = { eyes: null, rocket: null, confused: null };

export function baseConfig(overrides = {}) {
  return {
    version: 1,
    bots: ['claude[bot]'],
    max_hops: 3,
    routes: [
      {
        name: 'new-issue',
        when: 'issues.opened',
        if: { lacks_label: ['state/*'] },
        prompt: 'Triage {repo}#{number}. Code in {code_repo}. Route: {route}.',
      },
      {
        name: 'maintainer-decides',
        when: 'issues.labeled',
        if_claimed: 'skip',
        if: { label: 'state/*', has_label: ['state/drafted'], actor: 'maintainer' },
        prompt: 'Finalize {number}: {label}. Next hop {next_hop}.',
      },
      {
        name: 'maintainer-asks',
        when: 'issue_comment.created',
        if: { mentions: ['claude'], actor: 'maintainer' },
        prompt: 'Look again at {number}. {request} Route: {route}.',
      },
      {
        name: 'reporter-replies',
        when: 'issue_comment.created',
        if: { has_label: ['state/drafted'], actor: 'author' },
        prompt: 'Reporter replied on {number} in comment {comment_id} ({actor_role}).',
      },
      {
        name: 'investigate',
        when: 'edge',
        allow_from: ['maintainer-decides'],
        prompt: 'Investigate {repo}#{number}, hop {hop}.',
      },
    ],
    ...overrides,
  };
}

// A fake GitHub: permissions by login, issues by "repo#number", private repos by name.
export function fakeLookup({ permissions = {}, issues = {}, privateRepos = [], links = {}, labelAges = {}, claimed = [] } = {}) {
  const calls = [];
  return {
    calls,
    async permission(repo, login) {
      calls.push(['permission', repo, login]);
      return permissions[login] ?? 'none';
    },
    async issue(repo, number) {
      calls.push(['issue', repo, number]);
      return issues[`${repo}#${number}`] ?? null;
    },
    async isPrivate(repo) {
      calls.push(['isPrivate', repo]);
      return privateRepos.includes(repo);
    },
    async labelAge(repo, number, label) {
      calls.push(['labelAge', repo, number, label]);
      return labelAges[`${repo}#${number}:${label}`] ?? null;
    },
    async claimedItems() {
      return claimed;
    },
    async linkedIssue(repo, number) {
      calls.push(['linkedIssue', repo, number]);
      return links[`${repo}#${number}`] ?? '';
    },
  };
}

export function issueEvent(overrides = {}) {
  return {
    when: 'issues.opened',
    kind: 'issue',
    repo: HUB,
    number: 7,
    author: 'reporter',
    labels: [],
    state: 'open',
    label: '',
    body: '',
    commentId: '',
    commentBody: '',
    actor: 'reporter',
    senderIsBot: false,
    edge: null,
    ...overrides,
  };
}

export function commentEvent(body, overrides = {}) {
  return issueEvent({
    when: 'issue_comment.created',
    commentId: '555',
    commentBody: body,
    actor: 'maint',
    ...overrides,
  });
}

// A fake GitHub that keeps labels and reactions, so a test can check what ended up where.
export function world({
  labels = [],
  claimAt = null,
  comments = [],
  reactions = {},
  fireOk = true,
  permissions = { maint: 'admin' },
  item = {},
  unreadable = [],
  removedAt = {},
  checks = 'none',
} = {}) {
  const state = {
    labels: new Set(labels),
    claimAt,
    removedAt: { ...removedAt },
    reactions: structuredClone(reactions),
    comments: structuredClone(comments),
    checks,
    startedAt: {},
    fired: [],
    log: [],
    clock: T0 + 60000,
  };
  const key = (t) => (t.type === 'comment' ? `c${t.id}` : `i${t.number}`);
  const lookup = {
    ...fakeLookup({ permissions }),
    async issue() {
      return { kind: 'issue', labels: [...state.labels], state: 'open', author: 'reporter', body: '', createdAt: T0 - 600 * 60000, ...item };
    },
    async labelAge(repo, number, label, now) {
      return state.labels.has(label) && state.claimAt !== null ? (now - state.claimAt) / 60000 : null;
    },
    async labelAddedAt() {
      return state.claimAt;
    },
    async orchestratorReactions(t) {
      if (unreadable.includes(key(t))) return null;
      return { ...NONE, ...(state.reactions[key(t)] ?? {}) };
    },
    async labelRemovedAt(repo, number, label) {
      return state.removedAt[label] ?? null;
    },
    // Every 🚀 counts at the time it was added; the clock moves on a second per reaction.
    async runsStarted(repo, number, since) {
      if (unreadable.includes('runs')) return null;
      return Object.entries(state.reactions).filter(([k, r]) => r.rocket && (since === null || (state.startedAt[k] ?? 0) > since)).length;
    },
    async checks() {
      return state.checks;
    },
    async commentsWithReactions() {
      return state.comments.map((c) => ({
        ...c,
        orchestrator: unreadable.includes(`c${c.id}`) ? null : { ...NONE, ...(state.reactions[`c${c.id}`] ?? {}) },
      }));
    },
    async claimedItems() {
      return state.labels.has('loop/working') ? [7] : [];
    },
  };
  let nextId = 1;
  const gh = {
    async addLabel(repo, number, label) {
      if (!state.labels.has(label)) state.claimAt = state.clock;
      state.labels.add(label);
      return true;
    },
    async removeLabel(repo, number, label) {
      if (state.labels.has(label)) state.removedAt[label] = state.clock;
      state.labels.delete(label);
      return true;
    },
    async react(t, content) {
      const id = nextId++;
      state.clock += 1000;
      if (content === 'rocket') state.startedAt[key(t)] = state.clock;
      state.reactions[key(t)] = { ...(state.reactions[key(t)] ?? {}), [content]: id };
      return id;
    },
    async unreact(t, id) {
      const r = state.reactions[key(t)] ?? {};
      for (const k of Object.keys(r)) if (r[k] === id) delete r[k];
      return true;
    },
    async comment(repo, number, body) {
      const id = String(1000 + state.comments.length);
      state.comments.push({ id, body, login: 'github-actions[bot]', isBot: true, createdAt: state.clock });
      return id;
    },
    async editComment(repo, id, body) {
      const c = state.comments.find((x) => x.id === id);
      if (c) c.body = body;
      return !!c;
    },
  };
  const fireRoutine = async (prompt) => {
    state.fired.push(prompt);
    return fireOk;
  };
  return { state, lookup, gh, fireRoutine };
}
