# Example: issue triage

A worked example, and the first thing to prove on a real repo. A new issue gets a proposed
triage. A maintainer approves it with a label, or corrects it with a reply. The routine follows.

It assumes two skills in the routine: `/issue-triage`, which classifies an issue, and
`/investigate-bug`, which finds a bug's cause. Use your own; the names only have to match the
route prompts. Everything specific lives here or in those skills: what the labels mean, what
gets posted, and how. The orchestrator only sees the routes in
[`loop-orchestrator.yml`](loop-orchestrator.yml).

## The routes

| Route | Starts when | The routine |
|---|---|---|
| `new-issue` | an issue opens with no `state/*` label | proposes a triage |
| `maintainer-decides` | a maintainer adds a `state/*` label to a drafted issue | finalizes it, for the state they chose |
| `maintainer-corrects` | a maintainer replies on a drafted issue | proposes again, using the reply |
| `maintainer-asks` | a maintainer mentions `@claude` on any other issue | proposes a fresh triage, using what they asked |
| `reporter-replies` | the reporter replies on a drafted or needs-info issue | proposes again, using the new detail |
| `investigate` | an edge from `maintainer-decides`, when the final state is `state/needs-investigation` | investigates, and proposes the result |
| `stale-drafts` | weekday mornings, 07:00 UTC | sends maintainers one reminder about proposals waiting more than 5 days |

Investigating only reads the code and runs it, so that edge runs without a second approval.
Nothing in these routes writes code. `stale-drafts` needs the ticker routine, or GitHub's
timer in a private repo ([`templates/routine.md`](../../templates/routine.md#the-ticker)).

## A separate tracker

By default the issues and code share a repo. If the tracker is its own repo, it becomes the hub:

- Set `code_repo` at the top of the config, and keep the config in the tracker repo.
- Add a caller workflow to the code repo too, pointing `config_repo` at the tracker. Later PR
  routes (review, merge) go in the same config.
- If the code repo has its own issues turned on, add `in: tracker` to the issue routes, so issues
  opened there don't get triaged by mistake.

The prompts pass both repos, so the routine knows where to read the issue and where to read the
code.

**A public tracker with private code** is the case to watch. Triage notes that name files and
the cause's exact line leak private code onto a public issue. Pass `{code_private}` in the
prompts, and have the skills leave paths and code out of public comments when it's `true`.

## Labels

| Label | Means | Set by |
|---|---|---|
| `state/needs-info` | waiting on the reporter | a maintainer, approving a proposal |
| `state/needs-investigation` | looks real, not proven yet | a maintainer, approving a proposal |
| `state/needs-decision` | clear, waiting on a maintainer to agree | a maintainer, approving a proposal |
| `state/blocked` | waiting on something outside the project | a maintainer, approving a proposal |
| `state/ready` | verified and ready to fix | a maintainer, approving a proposal |
| `state/drafted` | the routine proposed a state and is waiting for a maintainer | the routine only |

- An issue has one state label at a time. While it's `state/drafted`, the proposed state lives
  in the comment.
- A maintainer approves by adding the label they agree with. The routine removes
  `state/drafted`.
- An issue with `state/drafted` is never proposed again unless someone replies. That stops the
  same issue being triaged, and paid for, twice.

## The comment

One comment per issue, found again by a hidden marker, and edited in place so the reporter isn't
notified every time it changes.

While it's a proposal:

```markdown
<!-- loop: triage -->
> **Automated first look.** A maintainer will check this and may change it.

**Proposed:** needs investigation

Thanks for the report. It looks like a real problem, and we'll look into it. We haven't
confirmed the cause yet.

<details><summary>Notes for the investigation</summary>

- **Symptom:** ...
- **Likely area:** ...
- **Start with:** ...

</details>
```

Once finalized, the quoted line and the "Proposed" line go.

- **A plain part for the reporter,** then folded notes for whoever picks the issue up next.
- **Questions wait for approval.** A `state/needs-info` proposal lists what's missing in the
  notes, but asks the reporter nothing until a maintainer approves. A wrong question sends the
  reporter off to dig for nothing.
- **A security report gets nothing on the issue.** No comment, no label. The routine sends
  maintainers a private notification instead ([below](#security-flags)).

## Claiming an issue

A second event on the same issue can start a second run while the first is still working. Each
run claims the issue as its first real step, so the second one's re-check sees the claim and
stops.

| Route | Claim, done first | Why a second run stops |
|---|---|---|
| `new-issue` | add `state/drafted`, right after the security check | the route needs no `state/*` label |
| `maintainer-decides` | remove `state/drafted` | the route needs `state/drafted` |
| `maintainer-corrects`, `maintainer-asks`, `reporter-replies` | none | a second run only edits the same one comment again, so it costs tokens but posts nothing new |
| `investigate` | none | an edge fires once, from `maintainer-decides` |

The security check comes before the claim on purpose. Claiming first would put a label on a
possible security report.

## Security flags

When triage or investigation flags a possible security report, the routine:

- posts nothing and sets no label on the issue,
- calls `/loop-notify` as private, with the issue link and the words "possible security report,
  please check", nothing more,
- and stops.

Private means it never falls back to a public comment, even if push isn't available. With no
label, the issue stays looking untriaged, so a maintainer opening the tracker sees it again.
That covers the rare case where push was unavailable.

## How a maintainer answers

| To | Do this |
|---|---|
| Approve | add the proposed `state/*` label |
| Choose another state | add a different `state/*` label |
| Correct it | reply in plain words ("dupe of #41", "this is expected") |
| Close it | close the issue; no route matches a closed issue's events |
| Leave it | nothing; it waits as `state/drafted` |

## What the skills need to support

Triage skills built for a chat expect a person to answer questions and approve each write. To
run from these routes, they need:

1. **`--unattended`:** no questions, one issue per run, and a clean stop when something only a
   person could supply is missing.
2. **`--propose` and `--finalize`:** the approval moves from the chat to the tracker.
   `--propose` posts the marked comment and `state/drafted`. `--finalize` applies the label a
   maintainer chose, and rewrites the comment for it.
3. **The same two flags on the investigation skill,** so its result is proposed the same way.
4. **Claim first** in `--propose` and `--finalize`, as [Claiming an issue](#claiming-an-issue)
   says, after the security check and before any other work.
5. **A private notification for security flags,** through `/loop-notify`, in place of telling
   someone in the chat. Without it, an unattended run has no private way to tell anyone, so it
   stops and leaves the issue unlabeled.
6. **Respecting `{code_private}`:** no file paths or code in public comments when it's `true`.
7. **Tests** for each: an unattended run asks no questions, `--propose` never sets a final state,
   the claim comes before the work, and a security report gets no label.

Firing the `investigate` edge is in the route's prompt, not the skill. The skill doesn't need to
know what runs next.

## The routine

- Gets its skills from `templates/cloud-setup.sh`: list the repo holding your triage skills in
  `SKILL_SOURCES`. They copy cleanly if they don't rely on plugin hooks or
  `CLAUDE_PLUGIN_ROOT`, and call each other by bare name. The setup log warns otherwise.
- Can build and run the product for investigations, through a stack in the stub. For an Umbraco
  package, `stacks/umbraco/setup.sh`, after which a session starts the site with
  `~/.loop/run-umbraco.sh`.
- Is set up from [`templates/routine.md`](../../templates/routine.md), with `PushNotification`
  in its tools for `/loop-notify`.
- Has GitHub access to read issues, post comments, set labels, and send `repository_dispatch`.
  Nothing else: no push, no merge.
- **Hardening, optional:** have the skill write its proposal to a file, and a small script post
  it, so the model itself has no GitHub write tools. Anyone can write issue text, and a model
  that can't post can't be steered into posting.

## What "it works" means

- [ ] A new issue gets `state/drafted` and one marked comment within a few minutes.
- [ ] Adding the proposed label edits that comment and removes `state/drafted`. No new comment.
- [ ] Adding a different label rewrites the comment for that state.
- [ ] A maintainer's reply ("duplicate of #1") rewrites the comment to say so.
- [ ] A reply from someone who is neither a maintainer nor the reporter starts nothing.
- [ ] The routine's own comments and labels start nothing.
- [ ] Approving `state/needs-investigation` starts the investigation through the edge.
- [ ] A test issue that reads like a security report gets no comment and no label, and
      maintainers get one push notification, even if two events fire for it.
- [ ] Two quick labels on one drafted issue produce one finalize, not two.

## Before a real tracker

**Review before sending.** If your organization requires a human review of external-facing
text before it goes out, check whether a clearly marked proposal comment meets that before
running this on a public tracker.
