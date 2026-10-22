---
name: loop-comment
description: >-
  Posts a routine run's comment on its issue or PR without ever posting it twice. With no key it
  posts a new reply, so the person who asked is notified; with a key it keeps one living comment
  for that key and edits it in place. Never addresses the routine itself. Use whenever a routine
  run writes a comment on the item it's working on.
argument-hint: "[key, such as triage] [--note \"<first line>\"]"
---

# loop-comment

One way to write on the item a run is about. Two kinds of comment:

| Call | Posts | Use it for |
|---|---|---|
| `/loop-comment` | a new reply for this run | answering a request; the person who asked is notified |
| `/loop-comment <key>` | one comment for that key, edited in place by every run that uses the key | a proposal or status that changes over time, such as `triage` |

GitHub doesn't notify anyone when a comment is edited. So an answer someone is waiting for is a
reply, not an edit to a comment further up the thread.

## What you need

- **The key,** if there is one: the argument right after `/loop-comment`, such as `triage`.
  Lowercase letters, numbers, and dashes. Never `reply`, which is used for replies.
- **The body,** written to a file first, `loop-comment.md`. Plain Markdown, no marker; this skill
  adds it.
- **This run's details** from the `<loop-run>` block: `repo`, `number`, `route`, `event`, `hop`,
  and `comment` if there is one.
- **Optionally, `--note "<text>"`:** a first line set apart as a quote, such as
  `--note "Automated first look. A maintainer will check this and may change it."`.

## Steps

1. **Check the body's first line.** If it starts with 🤖 or `:robot:`, reword it. A comment that
   starts that way addresses the routine, and would start it again.

2. **Pick the marker:**
   - With a key: `<!-- loop:<key> -->`.
   - Without one, a reply: `<!-- loop:reply:<route>:<what started this run> -->`, where what
     started it is the `comment` from the block, or, when there's none, `<event>-<hop>` (such as
     `issues.opened-0` or `edge-2`). This marks the reply as this run's, so a retry within the run
     finds it, while the next request, which has a different trigger, gets its own reply.

3. **Build the comment** in `loop-comment.post.md`: the marker on the first line, then the note as
   `> **<note>**` and a blank line if there is one, then the body.

4. **Look for one already posted** with that exact marker, by the account you post as:

   ```bash
   me="$(gh api user --jq .login)"
   gh api "repos/<repo>/issues/<number>/comments?per_page=100" --paginate \
     --jq ".[] | select(.user.login == \"$me\") | select(.body | contains(\"<marker>\")) | .id"
   ```

5. **Edit it, or post a new one:**
   - Found: `gh api -X PATCH repos/<repo>/issues/comments/<id> -F body=@loop-comment.post.md`
   - Not found: `gh api -X POST repos/<repo>/issues/<number>/comments -F body=@loop-comment.post.md`

   If more than one turns up, edit the newest and leave the others.

   For a reply, finding one means this run already posted it, after an error that wasn't one.
   Editing it is right; posting again would be the duplicate.

6. **If the write reports an error, check before retrying.** Run step 4 again. If a comment with
   the marker now holds your body, the write went through: stop. Otherwise retry step 5 once.
   Never retry blind; a post that errored often went through.

7. **Report** the comment's URL, and whether it was new or edited.

If `gh` isn't available, do the same with the GitHub tools you have: find by marker, edit or
create, and check before retrying.

## Rules

- **One reply per run, one living comment per key.** Don't post a second reply to say the first
  changed; edit it, which is what calling the skill again in the same run does.
- **Write only on the item in the `<loop-run>` block.** Other issues are another run's business.
- **Nothing private.** A comment on a public repo is public. A possible security report gets no
  comment at all; use /loop-notify, private, instead.
- **Don't edit other people's comments,** including another route's, even with the same key.
