export const HUB = 'acme/tracker';
export const CODE = 'acme/code';

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
export function fakeLookup({ permissions = {}, issues = {}, privateRepos = [], links = {}, labelAges = {} } = {}) {
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
