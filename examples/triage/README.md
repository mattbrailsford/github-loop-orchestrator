# Example: issue triage

A worked example, and the first thing to prove on a real repo. A new issue gets a proposed
triage. A maintainer answers with a comment that starts with 🤖, to approve it, pick another
state, or correct it. The routine follows.

It uses three skills from [umbraco-devkit](https://github.com/mattbrailsford/umbraco-devkit)
in the routine: `/issue-triage`, which classifies an issue, `/investigate-bug`, which finds a
bug's cause, and `/issue-backlog`, which works through what's left. Use your own; the names and
flags only have to match the route prompts. Everything specific lives here or in those skills: what the labels mean, what
gets posted, and how. The orchestrator only sees the routes in
[`loop-orchestrator.yml`](loop-orchestrator.yml).

## The routes

| Route | Starts when | The routine |
|---|---|---|
| `new-issue` | an issue opens with no `state/*` label | proposes a triage |
| `maintainer-says` | a maintainer comments starting with 🤖 | does what they asked: approves, picks another state, corrects, or looks again |
| `reporter-replies` | the reporter replies on a drafted or needs-info issue | proposes again, using the new detail |
| `investigate` | an edge from `maintainer-says`, when the issue ends in `state/needs-investigation` | investigates, and proposes the result |
| `backlog` | weekday mornings, 06:00 UTC | triages and investigates what the events missed, as proposals |
| `trust-report` | the first of each month, 08:00 UTC | tells maintainers how proposals fared, and whether to auto-apply more outcomes or fewer |
| `stale-drafts` | weekday mornings, 07:00 UTC | sends maintainers one reminder about proposals waiting more than 5 days |

Investigating only reads the code and runs it, so that edge runs without a second approval.
Nothing in these routes writes code. `backlog` and `stale-drafts` need the ticker routine, or GitHub's
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
- **The routine says what it understood.** The proposal's heading changes to "Approved: needs
  investigation · by @you", so a misread shows straight away, and another 🤖 comment fixes it.

One side effect: an issue opened from the routine's account isn't triaged on its own, since
that account's events only count when addressed. Comment `🤖 triage this` on it to have it
triaged.

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

## The proposal

A proposal is one comment per issue, written for maintainers. It's folded, so the reporter
sees one line, plainly marked as not decided, and a maintainer can tell where the issue stands
without opening it:

```markdown
<!-- issue-triage:proposal -->
<details><summary><b>Proposed: needs info</b> · automated first look, not decided</summary>

**Why:** the indexer skips content with no `tags` property, and the report doesn't say which
versions it moved between.

**Info needed:**
- Which package version they updated from and to: the property lookup changed in 3.0.

**Notes for the next look**
- **Known so far:** ...
- **Checked:** ...

To answer: start a comment with 🤖.
</details>
```

- **A maintainer approves the decision, not the wording.** The reply's points ("Info needed",
  "Duplicate of", "Reason") are the limit of what gets sent. Once approved, the routine words a
  friendly reply from those points and nothing more, and posts it as a new comment, so the
  reporter is notified.
- **The proposal stays as the record.** Its heading changes to "Approved: needs info · by
  @you".
- **A correction or a fresh look** edits the proposal, with the heading "changed after @you's
  answer", plus a one-line reply, since an edit notifies nobody.
- **A security report gets nothing on the issue.** No comment, no label. The routine sends
  maintainers a private notification instead ([below](#security-flags)).
- **The `To answer` line** comes from the repo's `CLAUDE.md`: add `- Proposal answers: start a
  comment with 🤖` to its `## Issue tracker` section. The skill also uses it to tell an answer
  from maintainers talking to each other. Keep it the same as `addressed_with` in the config:
  one decides what starts a run, the other what the skill counts as an answer.

The format is the skill's, set out in its Approval on the tracker section. Each round of
triage gets its own proposal comment, so the approved ones stay as the record.

## Trusting it more over time

Start with every outcome needing approval. As the record shows it gets an outcome right, let
that outcome skip approval, with a line in the repo's `CLAUDE.md`, under `## Issue tracker`:

```markdown
- Auto-apply: needs-investigation
```

| Step | Add | Why it comes then |
|---|---|---|
| 1 | `needs-investigation` | the reply is generic, and investigating only reads code. A new bug goes straight to the investigation, and you approve once, on what it found |
| 2 | `needs-decision` | the reply only says a maintainer will decide |
| 3 | `needs-info` | the reply asks the reporter things, so a wrong question costs them |
| 4 | `ready`, `blocked`, `already-fixed` | the reply states a finding |
| 5 | `duplicate`, `close` | it closes the issue on someone |

- **An applied outcome is still on the record,** headed "Applied automatically: needs
  investigation". A `🤖` answer to it overrules it, like any other answer.
- **The `trust-report` route counts the record** each month: how often each outcome was
  approved as proposed, changed, or overruled, and suggests the next step, or a step back.
- **The routine never loosens its own rules.** A person edits the line.
- **Security reports never get a write,** at any step.
- **Shadow mode comes first,** before anything is posted at all.

## Claiming an issue

The orchestrator claims the issue before firing: it adds `loop/working` (set as `claim.label` in
the config), and no other run starts for that issue until the routine removes it. The routine's
prompt ends with when to remove it. So the skills don't claim anything themselves.

Every `🤖` comment gets reactions from the workflow, within seconds:

- 👀 when it's received. It either starts a run, or waits for the one already working.
- 🚀 when its run starts.
- 😕 if the routine couldn't be started (comment again to retry), or the issue hit its run limit.

The config sets `run_limit` to 10 runs per issue. The eleventh gets 😕, and `loop/limit` goes on
the issue, so a maintainer looks at why it's taking so many rounds. Taking the label off lets it
go on.

The config also starts in `mode: shadow`, so a new repo can watch what would happen before
anything does. Switch it to `live` once the right routes match.

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
| Approve, but trim the reply | `🤖 approve, but skip the log question` |
| Choose another state | comment `🤖 needs info`, `🤖 ready`, and so on |
| Correct it | comment in plain words: `🤖 dupe of #41`, `🤖 this is expected behavior` |
| Ask for a fresh look | `🤖 look again, the stack trace is different` |
| Close it | close the issue; no route matches a closed issue's events |
| Leave it | nothing; it waits as `state/drafted` |

A comment without 🤖 is just a comment. The routine never sees it.

## What the skills do

The skills run the same as in a chat, with two flags:

- **`--unattended`:** no questions, and a clean stop when setup needs a person. A batch run takes
  at most 10 issues.
- **`--via-tracker`:** the approval happens on the issue. With no proposal yet, it proposes and
  adds `state/drafted`, never the final state. With one, it reads the newest answer since, from
  someone with write access, and acts on it when it settles the outcome and the reply, or
  proposes again when it doesn't. Other new comments mean it proposes again with them.
- **A security report** gets no write at all. The skill returns the flag and the issue ID, and
  the route prompt sends the private notification.

The loop's own parts stay in the route prompts: `/loop-notify`, `/loop-edge`, and leaving out
claimed or paused issues. The skills don't know they run in a loop. Each flag has an eval in the
devkit.

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
- [ ] `🤖 approve` posts a reply within the proposal's points, swaps `state/drafted` for the
      proposed state, and marks the proposal approved.
- [ ] `🤖 aprove` (misspelled) does the same.
- [ ] `🤖 approve, but skip <a point>` leaves that point out of the reply.
- [ ] `🤖 look again, ...` edits the proposal and posts a one-line reply, with no final state.
- [ ] `🤖 dupe of #1` closes it as a duplicate, with a reply linking #1.
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
