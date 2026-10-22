import { REPO_RE } from './config.mjs';

const labelNames = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);

function base(payload) {
  const sender = payload.sender ?? {};
  return {
    actor: sender.login ?? '',
    senderIsBot: sender.type === 'Bot',
    label: '',
    body: '',
    commentId: '',
    commentBody: '',
    edge: null,
  };
}

function fromItem(payload, item, kind, when) {
  return {
    ...base(payload),
    when,
    kind,
    repo: payload.repository.full_name,
    number: item.number,
    author: item.user?.login ?? '',
    labels: labelNames(item.labels),
    state: item.state,
    label: payload.label?.name ?? '',
    body: when.endsWith('.opened') ? item.body ?? '' : '',
  };
}

// A scheduled run from either source: GitHub's own timer, or a loop-tick from a ticker routine.
function scheduled(workflowRepo, now, source) {
  return {
    when: 'schedule',
    kind: null,
    repo: workflowRepo,
    number: null,
    author: '',
    labels: [],
    state: null,
    actor: '',
    senderIsBot: false,
    label: '',
    body: '',
    commentId: '',
    commentBody: '',
    edge: null,
    time: now,
    source,
  };
}

// Turns a GitHub event into the one shape the matcher reads. null means "not an event we route".
export function normalizeEvent(eventName, payload, workflowRepo, now = new Date()) {
  const name = eventName === 'pull_request_target' ? 'pull_request' : eventName;

  if (name === 'schedule') return scheduled(workflowRepo, now, 'github-schedule');
  if (name === 'repository_dispatch' && payload.action === 'loop-tick') return scheduled(workflowRepo, now, 'tick');

  if (name === 'issues') {
    if (payload.action === 'unlabeled') return { ...fromItem(payload, payload.issue, 'issue', 'released'), source: 'issues' };
    if (!['opened', 'labeled'].includes(payload.action)) return null;
    return fromItem(payload, payload.issue, 'issue', `issues.${payload.action}`);
  }

  if (name === 'pull_request') {
    if (payload.action === 'unlabeled') {
      return { ...fromItem(payload, payload.pull_request, 'pr', 'released'), source: 'pull_request' };
    }
    if (!['opened', 'labeled'].includes(payload.action)) return null;
    return fromItem(payload, payload.pull_request, 'pr', `pull_request.${payload.action}`);
  }

  if (name === 'issue_comment') {
    if (payload.action !== 'created') return null;
    const kind = payload.issue.pull_request ? 'pr' : 'issue';
    const event = fromItem(payload, payload.issue, kind, kind === 'pr' ? 'pr_comment.created' : 'issue_comment.created');
    event.commentId = String(payload.comment.id);
    event.commentBody = payload.comment.body ?? '';
    event.actor = payload.comment.user?.login ?? event.actor;
    event.senderIsBot = event.senderIsBot || payload.comment.user?.type === 'Bot';
    return event;
  }

  if (name === 'repository_dispatch') {
    if (payload.action !== 'loop-edge') return null;
    const cp = payload.client_payload ?? {};
    const repo = cp.repo ?? workflowRepo;
    const number = Number(cp.number);
    const hop = Number(cp.hop);
    if (
      typeof cp.route !== 'string' ||
      typeof cp.from !== 'string' ||
      !REPO_RE.test(repo) ||
      !Number.isInteger(number) ||
      number < 1 ||
      !Number.isInteger(hop) ||
      hop < 1
    ) {
      return { invalid: 'a loop-edge needs route, from, number, and a hop of 1 or more' };
    }
    const sentAt = typeof cp.sent_at === 'string' ? Date.parse(cp.sent_at) : NaN;
    return {
      ...base(payload),
      when: 'edge',
      kind: null,
      repo,
      number,
      author: '',
      labels: null,
      state: null,
      actor: '',
      senderIsBot: false,
      edge: { route: cp.route, from: cp.from, hop, sentAt: Number.isFinite(sentAt) ? sentAt : null },
    };
  }

  return null;
}
