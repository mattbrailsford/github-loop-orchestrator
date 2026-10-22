---
name: loop-comment
description: >-
  Posts a routine run's reply on its issue or PR as one comment that's edited in place on later
  runs, never duplicated, and never addressed to the routine itself. Use whenever a routine run
  writes a comment on the item it's working on, and for proposals that change over time, such as
  a triage that gets corrected.
argument-hint: <name for this comment, such as triage> [--note "<first line>"]
---

# loop-comment

One way to write on the item a run is about. It keeps a reply to one comment per name, edited in
place, so the person who asked isn't notified again every time it changes, and so an error can't
leave two copies.

## What you need

- **A name** for the comment: the argument, such as `triage`. Comments with different names are
  separate, so a route can keep, say, a `triage` comment and an `investigation` comment.
- **The body,** written to a file first, `loop-comment.md`. Plain Markdown, no marker; this skill
  adds it.
- **This run's details** from the `<loop-run>` block: `repo` and `number`.
- **Optionally, `--note "<text>"`:** a first line set apart as a quote, such as
  `--note "Automated first look. A maintainer will check this and may change it."`.

## Steps

1. **Check the body's first line.** If it starts with 🤖 or `:robot:`, reword it. A comment that
   starts that way addresses the routine, and would start it again.

2. **Build the comment** in `loop-comment.post.md`: the marker `<!-- loop:<name> -->` on the first
   line, then the note as `> **<note>**` and a blank line if there is one, then the body.

3. **Look for an earlier one:** the comments on the item that contain that exact marker and were
   written by the account you post as:

   ```bash
   me="$(gh api user --jq .login)"
   gh api "repos/<repo>/issues/<number>/comments?per_page=100" --paginate \
     --jq ".[] | select(.user.login == \"$me\") | select(.body | contains(\"<!-- loop:<name> -->\")) | .id"
   ```

4. **Edit it, or post a new one:**
   - Found: `gh api -X PATCH repos/<repo>/issues/comments/<id> -F body=@loop-comment.post.md`
   - Not found: `gh api -X POST repos/<repo>/issues/<number>/comments -F body=@loop-comment.post.md`

   Use the newest if more than one turns up, and leave the others.

5. **If the write reports an error, check before retrying.** Run step 3 again. If a comment with
   the marker now holds your new body, the write went through: stop. Otherwise retry step 4 once.
   Never retry blind; a post that errored often went through.

6. **Report** the comment's URL, and whether it was new or edited.

If `gh` isn't available, do the same with the GitHub tools you have: find by marker, edit or
create, and check before retrying.

## Rules

- **One comment per name per item.** Don't post a second comment to say the first changed; edit
  the first.
- **Write only on the item in the `<loop-run>` block.** Other issues are another run's business.
- **Nothing private.** A comment on a public repo is public. A possible security report gets no
  comment at all; use /loop-notify, private, instead.
- **Don't edit other people's comments,** including another route's, even with the same name.
