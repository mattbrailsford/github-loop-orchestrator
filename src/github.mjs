// The workflow's own account. Its reactions are the record of what's been seen and started;
// a person adding the same emoji doesn't count.
export const ORCHESTRATOR_LOGIN = 'github-actions[bot]';

function reactionsPath(trigger) {
  return trigger.type === 'comment'
    ? `/repos/${trigger.repo}/issues/comments/${trigger.id}/reactions`
    : `/repos/${trigger.repo}/issues/${trigger.number}/reactions`;
}

function headersFor(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-loop-orchestrator',
  };
}

// Every call fails closed: an error means "not a maintainer", "private", or "no link".
export function githubLookup({ token, apiUrl = 'https://api.github.com', warn = console.warn }) {
  const headers = headersFor(token);

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
        authorIsBot: item.user?.type === 'Bot',
        body: item.body ?? '',
        createdAt: Date.parse(item.created_at),
      };
    },

    // Minutes since the label was last added, from the item's events. null when it can't tell.
    async labelAge(repo, number, label, now = Date.now()) {
      const at = await this.labelAddedAt(repo, number, label);
      return at === null ? null : (now - at) / 60000;
    },

    // When the label was last added, in ms since the epoch. null when it can't tell.
    async labelAddedAt(repo, number, label) {
      const first = await fetch(`${apiUrl}/repos/${repo}/issues/${number}/events?per_page=100`, { headers });
      if (!first.ok) return null;
      let events = await first.json();
      const last = (first.headers.get('link') ?? '').match(/<([^>]+)>;\s*rel="last"/);
      if (last) {
        const page = await fetch(last[1], { headers });
        if (page.ok) events = events.concat(await page.json());
      }
      const added = events
        .filter((e) => e.event === 'labeled' && (e.label?.name ?? '').toLowerCase() === label.toLowerCase())
        .map((e) => Date.parse(e.created_at))
        .filter(Number.isFinite);
      if (added.length === 0) return null;
      return Math.max(...added);
    },

    // The workflow's own 👀, 🚀, and 😕 on a comment or an issue body, as reaction IDs. null when
    // they can't be read, which callers treat as "don't know, so don't fire".
    async orchestratorReactions(trigger) {
      const r = await get(`${reactionsPath(trigger)}?per_page=100`);
      if (!r.ok) return null;
      const mine = r.body.filter((x) => x.user?.login === ORCHESTRATOR_LOGIN);
      const id = (content) => mine.find((x) => x.content === content)?.id ?? null;
      return { eyes: id('eyes'), rocket: id('rocket'), confused: id('confused') };
    },

    // The item's comments, oldest first, up to a few hundred, each with the workflow's reactions.
    async commentsWithReactions(repo, number) {
      const all = [];
      for (let page = 1; page <= 3; page++) {
        const r = await get(`/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
        if (!r.ok) return page === 1 ? null : all;
        all.push(...r.body);
        if (r.body.length < 100) break;
      }
      const out = [];
      for (const c of all) {
        const counts = c.reactions ?? {};
        const any = (counts.eyes ?? 0) + (counts.rocket ?? 0) + (counts.confused ?? 0) > 0;
        const orchestrator = any
          ? await this.orchestratorReactions({ type: 'comment', repo, id: String(c.id) })
          : { eyes: null, rocket: null, confused: null };
        out.push({
          id: String(c.id),
          body: c.body ?? '',
          login: c.user?.login ?? '',
          isBot: c.user?.type === 'Bot',
          createdAt: Date.parse(c.created_at),
          orchestrator,
        });
      }
      return out;
    },

    // Open issues and PRs carrying the label.
    async claimedItems(repo, label) {
      const r = await get(`/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=100`);
      return r.ok ? r.body.map((i) => i.number) : [];
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

// Writes made with the workflow's own token: the claim label and reactions. GitHub starts no
// workflow run from them, so none of these can set the loop off.
export function githubWriter({ token, apiUrl = 'https://api.github.com', warn = console.warn }) {
  const headers = { ...headersFor(token), 'Content-Type': 'application/json' };
  const send = (method, path, body) =>
    fetch(`${apiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);

  return {
    async addLabel(repo, number, label) {
      const res = await send('POST', `/repos/${repo}/issues/${number}/labels`, { labels: [label] });
      if (!res?.ok) warn(`couldn't add the label "${label}" (HTTP ${res?.status ?? 'none'})`);
      return !!res?.ok;
    },
    async removeLabel(repo, number, label) {
      const res = await send('DELETE', `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
      const ok = !!res && (res.ok || res.status === 404);
      if (!ok) warn(`couldn't remove the label "${label}" (HTTP ${res?.status ?? 'none'})`);
      return ok;
    },
    async react(trigger, content) {
      const res = await send('POST', reactionsPath(trigger), { content });
      if (!res?.ok) {
        warn(`couldn't add a ${content} reaction (HTTP ${res?.status ?? 'none'})`);
        return null;
      }
      return (await res.json()).id ?? null;
    },
    async unreact(trigger, id) {
      const res = await send('DELETE', `${reactionsPath(trigger)}/${id}`);
      return !!res?.ok;
    },
  };
}

// Starts the routine with one prompt. Retries a few times on a network or server error.
export function routineFirer({ url, token, attempts = 3, delayMs = 5000 }) {
  return async (prompt) => {
    for (let i = 0; i < attempts; i++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'experimental-cc-routine-2026-04-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: prompt }),
      }).catch(() => null);
      if (res?.ok) return true;
      if (res && res.status < 500 && res.status !== 429) return false;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
  };
}
