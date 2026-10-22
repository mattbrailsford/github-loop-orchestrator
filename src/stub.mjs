import { normalizeEvent } from './event.mjs';
import { ORCHESTRATOR_LOGIN } from './github.mjs';

// The stand-in routine for stub mode. It acts out what the route's instruction asks of the
// shipped skills, with scripted GitHub writes and no AI, so the loop can be tested for free:
//
// - each /loop-comment posts a reply, and each /loop-comment <key> keeps a living comment;
//   with neither, the run posts one reply, so there's always something to see
// - /loop-edge <route> hands on, and leaves the claim on for the next run
// - otherwise the claim comes off, as the routine's last step
//
// A hint in the issue body or the comment that started the run changes that:
// "stub: refuse" fails the fire, and "stub: silent" starts and does nothing, like a run that died.
//
// It writes with the workflow's token, so its comments come from a bot and start nothing, and
// taking the claim off sends no event. What the real routine would set off by itself, the edge
// and the catch-up after the claim comes off, it hands back as follow-ups for the fire step to run.

const COMMENT_RE = /\/loop-comment(?:[ \t]+([a-z0-9][a-z0-9-]*))?/g;
const EDGE_RE = /\/loop-edge[ \t]+([a-z0-9][a-z0-9-]*)/;

export function parseRunBlock(prompt) {
  const block = prompt.match(/<loop-run>\n([\s\S]*?)\n<\/loop-run>/);
  const out = {};
  for (const line of block ? block[1].split('\n') : []) {
    const i = line.indexOf(': ');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 2);
  }
  return out;
}

// What the route's instruction asks for, read from the prompt before the run block.
export function stubPlan(prompt) {
  const instruction = prompt.split('<loop-run>')[0];
  const keys = [...instruction.matchAll(COMMENT_RE)].map((m) => m[1] ?? null);
  const edge = instruction.match(EDGE_RE)?.[1] ?? null;
  return { comments: keys.length ? [...new Set(keys)] : [null], edge };
}

export function stubRoutine({ lookup, gh, hubRepo, log, now = () => new Date() }) {
  return async (prompt, c) => {
    const run = parseRunBlock(prompt);
    if (!c.item) {
      log(`  [stub] a scheduled run of "${c.route}": nothing to act out`);
      return true;
    }
    const { repo, number } = c.item;
    const item = await lookup.issue(repo, number);
    const comments = (await lookup.commentsWithReactions(repo, number)) ?? [];
    const trigger = c.trigger?.type === 'comment' ? comments.find((x) => x.id === c.trigger.id) : null;
    const hints = `${item?.body ?? ''}\n${trigger?.body ?? ''}`;
    if (/\bstub:\s*refuse\b/i.test(hints)) {
      log('  [stub] refusing to start, as the hint asks');
      return false;
    }
    if (/\bstub:\s*silent\b/i.test(hints)) {
      log('  [stub] started, and does nothing, as the hint asks');
      return true;
    }

    const plan = stubPlan(prompt);
    const hop = Number(run.hop ?? 0);
    const startedBy = run.comment || `${run.event}-${hop}`;
    for (const key of plan.comments) {
      const marker = key ? `<!-- loop:${key} -->` : `<!-- loop:reply:${c.route}:${startedBy} -->`;
      const text = key
        ? `Stub: route "${c.route}" keeps "${key}" up to date (hop ${hop}).`
        : `Stub: a reply from route "${c.route}" (hop ${hop}).`;
      const body = `${marker}\n${text}`;
      const existing = comments.filter((x) => x.login === ORCHESTRATOR_LOGIN && x.body.includes(marker)).at(-1);
      if (existing) await gh.editComment(repo, existing.id, body);
      else await gh.comment(repo, number, body);
      log(`  [stub] ${existing ? 'edited' : 'posted'} ${key ? `"${key}"` : 'a reply'}`);
    }

    if (plan.edge) {
      const event = normalizeEvent(
        'repository_dispatch',
        {
          action: 'loop-edge',
          client_payload: { route: plan.edge, from: c.route, repo, number, hop: hop + 1, sent_at: now().toISOString() },
        },
        hubRepo,
      );
      log(`  [stub] handing on to "${plan.edge}"`);
      return { ok: true, followUp: [{ type: 'event', event }] };
    }
    if (c.claim) {
      await gh.removeLabel(c.claim.repo, c.claim.number, c.claim.label);
      log(`  [stub] released the claim`);
      return { ok: true, followUp: [{ type: 'catch-up', item: { repo, number } }] };
    }
    return true;
  };
}
