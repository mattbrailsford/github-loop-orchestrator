# github-loop-orchestrator

**A proposal, not a product.** Tested end to end on a private test repo: a GitHub event, the match,
the routine firing, and its reply. Not yet run on a real tracker.

A generic way to drive hosted Claude routines from GitHub. People talk to a routine in issue and
PR comments. A config file in each repo says which event starts the routine, and with what
prompt. The orchestrator does nothing else.

## The problem

Agents still need a lot of prompting. A person has to start each run, watch it, and answer its
questions in the chat. That doesn't scale past one person and a few sessions.

A routine can start work without a person. But once it's running, nobody can step in. So the
back-and-forth needs somewhere else to go, somewhere a person can answer whenever they get to it.

GitHub already has that place: the issue or the pull request. Comments carry the conversation,
labels show where things stand, and both fire events.

## How it works

```mermaid
flowchart LR
  E["GitHub event"] --> M["Match against<br/>the repo's config"]
  M -->|"no match"| X["stop, nothing runs"]
  M -->|"match"| F["Fire the routine<br/>with the route's prompt"]
  F --> R["Routine does the work<br/>posts comments and labels"]
  R --> P["A person answers<br/>with a 🤖 comment"]
  P --> E
  R -.->|"declared edge"| E
```

1. Something happens on an issue or PR: it's opened, or someone comments.
2. A script matches it against `.github/loop-orchestrator.yml`. No model runs to decide this.
3. On a match, it fires the repo's routine with that route's prompt.
4. The routine does the work and writes back to GitHub.
5. A person answers, which is a new event.
6. A routine can also start the next step directly, but only along an edge the config declares.
7. Schedule routes run on an hourly tick, for work that isn't about one issue.

## Talking to the routine

A routine posts through the Claude GitHub app with the account of whoever set it up, not as a
bot. So by login alone, its comments look like yours. Two config settings keep them apart:

- **`routine_login`** names that account. Nothing from it starts a route, unless it's addressed
  to the routine.
- **A 🤖 at the start of a comment** addresses the routine. The rest of the comment goes to it
  as the request, typos and all: `🤖 aprove` works, since the model reads it.

The routine never starts a comment with 🤖, so it can't start itself. Only people with write
access can address it.

Giving the routine its own identity instead, such as your own GitHub App, is compared in
[`docs/IDENTITY.md`](docs/IDENTITY.md).

## What it knows, and what it doesn't

| It knows | It doesn't know |
|---|---|
| GitHub events: issues and PRs opened, labeled, commented on, plus an hourly schedule | what any label means |
| When a comment is addressed to the routine | what the comment asks for |
| How to match an event against the repo's config | what a routine does, or which skills it runs |
| Who did it: a maintainer, the author, someone else, a bot, or the routine | the repo's product, stack, or workflow |
| How to fire a hosted routine with a prompt | what gets posted back, or in what format |
| How to stop runaway loops | anything about triage, fixes, or releases |

Every action goes to a routine. The orchestrator never comments, labels, or closes anything.

## Example

[`examples/triage/`](examples/triage/) wires a pair of triage skills to this. A new issue gets a
proposed triage. A maintainer answers with `🤖 approve`, `🤖 needs info`, or `🤖 dupe of #41`,
and the routine follows. All the label meanings live there, not here.

## Setting up a repo

You need:

- **A routine**, set up in Claude, with the skills that do the work.
- **A config file** listing the repo's routes.
- **A small caller workflow** that hands GitHub events to the orchestrator, plus two secrets.

In order:

1. **Install the Claude GitHub app** on the repo. Routines reach GitHub through it, and can't be
   created without it. Skip its own `@claude` workflow and API key secret
   ([details](templates/routine.md#installing-the-claude-github-app)).
2. **Set up a routine** at [claude.ai/code/routines](https://claude.ai/code/routines), following
   [`templates/routine.md`](templates/routine.md): the standard config, the stored prompt to
   paste as is, and an API trigger. Remove the connectors it attaches by default.
   - **Give it skills:** paste [`templates/cloud-setup.sh`](templates/cloud-setup.sh) into its
     cloud environment's "Setup script" field, and list your plugin repos in `SKILL_SOURCES`.
     It copies their skills and agents in when the environment builds. Add `github.com` to the
     environment's allowed domains.
   - **Call skills by bare name** in your route prompts (`/issue-triage`), since copied skills
     have no plugin prefix.
3. **Add two secrets** to the repo: `LOOP_FIRE_URL` and `LOOP_FIRE_TOKEN`, from the routine's API
   trigger ([how](templates/routine.md#the-fire-url-and-token)).
4. **Copy [`templates/caller.yml`](templates/caller.yml)** to `.github/workflows/loop.yml`.
5. **Write `.github/loop-orchestrator.yml`** with your routes. Start from the
   [example](examples/triage/loop-orchestrator.yml), and set `routine_login` to your login. For
   editor help, add this first line:
   `# yaml-language-server: $schema=https://raw.githubusercontent.com/mattbrailsford/github-loop-orchestrator/main/schema/loop-orchestrator.schema.json`
6. **Schedule routes, if you have any:** set up the ticker routine from
   [`templates/routine.md`](templates/routine.md#the-ticker), and list this repo in its prompt.
   A private repo can use GitHub's own timer instead (commented out in the caller template).
   Other tick sources, and where each keeps its token, are in
   [`docs/TICK-SOURCES.md`](docs/TICK-SOURCES.md).

**Issues in a separate repo from the code?** The tracker becomes the hub. Set `code_repo` in its
config, do steps 1, 3, and 4 in the code repo too, and set `config_repo` in the code repo's
caller to the tracker. Only the tracker has a `loop-orchestrator.yml`, and the routine's repos
must include both.

**This repo has to stay public.** Two things break if it goes private: other repos can't call its
reusable workflow, and the routine's Setup script can't clone it without a token. Both fail early
and quietly. A workflow from a private repo fails before any job starts, so there's no log to
read.

## Layout

```
github-loop-orchestrator/
├── .github/workflows/
│   ├── loop.yml              # the reusable workflow every repo calls
│   └── test.yml              # this repo's CI
├── bin/
│   ├── match.mjs             # matches one event, writes the routes and prompts to fire
│   └── validate.mjs          # checks a config, converted to JSON
├── src/                      # config checks, events, mentions, cron, prompts, GitHub calls
├── schema/
│   └── loop-orchestrator.schema.json   # editor help for the config
├── scripts/
│   ├── cloud-skill-sync.sh   # copies plugin repos' skills and agents into a routine's environment
│   └── app-token.sh          # makes a GitHub App token, for a routine with its own app identity
├── templates/
│   ├── caller.yml            # what each repo copies into .github/workflows/
│   ├── cloud-setup.sh        # what goes in the routine environment's "Setup script" field
│   └── routine.md            # the worker and ticker routines: config, stored prompts, notifications
├── skills/
│   └── loop-notify/          # a skill every routine gets: push notifications, with a private mode
├── stacks/
│   └── umbraco/              # optional: .NET SDK, SQL Server, and run-umbraco.sh for a routine
├── examples/
│   └── triage/               # a worked config and the skills it expects
├── docs/
│   ├── DESIGN.md             # how it works, and why
│   ├── IDENTITY.md           # who the routine posts as: the 🤖 prefix, your own app, a machine user
│   └── TICK-SOURCES.md       # what can send the hourly tick for schedule routes
└── test/                     # node --test; no packages to install
```

Run the tests with `npm test`. Node 20 or newer, nothing to install. One test checks the example
config and needs `yq`; it skips without it locally, and runs in CI.

## Status

- [x] Design, in [docs/DESIGN.md](docs/DESIGN.md)
- [x] One worked example, in [examples/triage/](examples/triage/)
- [x] The orchestrator: matching, mentions, 🤖 addressing, edges, the hub, schedules, and the
      workflow, with tests
- [x] Run on a test repo: an issue and a plain comment from the routine's account were ignored,
      a 🤖 comment fired the routine, and its reply started nothing
- [ ] Edges and the ticker, on the test repo
- [ ] A routine with its own GitHub App identity: the token script is written and tested against
      a stand-in, not a real app
- [ ] Triage skills that support what the example needs (`--unattended`, `--propose`,
      `--respond`)

**Not proven yet**, each marked in the design:

- that a routine can send `repository_dispatch`, which edges and the ticker need,
- that GitHub returns a PR's linked issue when it's in another repo,
- that the routine fire API, still in beta, stays as it is.

## Acknowledgments

Based on [umbraco-ai-ops](https://github.com/umbraco/umbraco-ai-ops). The event routing, labels
as gates, copying skills into a cloud environment, the Umbraco stack scripts, and the notify
skill all started from its work.
