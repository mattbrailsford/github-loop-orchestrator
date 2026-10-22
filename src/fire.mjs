import { claimOf } from './config.mjs';
import { matchEvent } from './match.mjs';

export const SEEN = 'eyes';
export const STARTED = 'rocket';
export const FAILED = 'confused';

// How far before a claim went on to look for comments it may have kept waiting: an event that
// queued behind the run that claimed can be a little older than the claim itself.
export const CATCH_UP_LEAD_MS = 10 * 60 * 1000;
const SWEEP_MAX = 20;
const lower = (s) => (s ?? '').toLowerCase();

// Comments still owed a run, oldest first: seen (👀) or posted while the claim was on, and not
// yet started (🚀) or failed (😕). Bots never count, and neither does a comment whose reactions
// couldn't be read.
export function pendingComments(comments, claimAt) {
  return comments
    .filter((c) => !c.isBot && c.orchestrator)
    .filter((c) => !c.orchestrator.rocket && !c.orchestrator.confused)
    .filter((c) => c.orchestrator.eyes || (claimAt !== null && c.createdAt >= claimAt - CATCH_UP_LEAD_MS))
    .sort((a, b) => a.createdAt - b.createdAt);
}

// The same for a new issue or PR: owed a run if its body was seen, or it was opened while the
// claim was on, and no run started.
export function issueIsPending(item, reactions, claimAt) {
  if (!reactions || item.authorIsBot) return false;
  if (reactions.rocket || reactions.confused) return false;
  return !!reactions.eyes || (claimAt !== null && item.createdAt >= claimAt - CATCH_UP_LEAD_MS);
}

export function replayEvent(item, comment) {
  return {
    when: item.kind === 'pr' ? 'pr_comment.created' : 'issue_comment.created',
    kind: item.kind,
    repo: item.repo,
    number: item.number,
    author: item.author ?? '',
    labels: item.labels ?? [],
    state: item.state,
    label: '',
    body: '',
    commentId: comment.id,
    commentBody: comment.body,
    actor: comment.login,
    senderIsBot: comment.isBot,
    edge: null,
  };
}

export function replayOpened(item, claimLabel) {
  return {
    when: item.kind === 'pr' ? 'pull_request.opened' : 'issues.opened',
    kind: item.kind,
    repo: item.repo,
    number: item.number,
    author: item.author ?? '',
    labels: (item.labels ?? []).filter((l) => lower(l) !== lower(claimLabel)),
    state: item.state,
    label: '',
    body: item.body ?? '',
    commentId: '',
    commentBody: '',
    actor: item.author ?? '',
    senderIsBot: !!item.authorIsBot,
    edge: null,
  };
}

// Runs what the match step decided, in order. lookup reads GitHub, gh writes the claim label and
// reactions with the workflow's token, fireRoutine starts the routine. Returns whether every
// fire that was attempted went through.
export async function runCandidates({ candidates, config, workflowRepo, hubRepo, lookup, gh, fireRoutine, log, now = Date.now() }) {
  let ok = true;

  async function fire(c) {
    const where = c.item ? `${c.route ?? 'run'} on #${c.item.number}` : `"${c.route}"`;

    let seen = null;
    if (c.trigger) {
      seen = await lookup.orchestratorReactions(c.trigger);
      if (!seen) {
        log(`${where}: couldn't read its reactions, so can't tell whether it already ran; skipped`);
        return;
      }
      if (seen.rocket) {
        log(`${where}: a run already started for this; skipped`);
        return;
      }
    }

    if (c.claim) {
      const item = await lookup.issue(c.claim.repo, c.claim.number);
      const held = (item?.labels ?? []).some((l) => lower(l) === lower(c.claim.label));
      const age = held ? await lookup.labelAge(c.claim.repo, c.claim.number, c.claim.label, now) : null;
      const fresh = held && (age === null || age < c.claim.stale_after_minutes);

      if (c.edge) {
        // An edge comes from the run holding the claim, so a held claim doesn't stop it. But if the
        // claim was taken after the edge was sent, another edge already handed it on: a repeat.
        const claimAt = held ? await lookup.labelAddedAt(c.claim.repo, c.claim.number, c.claim.label) : null;
        if (c.edge.sentAt !== null && claimAt !== null && claimAt > c.edge.sentAt) {
          log(`${where}: this edge was already handed on; skipped as a repeat`);
          return;
        }
        if (c.edge.sentAt === null) log(`${where}: the edge has no sent_at, so a repeat can't be told apart`);
      } else if (fresh) {
        if (c.if_claimed === 'skip') {
          log(`${where}: another run holds the claim; this label route skips while claimed`);
          return;
        }
        if (c.trigger && !seen.eyes) await gh.react(c.trigger, SEEN);
        log(`${where}: another run holds the claim; waiting its turn`);
        return;
      } else if (held) {
        log(`${where}: taking over a claim left for ${Math.round(age)} min`);
      }

      // An edge takes the claim over afresh, so its time marks the handover.
      if (c.edge && held) await gh.removeLabel(c.claim.repo, c.claim.number, c.claim.label);
      if (!(await gh.addLabel(c.claim.repo, c.claim.number, c.claim.label))) {
        log(`${where}: couldn't add the claim label; firing without a claim`);
      }
    }
    const eyes = c.trigger ? seen.eyes ?? (await gh.react(c.trigger, SEEN)) : null;

    if (await fireRoutine(c.prompt)) {
      if (c.trigger) await gh.react(c.trigger, STARTED);
      log(`${where}: fired`);
      return;
    }

    ok = false;
    log(`${where}: couldn't fire the routine`);
    if (c.claim && !c.edge) await gh.removeLabel(c.claim.repo, c.claim.number, c.claim.label);
    if (c.trigger) {
      if (eyes) await gh.unreact(c.trigger, eyes);
      await gh.react(c.trigger, FAILED);
    }
  }

  // Replays the oldest thing still owed a run, through its own route: a new issue first, then
  // comments. Its run claims the item again, and its release brings the next one round.
  async function catchUp(target) {
    const claim = claimOf(config);
    const item = await lookup.issue(target.repo, target.number);
    if (!claim || !item) return;
    const full = { ...item, repo: target.repo, number: target.number };
    const claimAt = await lookup.labelAddedAt(target.repo, target.number, claim.label);

    const replays = [];
    const bodyReactions = await lookup.orchestratorReactions({ type: 'issue', repo: target.repo, number: target.number });
    if (issueIsPending(full, bodyReactions, claimAt)) replays.push({ what: 'the issue itself', event: replayOpened(full, claim.label) });
    const comments = await lookup.commentsWithReactions(target.repo, target.number);
    if (!comments) {
      log(`#${target.number}: couldn't read its comments to catch up`);
    } else {
      for (const c of pendingComments(comments, claimAt)) replays.push({ what: `comment ${c.id}`, event: replayEvent(full, c) });
    }

    for (const { what, event } of replays) {
      const r = await matchEvent({ config, event, workflowRepo, hubRepo, lookup });
      const next = r.fires.find((f) => f.type === 'fire');
      if (next) {
        log(`#${target.number}: ${what} was waiting; replaying it`);
        await fire(next);
        return;
      }
    }
    log(`#${target.number}: nothing was waiting`);
  }

  // One stale claim, cleared in its item's own queue: checked again, removed, then caught up.
  // The label comes off with the workflow's token, which starts no run, so the catch-up is here.
  async function sweepItem(target) {
    const claim = claimOf(config);
    if (!claim) return;
    const age = await lookup.labelAge(target.repo, target.number, claim.label, now);
    const item = await lookup.issue(target.repo, target.number);
    const held = (item?.labels ?? []).some((l) => lower(l) === lower(claim.label));
    if (!held || age === null || age < claim.stale_after_minutes) {
      log(`#${target.number}: the claim is no longer stale; left alone`);
      return;
    }
    log(`#${target.number}: clearing a claim left for ${Math.round(age)} min`);
    await gh.removeLabel(target.repo, target.number, claim.label);
    await catchUp(target);
  }

  for (const c of candidates) {
    if (c.type === 'fire') await fire(c);
    else if (c.type === 'catch-up') await catchUp(c.item);
    else if (c.type === 'sweep-item') await sweepItem(c.item);
  }
  return ok;
}
