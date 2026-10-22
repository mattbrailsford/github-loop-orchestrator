---
name: loop-edge
description: >-
  Hands a routine run on to the next route, by sending the orchestrator a loop-edge event for the
  same issue or PR. Use when a route's instruction says to hand on with /loop-edge <route>, or to
  start the next step of a chain. Builds the payload from the run's <loop-run> block, so the
  route only names where to go.
argument-hint: <route to hand on to>
---

# loop-edge

Starts the next step of a chain. The orchestrator only accepts it if its config declares the
route as an edge that takes runs from this one, and the chain is under its hop limit.

## What you need

- **The route to hand on to:** the argument, such as `investigate`.
- **This run's details:** the `<loop-run>` block in your instruction. It gives `hub`, `repo`,
  `number`, `route`, and `hop`. If there's no block, or no `number` (a scheduled run is about the
  whole repo, not one item), stop and say an edge can't be sent from here.

## Steps

1. **Build the payload once,** and write it to a file, `loop-edge.json`:

   ```json
   {
     "event_type": "loop-edge",
     "client_payload": {
       "route": "<the argument>",
       "from": "<route from the block>",
       "repo": "<repo from the block>",
       "number": <number from the block>,
       "hop": <hop from the block, plus one>,
       "sent_at": "<the current UTC time, like 2026-10-22T06:26:30Z>"
     }
   }
   ```

   `number` and `hop` are numbers, not strings. Get the time from `date -u +%Y-%m-%dT%H:%M:%SZ`.

2. **Send it to the hub,** not the repo the item is in, if they differ:

   ```bash
   gh api -X POST repos/<hub from the block>/dispatches --input loop-edge.json
   ```

   A success prints nothing. If `gh` isn't available, create the same repository dispatch with
   the GitHub tools you have.

3. **If it fails, send the same file again,** up to three times in all. Never build a new payload
   for a retry: the orchestrator recognizes a repeat by its `sent_at`, and a new time would look
   like a second, separate edge.

4. **Report it** in your output: the route you handed on to and the hop, or that sending failed
   and the last error.

## After handing on

- **Leave the claim label on.** The run you started takes the claim over. Removing it would let
  another run start on this item in between.
- **Don't wait for the next run,** and don't do its work. Finish your own and stop.
- **If sending failed after three tries,** the chain stops here. Remove the claim label as usual,
  so the item isn't left claimed, and use /loop-notify to tell a maintainer the chain broke.

## Rules

- One edge per run.
- Never hand on to the route you're in. Chains loop that way, and the orchestrator's hop limit is
  the only thing that would stop it.
- Never put anything from the issue or its comments into the payload. The next run reads those
  for itself.
