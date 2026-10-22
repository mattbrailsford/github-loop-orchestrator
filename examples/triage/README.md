# Example: issue triage

A worked example, and the first thing to prove on a real repo. A new issue gets a proposed
triage. A maintainer answers with a comment that starts with 🤖, to approve it, pick another
state, or correct it. The routine follows.

It assumes two skills in the routine: `/issue-triage`, which classifies an issue, and
`/investigate-bug`, which finds a bug's cause. Use your own; the names only have to match the
route prompts. Everything specific lives here or in those skills: what the labels mean, what
gets posted, and how. The orchestrator only sees the routes in
[`loop-orchestrator.yml`](loop-orchestrator.yml).

## The routes

| Route | Starts when | The routine |
|---|---|---|
| `new-issue` | an issue opens with no `state/*` label | proposes a triage |
| `maintainer-says` | a maintainer comments starting with 🤖 | does what they asked: approves, picks another state, corrects, or looks again |
| `reporter-replies` | the reporter replies on a drafted or needs-info issue | proposes again, using the new detail |
| `investigate` | an edge from `maintainer-says`, when the issue ends in `state/needs-investigation` | investigates, and proposes the result |
| `stale-drafts` | weekday mornings, 07:00 UTC | sends maintainers one reminder about proposals waiting more than 5 days |

Investigating only reads the code and runs it, so that edge runs without a second approval.
Nothing in these routes writes code. `stale-drafts` needs the ticker routine, or GitHub's
timer in a private repo ([`templates/routine.md`](../../templates/routine.md#the-ticker)).

## Talking to the routine

The routine posts with a person's account, usually the maintainer's own, through the Claude
GitHub app. So the orchestrator can't tell its comments and labels from that person's by who
made them. This example works around that:

- **A maintainer starts a comment with 🤖 to address the routine.** Nothing else from that
  account counts. `routine_login` in the config names the account.
- **The routine never starts a comment with 🤖**, so its own comments start nothing.
- **Labels are outputs only.** The routine sets them, and no route starts from a label, so its
  own label changes can't start anything either.
- **Typos are fine.** The orchestrator only checks for 🤖. Everything after it goes to the
  routine as the request, and the model reads it: "🤖 aprove" works.
- **The routine says what it understood.** It updates the proposal comment ("Approved as needs
  investigation"), so a misread shows straight away, and another 🤖 comment fixes it.

One side effect: an issue opened from the routine's account isn't triaged on its own, since
that account's events only count when addressed. Start its body with 🤖 to have it triaged.

If the routine later gets its own account or GitHub App, set `routine_login` to that, and
nothing else here needs to change ([`docs/IDENTITY.md`](../../docs/IDENTITY.md)).

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
| `state/needs-info` | waiting on the reporter | the routine, once a maintainer approves |
| `state/needs-investigation` | looks real, not proven yet | the routine, once a maintainer approves |
| `state/needs-decision` | clear, waiting on a maintainer to agree | the routine, once a maintainer approves |
| `state/blocked` | waiting on something outside the project | the routine, once a maintainer approves |
| `state/ready` | verified and ready to fix | the routine, once a maintainer approves |
| `state/drafted` | the routine proposed a state and is waiting for a maintainer | the routine |

- An issue has one state label at a time. While it's `state/drafted`, the proposed state lives
  in the comment.
- A maintainer approves with a 🤖 comment. The routine then swaps `state/drafted` for the
  agreed state. Setting a label by hand does nothing to the loop.
- An issue with `state/drafted` is never proposed again unless someone replies. That stops the
  same issue being triaged, and paid for, twice.

## The comment

One comment per issue, written with `/loop-comment triage`. The skill finds it again by a hidden
marker and edits it in place, so the reporter isn't notified every time it changes, and a write
that errors can't leave two copies.

While it's a proposal:

```markdown
<!-- loop:triage -->
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

The orchestrator claims the issue before firing: it adds `loop/working` (set as `claim.label` in
the config), and no other run starts for that issue until the routine removes it. The routine's
prompt ends with when to remove it. So the skills don't claim anything themselves.

Every `🤖` comment gets reactions from the workflow, within seconds:

- 👀 when it's received. It either starts a run, or waits for the one already working.
- 🚀 when its run starts.
- 😕 if the routine couldn't be started. Comment again to retry.

A comment that waited gets its own run when the claim comes off, through the right route. So two
quick `🤖` comments mean two runs, one after the other. A second `🤖 approve` finds the issue
already approved and does nothing.

`state/drafted` is a different thing: it marks an issue as waiting on a maintainer's answer, and
stays on until they give one.

**On a possible security report**, the claim label is there only while the routine runs. It says
nothing about the issue, and the routine removes it before stopping, so no lasting label is left.

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
| Approve | comment `🤖 approve`, or `🤖 yes`, or anything that means it |
| Choose another state | comment `🤖 needs info`, `🤖 ready`, and so on |
| Correct it | comment in plain words: `🤖 dupe of #41`, `🤖 this is expected behavior` |
| Ask for a fresh look | `🤖 look again, the stack trace is different` |
| Close it | close the issue; no route matches a closed issue's events |
| Leave it | nothing; it waits as `state/drafted` |

A comment without 🤖 is just a comment. The routine never sees it.

## What the skills need to support

Triage skills built for a chat expect a person to answer questions and approve each write. To
run from these routes, they need:

1. **`--unattended`:** no questions, one issue per run, and a clean stop when something only a
   person could supply is missing.
2. **`--propose` and `--respond`:** the approval moves from the chat to the tracker.
   `--propose` posts the marked comment and `state/drafted`. `--respond` reads a maintainer's
   request in plain words, acts on it (approve, another state, a correction, a fresh look), and
   updates the comment to say what it understood.
3. **`--propose` on the investigation skill,** so its result is proposed the same way.
4. **Nothing to claim.** The orchestrator claims the issue and tells the routine when to release
   it ([Claiming an issue](#claiming-an-issue)). The skill only has to add `state/drafted` when
   it proposes.
5. **Never start a comment with 🤖,** which would address the routine itself.
6. **A private notification for security flags,** through `/loop-notify`, in place of telling
   someone in the chat. Without it, an unattended run has no private way to tell anyone, so it
   stops and leaves the issue unlabeled.
7. **Respecting `{code_private}`:** no file paths or code in public comments when it's `true`.
8. **Tests** for each: an unattended run asks no questions, `--propose` never sets a final state,
   `--respond` acts on a misspelled approval, and a security report gets no lasting label.

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
- [ ] `🤖 approve` edits that comment and swaps `state/drafted` for the proposed state. No new
      comment.
- [ ] `🤖 aprove` (misspelled) does the same.
- [ ] `🤖 needs info` rewrites the comment for that state.
- [ ] `🤖 dupe of #1` rewrites the comment to say so.
- [ ] A maintainer comment without 🤖 starts nothing.
- [ ] A 🤖 comment from someone without write access starts nothing.
- [ ] The routine's own comments and labels start nothing, even though they're under your name.
- [ ] Setting a `state/*` label by hand starts nothing.
- [ ] Approving `state/needs-investigation` starts the investigation through the edge.
- [ ] A test issue that reads like a security report gets no comment and no label, and
      maintainers get one push notification, even if two events fire for it.
- [ ] Every `🤖` comment gets 👀 within seconds, then 🚀 when its run starts.
- [ ] Two quick `🤖` comments give two runs, one after the other, never two at once.
- [ ] A run that posts nothing (a security flag) isn't started again when its claim comes off.

## Before a real tracker

**Review before sending.** If your organization requires a human review of external-facing
text before it goes out, check whether a clearly marked proposal comment meets that before
running this on a public tracker.
