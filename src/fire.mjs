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
// yet started (🚀) or failed (😕). Bots never count.
export function pendingComments(comments, claimAt) {
  return comments
    .filter((c) => !c.isBot)
    .filter((c) => !c.orchestrator.rocket && !c.orchestrator.confused)
    .filter((c) => c.orchestrator.eyes || (claimAt !== null && c.createdAt >= claimAt - CATCH_UP_LEAD_MS))
    .sort((a, b) => a.createdAt - b.createdAt);
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
      if (seen.rocket) {
        log(`${where}: a run already started for this; skipped`);
        return;
      }
    }

    if (c.claim && !c.edge) {
      const item = await lookup.issue(c.claim.repo, c.claim.number);
      const held = (item?.labels ?? []).some((l) => lower(l) === lower(c.claim.label));
      if (held) {
        const age = await lookup.labelAge(c.claim.repo, c.claim.number, c.claim.label, now);
        if (age === null || age < c.claim.stale_after_minutes) {
          if (c.trigger && !seen.eyes) await gh.react(c.trigger, SEEN);
          log(`${where}: another run holds the claim; waiting its turn`);
          return;
        }
        log(`${where}: taking over a claim left for ${Math.round(age)} min`);
      }
    }

    if (c.claim && !(await gh.addLabel(c.claim.repo, c.claim.number, c.claim.label))) {
      log(`${where}: couldn't add the claim label; firing without a claim`);
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

  // Replays the oldest comment still owed a run through its own route. Its run claims the item
  // again, and its release brings the next one round.
  async function catchUp(target) {
    const claim = claimOf(config);
    const item = await lookup.issue(target.repo, target.number);
    if (!claim || !item) return;
    const claimAt = await lookup.labelAddedAt(target.repo, target.number, claim.label);
    const comments = await lookup.commentsWithReactions(target.repo, target.number);
    if (!comments) {
      log(`#${target.number}: couldn't read its comments to catch up`);
      return;
    }
    const full = { ...item, repo: target.repo, number: target.number };
    for (const comment of pendingComments(comments, claimAt)) {
      const r = await matchEvent({ config, event: replayEvent(full, comment), workflowRepo, hubRepo, lookup });
      const next = r.fires.find((f) => f.type === 'fire');
      if (next) {
        log(`#${target.number}: comment ${comment.id} was waiting; replaying it`);
        await fire(next);
        return;
      }
    }
    log(`#${target.number}: nothing was waiting`);
  }

  // Clears claims a run never released, then gives each item its catch-up. The label comes off
  // with the workflow's token, which starts no new run, so the catch-up happens here.
  async function sweep() {
    const claim = claimOf(config);
    if (!claim) return;
    const numbers = (await lookup.claimedItems(hubRepo, claim.label)).slice(0, SWEEP_MAX);
    for (const number of numbers) {
      const age = await lookup.labelAge(hubRepo, number, claim.label, now);
      if (age === null || age < claim.stale_after_minutes) continue;
      log(`#${number}: clearing a claim left for ${Math.round(age)} min`);
      await gh.removeLabel(hubRepo, number, claim.label);
      await catchUp({ repo: hubRepo, number });
    }
  }

  for (const c of candidates) {
    if (c.type === 'fire') await fire(c);
    else if (c.type === 'catch-up') await catchUp(c.item);
    else if (c.type === 'sweep') await sweep();
  }
  return ok;
}
