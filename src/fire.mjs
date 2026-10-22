import { claimOf, labelMatches, runLimitOf } from './config.mjs';
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

// Whether the item, as it is now, still meets the route's label and state conditions. The claim
// label itself is left out, since it's this step's own bookkeeping.
export function stillMatches(recheck, item, claimLabel) {
  if (!recheck) return true;
  const labels = (item.labels ?? []).filter((l) => !claimLabel || lower(l) !== lower(claimLabel));
  if (recheck.has_label && !labels.some((l) => recheck.has_label.some((p) => labelMatches(p, l)))) return false;
  if (recheck.lacks_label && labels.some((l) => recheck.lacks_label.some((p) => labelMatches(p, l)))) return false;
  if (recheck.state && item.state !== recheck.state) return false;
  return true;
}

// Shadow mode: every write and fire is logged as what it would have been, and nothing is sent.
export function shadowWriter(log) {
  const would = (what) => {
    log(`  [shadow] would ${what}`);
    return true;
  };
  return {
    addLabel: (repo, number, label) => would(`add "${label}" to #${number}`),
    removeLabel: (repo, number, label) => would(`remove "${label}" from #${number}`),
    react: (t, content) => (would(`react ${content} on ${t.type === 'comment' ? `comment ${t.id}` : `#${t.number}`}`), null),
    unreact: () => true,
    comment: () => null,
    editComment: () => true,
  };
}

export function shadowFirer(log) {
  return async (prompt, c) => {
    log(`  [shadow] would fire the routine for "${c.route}" (a ${prompt.length}-character prompt)`);
    return true;
  };
}

// Runs what the match step decided, in order. lookup reads GitHub, gh writes the claim label and
// reactions with the workflow's token, fireRoutine starts the routine. Returns whether every
// fire that was attempted went through.
//
// fireRoutine(prompt, candidate) returns true or false, or { ok, followUp }: what a stand-in
// routine did that the real one would have set off by itself, such as an edge, run here instead.
export async function runCandidates({ candidates, config, workflowRepo, hubRepo, lookup, gh, fireRoutine, log, now = Date.now() }) {
  let ok = true;
  const limit = runLimitOf(config);

  // A trigger that won't get a run: 😕 in place of any 👀, so no catch-up replays it.
  async function refuse(c, seen) {
    if (!c.trigger) return;
    if (seen?.eyes) await gh.unreact(c.trigger, seen.eyes);
    if (!seen?.confused) await gh.react(c.trigger, FAILED);
  }

  async function fire(c) {
    const where = c.item ? `${c.route ?? 'run'} on #${c.item.number}` : `"${c.route}"`;

    let seen = null;
    if (c.trigger) {
      seen = await lookup.orchestratorReactions(c.trigger);
      if (!seen) {
        log(`${where}: couldn't read its reactions, so can't tell whether it already ran; skipped`);
        return 'skipped';
      }
      if (seen.rocket) {
        log(`${where}: a run already started for this; skipped`);
        return 'skipped';
      }
    }

    if (c.item && c.recheck) {
      const current = await lookup.issue(c.item.repo, c.item.number);
      if (current && !stillMatches(c.recheck, current, c.claim?.label)) {
        log(`${where}: the issue has changed since the event and no longer matches the route; skipped`);
        return 'skipped';
      }
      if (c.recheck.checks) {
        const checks = await lookup.checks(c.item.repo, c.item.number);
        if (checks !== c.recheck.checks) {
          log(`${where}: its checks are ${checks ?? 'unreadable'} now, not ${c.recheck.checks}; skipped`);
          return 'skipped';
        }
      }
    }

    // Edges don't count: max_hops already bounds a chain, and stopping one halfway leaves it
    // claimed with nobody to release it.
    if (limit && c.item && !c.edge) {
      const current = await lookup.issue(c.item.repo, c.item.number);
      if ((current?.labels ?? []).some((l) => lower(l) === lower(limit.label))) {
        log(`${where}: "${limit.label}" is on, so no more runs until a person takes it off`);
        await refuse(c, seen);
        return 'limited';
      }
      const since = await lookup.labelRemovedAt(c.item.repo, c.item.number, limit.label);
      const started = await lookup.runsStarted(c.item.repo, c.item.number, since);
      if (started === null) {
        log(`${where}: couldn't count its runs, so can't tell whether it's over the limit; skipped`);
        return 'skipped';
      }
      if (started >= limit.runs) {
        log(`${where}: ${started} runs already, the limit is ${limit.runs}; adding "${limit.label}" for a person to look`);
        await gh.addLabel(c.item.repo, c.item.number, limit.label);
        await refuse(c, seen);
        return 'limited';
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
          return 'skipped';
        }
        if (c.edge.sentAt === null) log(`${where}: the edge has no sent_at, so a repeat can't be told apart`);
      } else if (fresh) {
        if (c.if_claimed === 'skip') {
          log(`${where}: another run holds the claim; this label route skips while claimed`);
          return 'skipped';
        }
        if (c.trigger && !seen.eyes) await gh.react(c.trigger, SEEN);
        log(`${where}: another run holds the claim; waiting its turn`);
        return 'waiting';
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

    const result = await fireRoutine(c.prompt, c);
    if (result === true || result?.ok) {
      if (c.trigger) await gh.react(c.trigger, STARTED);
      log(`${where}: fired`);
      for (const next of result?.followUp ?? []) await followUp(next);
      return 'fired';
    }

    ok = false;
    log(`${where}: couldn't fire the routine`);
    if (c.claim && !c.edge) await gh.removeLabel(c.claim.repo, c.claim.number, c.claim.label);
    if (c.trigger) {
      if (eyes) await gh.unreact(c.trigger, eyes);
      await gh.react(c.trigger, FAILED);
    }
    return 'failed';
  }

  // An event the stand-in routine set off, such as an edge, matched and run here.
  async function followUp(next) {
    if (next.type === 'catch-up') return catchUp(next.item);
    if (next.type !== 'event') return;
    const r = await matchEvent({ config, event: next.event, workflowRepo: hubRepo, hubRepo, lookup });
    log(`  then: ${r.log}`);
    for (const f of r.fires) if (f.type === 'fire') await fire(f);
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

    let replayed = false;
    for (const { what, event } of replays) {
      const r = await matchEvent({ config, event, workflowRepo, hubRepo, lookup });
      const next = r.fires.find((f) => f.type === 'fire');
      if (next) {
        log(`#${target.number}: ${what} was waiting; replaying it`);
        replayed = true;
        // Over the limit, each waiting one is marked 😕 in turn, so none is left owed a run.
        if ((await fire(next)) !== 'limited') return;
      }
    }
    if (!replayed) log(`#${target.number}: nothing was waiting`);
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
    // A closed item has nothing to catch up on; reopening it is a new start.
    if (item.state === 'closed') {
      log(`#${target.number}: it's closed, so nothing is replayed`);
      return;
    }
    await catchUp(target);
  }

  for (const c of candidates) {
    if (c.type === 'fire') await fire(c);
    else if (c.type === 'catch-up') await catchUp(c.item);
    else if (c.type === 'sweep-item') await sweepItem(c.item);
  }
  return ok;
}
