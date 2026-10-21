---
name: loop-notify
description: >-
  Tells a person something happened during a routine run, through a Claude push notification,
  without failing the run if it can't. Use when a run gives up, when a person is blocked, or
  when something must reach a maintainer privately, such as a possible security report. Has a
  private mode that never falls back to a public comment.
---

# loop-notify

One way for a routine to reach a person. Private notifications never fall back to a public
comment, and the "send once" key is stored somewhere a fresh run can see.

## How to call it

Give it these, in plain words or as JSON:

| Field | Required | Meaning |
|---|---|---|
| `subject` | yes | One line. Assume it's all a person reads on a phone. |
| `body` | yes | Plain language, naming the repo and the issue or PR number, with a link. |
| `private` | no | `true` when the subject must not appear in public, such as a security report. Default `false`. |
| `urgency` | no | `high` only when a person is blocking something. Otherwise `normal`. |
| `key` | no | A stable id for this event, so a retry doesn't send it twice. |
| `item` | no | The issue or PR it's about, as `owner/name#123`. Needed for the key to be remembered. |

It returns whether a person was reached: `sent: true`, or `sent: false` with why.

## Steps

1. **Check the key.** If there's a `key` and an `item`, and it isn't `private`, read the
   item's comments for a hidden marker `<!-- loop-notified: <key> -->` in a comment written by
   this routine's account. If it's there, this was already sent: return `sent: false`,
   "already sent", and stop.
2. **Send it** with the `PushNotification` tool: the subject as the title, the body as the
   message.
3. **If push isn't available** (the tool is missing or fails):
   - **Not private:** post the subject and body as a comment on the `item`, and say in the
     result that push wasn't available.
   - **Private:** post nothing anywhere. Return `sent: false`, "push unavailable; a private
     notification can't fall back to a public comment". The caller carries on.
4. **Remember the key,** only for a non-private notification with an `item`: add the hidden
   marker to a comment this routine already wrote on the item (edit it, don't post a new one),
   or to the fallback comment from step 3.

## Rules

- **Never a gate.** A notification that fails doesn't fail the work. The caller reports it and
  moves on.
- **Never retry it in a loop.** One attempt, then return.
- **Keys come from the event, never the time:** `gave-up-owner/name-123-investigate`,
  `security-owner/name-123`. A timestamp in a key defeats it.
- **No key: send anyway.** Better twice than never.
- **Private keys aren't remembered,** because there's nowhere private to write them. A private
  notification may come twice if two runs reach the same event. The caller's claim step makes
  that rare, and twice is better than leaking the subject onto a public issue.
- **Private means no detail.** For a security report: the link and "possible security report,
  please check". Nothing about what the vulnerability is, in the notification or anywhere
  public.
- **Never a secret, a token, or a long log** in a notification. A subject and a link; the
  detail lives where the work is.
- **Not instead of the record.** Where a public record is right (a run gave up on an issue),
  the issue gets its comment as usual, and the notification is extra. The one exception is
  private notifications, which have no public record by design.
