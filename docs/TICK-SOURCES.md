# Tick sources

Schedule routes run when the hub gets a `loop-tick` event. Anything that can make one
authenticated HTTP call an hour can send it. This page lists the options, what each costs, and
where its token lives.

## The call

Every option sends the same request, once an hour, on the hour, to each hub:

```bash
curl -sS -X POST "https://api.github.com/repos/OWNER/REPO/dispatches" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -d '{"event_type":"loop-tick"}'
```

GitHub answers `204 No Content` when it worked. The body carries nothing else: the hub works out
the time itself, so a late or repeated tick can't claim to be for another hour.

## The token

The token is the part to think about, more than the timer.

- **It can do more than tick.** A classic token needs the `repo` scope for this endpoint, which is
  full access to the repo, code included. A fine-grained token is believed to need
  **Contents: write** on the hub. That's also push access. **Unverified:** GitHub's API page
  doesn't list the fine-grained permission. Either way, whoever holds the token can change the
  hub's code.
- **So keep it close.** Prefer a source where the token sits in your own secret store (a GitHub
  secret, your cloud's key vault) over one where you paste it into a third-party service.
- **Limit it.** A fine-grained token, scoped to the hub repos only, with nothing else.
- **It expires.** Fine-grained tokens have an expiry date. When it passes, ticks stop with no
  warning, and schedules look like quiet days. Put the date in a calendar.
- **A GitHub App avoids both problems,** if the source can run a few lines of code: an app
  installed only on the hubs, with only the permission dispatch needs, mints a short-lived token
  each time. The private-repo option below does this with `actions/create-github-app-token`.

## The options

| Source | Token lives in | Cost | Setup | Good for |
|---|---|---|---|---|
| [Ticker routine](#ticker-routine) | Claude's GitHub connection | 24 short sessions a day | a routine and a prompt | the default; nothing else to run |
| [Private repo's GitHub timer](#a-private-repos-github-timer) | a GitHub secret, or a GitHub App | Actions minutes | one workflow file | teams already on GitHub; no 60-day rule |
| [Your cloud's scheduler](#your-clouds-scheduler) | your cloud's secret store | usually free at this volume | a scheduled job | teams with a cloud account already |
| [A machine with cron](#a-machine-with-cron) | that machine | free | one crontab line | a server that's always on |
| [A hosted cron service](#a-hosted-cron-service) | the service | free tiers exist | a web form | quick tests, not production |

Use **one** source per hub. Two sources means two ticks an hour, and every due route runs twice.

### Ticker routine

A tiny Claude routine on its own hourly schedule. Setup is in
[`templates/routine.md`](../templates/routine.md#the-ticker). No token to store anywhere
else: it uses the routine's GitHub connection. The cost is a short model session per tick.

### A private repo's GitHub timer

GitHub's 60-day rule only turns off scheduled workflows in **public** repos. So a small private
repo can run the timer and tick public hubs. One workflow does it:

```yaml
# .github/workflows/tick.yml in a private repo
name: tick
on:
  schedule:
    - cron: "0 * * * *"
  workflow_dispatch:
jobs:
  tick:
    runs-on: ubuntu-latest
    steps:
      - id: app
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ vars.TICK_APP_ID }}
          private-key: ${{ secrets.TICK_APP_KEY }}
          owner: OWNER
      - env:
          GH_TOKEN: ${{ steps.app.outputs.token }}
        run: |
          for repo in OWNER/tracker-one OWNER/tracker-two; do
            gh api "repos/$repo/dispatches" -f event_type=loop-tick || echo "::error::tick failed for $repo"
          done
```

- **Cost:** private repos use Actions minutes, and each run rounds up to a minute. Hourly is
  about 720 minutes a month. Check what your plan includes.
- **No app?** Swap the app step for a fine-grained token in a secret. Mind the expiry.
- **GitHub's timer runs late** when GitHub is busy. Fine here: the hub matches by the hour.

### Your cloud's scheduler

Every major cloud has a timer that can make an HTTP call, and most have a free allowance far
above 24 calls a day.

- **Azure:** a Functions app with a timer trigger, or a Logic App with a recurrence trigger and
  an HTTP action. The token goes in Key Vault.
- **AWS:** EventBridge Scheduler, calling the API through an API destination, or a small Lambda.
  The token goes in Secrets Manager.
- **Google Cloud:** Cloud Scheduler with an HTTP target. It can send the headers and body above
  with no code. The token goes in Secret Manager.
- **Cloudflare:** a Worker with a cron trigger. The token goes in the Worker's secrets.

Pick the one your team already runs. A second cloud account just for a timer is one more thing
to forget about.

### A machine with cron

Any always-on Linux or macOS machine:

```text
0 * * * * TOKEN=... /usr/bin/curl -sS -X POST https://api.github.com/repos/OWNER/REPO/dispatches -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" -d '{"event_type":"loop-tick"}'
```

Better: put the call in a script that reads the token from a file only you can read, and run
that. The catch is the machine: when it's off, asleep, or rebuilt, ticks stop.

### A hosted cron service

Services such as cron-job.org, or Zapier's schedule plus a webhook step, can send the request
from a web form, with custom headers.

The token then lives in someone else's system, and it can push code to the hub. That's fine
for trying the loop on a test repo. For a real hub, use one of the options above.

## Noticing when ticks stop

Every source fails the same way: quietly. No tick, no scheduled runs, no error anywhere.

A schedule route can't catch this, since it needs a tick to run. The check has to come from
outside the loop:

- **The source's own alerts.** Most cloud schedulers and Actions can alert on a failed run.
  Turn that on. It catches a bad token or a blocked call, but not a timer that was switched off.
- **A check on the hub's run history.** The hub's Actions history shows every `loop-tick` run.
  Something outside the loop (another scheduled job, a monitoring tool) can ask GitHub's API
  when the last one was, and alert when it's more than a few hours old.

A ticker that has stopped looks exactly like a quiet week. Decide who would notice before
relying on schedules.
