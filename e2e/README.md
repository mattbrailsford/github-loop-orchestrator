# End-to-end scenarios

`run.mjs` drives the whole loop against a real GitHub repo: it opens issues and PRs, comments as a
maintainer, and checks what the orchestrator did. A scripted stand-in plays the routine (stub
mode), so a run costs nothing and takes a few minutes.

## What a pass proves, and what it doesn't

The stand-in acts out what a route's instruction asks of the shipped skills, as plain GitHub
writes with no AI. A pass proves the orchestrator's part: matching, claims, reactions, the run
limit, CI checks, queued comments, edges, sweeps, and shadow mode.

It doesn't prove the routine follows its instructions. For that, run the same routes with the
real routine now and then (leave `LOOP_MODE` unset and comment by hand). If stub mode passes and
the real routine doesn't, the fault is in the prompt or a skill, not the orchestrator.

The stand-in writes with the workflow's token, so its comments come from `github-actions[bot]`,
and releasing the claim sends no event. It runs the edge and the catch-up itself, in the same
job, where the real routine's writes would start new workflow runs.

## Setting up a sandbox

1. Make a throwaway repo, private is fine, with a `main` branch.
2. Copy `templates/caller.yml` to `.github/workflows/loop.yml` in it.
3. Copy `e2e/loop-orchestrator.yml` to `.github/loop-orchestrator.yml` in it.
4. Create the labels `loop/working` and `loop/limit`, or let the first run create them.

No secrets are needed for stub mode. To try the real routine in the same repo, add
`LOOP_FIRE_URL` and `LOOP_FIRE_TOKEN` as in the README's setup steps.

## Running

```bash
node e2e/run.mjs --repo you/loop-sandbox            # every quick scenario
node e2e/run.mjs --repo you/loop-sandbox --only chain,limit
node e2e/run.mjs --repo you/loop-sandbox --slow     # adds the sweep, about 7 minutes more
```

It uses `GH_TOKEN`, or your `gh` login. It sets the repo variable `LOOP_MODE` to `stub` for the
run and puts back whatever was there after.

| Scenario | What it checks |
|---|---|
| `reply` | A 🤖 comment gets 👀 and 🚀, a reply, and one status comment; the claim comes off |
| `queue` | Two comments in quick succession both run, one after the other |
| `chain` | An edge hands on to the next route, at hop 1, and that run releases the claim |
| `refuse` | A fire that fails gets 😕, gives the claim back, and posts nothing |
| `limit` | The fourth run on one issue is refused with 😕, and `loop/limit` goes on |
| `checks` | A `checks: passed` route ignores a PR whose checks failed, and runs once they pass |
| `shadow` | In shadow mode, a matching comment gets no reaction, label, or reply |
| `sweep` (slow) | A run that dies holding the claim is cleared by a tick once the claim is stale |

A failed scenario leaves its issue open, so you can look at what happened.

## Stand-in hints

Put these in the issue body or the comment:

- `stub: refuse`: the fire fails, as if the routine wouldn't start.
- `stub: silent`: the run starts and does nothing, as if it died. The claim stays on.
