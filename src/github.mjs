// Every call fails closed: an error means "not a maintainer", "private", or "no link".
export function githubLookup({ token, apiUrl = 'https://api.github.com', warn = console.warn }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-loop-orchestrator',
  };

  async function get(path) {
    const res = await fetch(`${apiUrl}${path}`, { headers });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.json() };
  }

  return {
    async permission(repo, login) {
      const r = await get(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
      if (r.ok) return r.body.permission ?? 'none';
      if (r.status !== 404) warn(`could not check write access (HTTP ${r.status}); treating the actor as not a maintainer`);
      return 'none';
    },

    async issue(repo, number) {
      const r = await get(`/repos/${repo}/issues/${number}`);
      if (!r.ok) return null;
      const item = r.body;
      return {
        kind: item.pull_request ? 'pr' : 'issue',
        labels: (item.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
        state: item.state,
        author: item.user?.login ?? '',
      };
    },

    async isPrivate(repo) {
      const r = await get(`/repos/${repo}`);
      if (!r.ok) return true;
      return r.body.private === true;
    },

    async linkedIssue(repo, number) {
      const [owner, name] = repo.split('/');
      const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:1){nodes{number repository{nameWithOwner}}}}}}`;
      const res = await fetch(`${apiUrl}/graphql`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { owner, name, number } }),
      });
      if (!res.ok) return '';
      const body = await res.json();
      const node = body?.data?.repository?.pullRequest?.closingIssuesReferences?.nodes?.[0];
      return node ? `${node.repository.nameWithOwner}#${node.number}` : '';
    },
  };
}
