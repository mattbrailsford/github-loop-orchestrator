# Who the routine posts as

A routine's comments and labels need to be told apart from people's. Otherwise the routine can
start itself: its own comment matches a maintainer route, which fires it again. This page
compares the three ways to handle that, what each needs, and how far each has been tested.

## The short version

| Strategy | Posts as | How people talk to it | Setup | Status |
|---|---|---|---|---|
| [🤖 prefix](#1-the--prefix-default) (default) | you, marked "via Claude" | a comment starting with 🤖 | none | tested end to end |
| [Your own GitHub App](#2-your-own-github-app) | `your-app[bot]` | 🤖, or `@your-app` | register an app; give the routine its key | orchestrator tested; posting as the app not yet tried on a real app |
| [A machine user](#3-a-machine-user) | `your-bot` | 🤖, or `@your-bot` | a second GitHub account; give the routine its token | orchestrator tested; posting as it not yet tried |

Start with the 🤖 prefix. Move to your own app when comments under your name become a problem:
a team that wants to see at a glance what a person wrote, or a reporter who can't tell you
apart from the routine.

## Why not `claude[bot]`?

That name only appears when the Claude app's own token is used. Only Anthropic's GitHub
Actions integration (`claude-code-action`) gets one, by trading in the workflow's GitHub
identity, and it cancels the token when it finishes. So a routine can't post as `claude[bot]`,
and neither can a later workflow step. The one way to get that name is to run Claude inside
`claude-code-action`, which means a model call, and an Anthropic key in the repo, for every post.

## 1. The 🤖 prefix (default)

A routine reaches GitHub through the Claude app, with the account of whoever set it up. Tested
on a real repo: its comments show under that person's login, marked "via Claude." So by login
alone, the orchestrator can't tell the routine from that person.

The prefix gets around it without a new identity:

- `routine_login` names the account the routine posts as. Every event from it is ignored,
  comments and labels alike, unless it's addressed to the routine.
- People address the routine by starting a comment with 🤖 (an `addressed_with` route).
- The routine's stored prompt tells it never to start a comment with 🤖, so it can't address
  itself.
- Labels are outputs only: the routine sets them, and no route starts from one.

**Pros**

- Nothing to set up beyond the Claude app, which a routine needs anyway.
- Typos are fine: the orchestrator only checks for 🤖, and the model reads the rest.
- Nobody is pinged, unlike an `@` mention.
- Faking it is harmless: a stranger's 🤖 comment starts nothing, because `addressed_with`
  routes are maintainer-only.

**Cons**

- **The routine's comments carry your name.** A reporter sees "you" replying, with only a small
  "via Claude" mark. Starting each comment with a clear "Automated first look" line helps.
- **Your own label changes are ignored too,** since they come from the same account as the
  routine's. Approving has to be a 🤖 comment, not a label click.
- **Issues you open yourself aren't routed** unless their body starts with 🤖.
- **It depends on the routine following its prompt.** If it ever started a comment with 🤖, it
  would address itself. The hop limit and the claim step limit the damage.

**Tested:** an issue and a plain comment from the routine's account were ignored, a 🤖 comment
fired the routine, and its reply, under the same account, started nothing.

## 2. Your own GitHub App

You register a GitHub App, install it only on the loop's repos, and the routine posts with the
app's token. GitHub shows those as `your-app[bot]` and marks them as a bot, which the
orchestrator already ignores.

**Pros**

- Comments come from a clearly separate identity.
- **You can be a person again:** with `routine_login` left unset, your comments and label
  changes count like anyone else's, and approving by label becomes possible. See the slip below
  for the trade-off.
- `@your-app` mention routes become an option, alongside 🤖.
- Permissions are only what you pick, instead of the Claude app's broad set.
- Tokens last an hour and are made fresh each run. There's no long-lived token to expire or leak.

**Cons**

- **The app's private key has to sit in the routine's environment.** Claude's docs say
  environment variables are visible to anyone who uses that environment. Use an environment
  only you use.
- **The routine still has the Claude app's access too,** because that's how it reaches GitHub.
  It must be told to post only with the app's token. The identity test showed a routine using
  tools beyond its allowed list, so this is a prompt rule, not a hard limit. A slip would post
  as you. You choose how to cover that:
  - **Leave `routine_login` unset:** you count fully as a person, but a slip could start a
    maintainer route once. The hop limit and the claim step limit what follows.
  - **Set `routine_login` to your login:** a slip can't start anything, but you're back to
    talking to the routine with 🤖 only, as with strategy 1. The gain is then just the
    separate name on its comments.
- About 30 minutes to set up.

**Setting it up**

1. Register the app: in GitHub's settings, Developer settings, GitHub Apps, **New GitHub App**
   ([GitHub's guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)).
   - Turn off its webhook. The orchestrator doesn't need one.
   - Repository permissions: **Issues** read and write, **Pull requests** read and write,
     **Contents** read and write (for `repository_dispatch`, which edges and the ticker use;
     believed to need contents write, unverified), **Metadata** read.
2. Install it on the loop's repos only. In a split setup, on both the tracker and the code repo.
3. Note the app's ID, and generate a private key (a `.pem` file).
4. In the routine's cloud environment, set `LOOP_APP_ID` and `LOOP_APP_KEY` (the whole PEM
   text) as environment variables.
5. Add this to the end of the routine's stored prompt:

   ```text
   - Post to GitHub only as the loop's app. Before any GitHub write, run:
     export GH_TOKEN="$(bash ~/.loop/app-token.sh --repo <the repo you're writing to>)"
     Then write with the gh command only. Never use the built-in GitHub tools to write; they post as a person, not the app.
   ```

6. In the config, add `your-app-name[bot]` to `bots` (GitHub already marks it as a bot, so this
   is belt and braces), and decide about `routine_login` as above.

`~/.loop/app-token.sh` comes from `scripts/app-token.sh`, which `templates/cloud-setup.sh`
installs. It signs a short-lived request with the key, finds the app's installation on the
repo, and prints a token scoped to just the repos you name. Tested against GitHub's documented
flow with a throwaway key and a stand-in server; **not yet run against a real app.**

## 3. A machine user

A second GitHub account, used only by the routine
([GitHub calls these machine users](https://docs.github.com/en/get-started/learning-about-github/types-of-github-accounts)).
The routine posts with that account's token.

**Pros**

- The simplest separate identity: no app to register, no key to sign with.
- Like an app, it frees your own account: with `routine_login` set to the machine user, your
  comments and labels count again.
- `@your-bot` mentions work, and notify the account, so it appears in people's autocomplete.

**Cons**

- **GitHub sees it as a person,** not a bot. Its login **must** be in `routine_login` or `bots`,
  or the orchestrator treats its comments as human.
- **A long-lived token.** It has to be stored in the routine's environment, it can do anything
  the account can, and it expires unless you choose no expiry. When it expires, the routine
  can't post, quietly.
- **Fine-grained tokens may not work.** GitHub's newer tokens are believed not to reach a repo
  the account only collaborates on, when that repo belongs to a personal account. That leaves a
  classic token with the `repo` scope, which is broad. Unverified.
- Same as the app: the routine also has the Claude app's access, so posting as the machine user
  is a prompt rule, not a hard limit. A slip posts as you, and with `routine_login` naming the
  machine user, it counts as you.
- A second account to keep, with its own email, password, and two-factor setup. Check GitHub's
  terms for machine accounts first.

**Setting it up**

1. Create the account, and add it to the loop's repos as a collaborator with write access.
2. Signed in as it, create a token for those repos.
3. In the routine's environment, set `GH_TOKEN` to that token.
4. Add to the stored prompt: "Write to GitHub only with the gh command, which posts as the
   loop's account. Never use the built-in GitHub tools to write."
5. In the config, set `routine_login` to the machine user's login.

**Not yet tried on a real account.**

## Choosing

- **Trying the loop out, or one maintainer:** the 🤖 prefix.
- **A team, or a public tracker where reporters read the replies:** your own GitHub App.
- **A machine user** only if registering an app isn't possible. The app does the same job with
  shorter-lived credentials.

Whichever you pick, keep 🤖 as the way people talk to the routine. It works with all three, it
pings nobody, and moving between strategies then only changes the config's `routine_login` and
`bots`, not how anyone uses the loop.
