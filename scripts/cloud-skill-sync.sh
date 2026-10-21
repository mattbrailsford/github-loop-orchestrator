#!/usr/bin/env bash
# Delivers skills and agents from plugin repos into a Claude cloud environment, so a hosted
# routine can call them. Run by templates/cloud-setup.sh, which is what gets pasted into the
# environment's "Setup script" field.
#
# Usage: cloud-skill-sync.sh <source>...
#   A source is a public repo URL, optionally with @ref (https://github.com/o/r@main), or a
#   local folder.
#
# From each source it copies:
#   plugins/*/skills/<name>/  and  skills/<name>/   -> ~/.claude/skills/<name>/
#   plugins/*/agents/*.md     and  agents/*.md      -> ~/.claude/agents/
# A repo's own .claude/ folder is never copied: those are that repo's private tools, not shipped.
#
# It copies rather than installs, because cloud sessions don't load plugins. Two things follow:
#   - Skills lose their plugin prefix. A routine prompt says /issue-triage, not
#     /my-plugin:issue-triage.
#   - A plugin's hooks are not registered. This script warns when a source has any.
#
# It never fails the environment build: a session with some skills beats no session. What
# happened goes to ~/loop-setup.log, since a session can't see the build log, and what got
# installed goes to ~/loop-env-manifest.md.
#
# Env: LOOP_HOME installs under this folder instead of $HOME (used by the tests).
set -u

HOME_DIR="${LOOP_HOME:-$HOME}"
SKILLS_DEST="$HOME_DIR/.claude/skills"
AGENTS_DEST="$HOME_DIR/.claude/agents"
LOG="$HOME_DIR/loop-setup.log"
MANIFEST="$HOME_DIR/loop-env-manifest.md"
WORK="$(mktemp -d)"
INSTALLED="$WORK/installed.txt"
ROWS="$WORK/rows.md"

mkdir -p "$SKILLS_DEST" "$AGENTS_DEST"
: > "$INSTALLED"
: > "$ROWS"

log() { echo "$*" >> "$LOG"; }

# Prints the folder the source is in, cloning it first if it's a URL. Empty on failure.
fetch() {
  local src="$1" n="$2" url ref dir
  if [ -d "$src" ]; then
    echo "$src"
    return
  fi
  url="$src"
  ref=""
  case "$src" in
    https://*@*)
      url="${src%@*}"
      ref="${src##*@}"
      ;;
  esac
  dir="$WORK/src-$n"
  if git clone --quiet --depth 1 ${ref:+--branch "$ref"} "$url" "$dir" >/dev/null 2>&1; then
    echo "$dir"
  fi
}

install_skill() {
  local skill_dir="$1" label="$2" name
  name="$(basename "$skill_dir")"
  if grep -qx "skill:$name" "$INSTALLED"; then
    log "WARNING: skill \"$name\" from $label replaces one with the same name from an earlier source"
  fi
  if grep -rqs 'CLAUDE_PLUGIN_ROOT' "$skill_dir"; then
    log "WARNING: skill \"$name\" uses CLAUDE_PLUGIN_ROOT, which is not set for a copied skill"
  fi
  rm -rf "${SKILLS_DEST:?}/$name"
  if cp -R "$skill_dir" "$SKILLS_DEST/$name"; then
    echo "skill:$name" >> "$INSTALLED"
    echo "| skill | \`$name\` | $label |" >> "$ROWS"
    log "installed skill: $name"
  else
    log "FAILED to install skill: $name"
  fi
}

install_agent() {
  local file="$1" label="$2" name
  name="$(basename "$file" .md)"
  if grep -qx "agent:$name" "$INSTALLED"; then
    log "WARNING: agent \"$name\" from $label replaces one with the same name from an earlier source"
  fi
  if cp "$file" "$AGENTS_DEST/$name.md"; then
    echo "agent:$name" >> "$INSTALLED"
    echo "| agent | \`$name\` | $label |" >> "$ROWS"
    log "installed agent: $name"
  else
    log "FAILED to install agent: $name"
  fi
}

log "===== loop cloud-skill-sync $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
[ "$#" -gt 0 ] || log "WARNING: no sources given; nothing to install"

n=0
for src in "$@"; do
  n=$((n + 1))
  dir="$(fetch "$src" "$n")"
  if [ -z "$dir" ]; then
    log "FAILED: could not fetch $src. Check it's public, the ref exists, and github.com is in the environment's allowed domains."
    continue
  fi
  label="$src"
  if [ -d "$dir/.git" ]; then
    label="$src ($(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo unknown))"
  fi
  log "source: $label"

  found=0
  while IFS= read -r skill_md; do
    [ -n "$skill_md" ] || continue
    install_skill "$(dirname "$skill_md")" "$label"
    found=$((found + 1))
  done < <(
    {
      find "$dir/plugins" -mindepth 4 -maxdepth 4 -path '*/skills/*/SKILL.md' 2>/dev/null
      find "$dir/skills" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null
    } | sort
  )

  while IFS= read -r agent; do
    [ -n "$agent" ] || continue
    install_agent "$agent" "$label"
    found=$((found + 1))
  done < <(
    {
      find "$dir/plugins" -mindepth 3 -maxdepth 3 -path '*/agents/*.md' 2>/dev/null
      find "$dir/agents" -mindepth 1 -maxdepth 1 -name '*.md' 2>/dev/null
    } | sort
  )

  [ "$found" -gt 0 ] || log "WARNING: $src has no skills or agents in plugins/*/ or at its top level"

  while IFS= read -r hooks; do
    [ -n "$hooks" ] || continue
    log "WARNING: $src has hooks ($(basename "$(dirname "$(dirname "$hooks")")")); copied skills don't register them, so they won't run"
  done < <(
    {
      find "$dir/plugins" -mindepth 3 -maxdepth 3 -path '*/hooks/hooks.json' 2>/dev/null
      find "$dir/hooks" -mindepth 1 -maxdepth 1 -name hooks.json 2>/dev/null
    } | sort
  )
done

{
  echo "# Loop environment"
  echo
  echo "Built $(date -u +%Y-%m-%dT%H:%M:%SZ) by cloud-skill-sync.sh. Skills are called by their"
  echo "bare name (\`/issue-triage\`), without a plugin prefix. The setup log is \`~/loop-setup.log\`."
  echo
  echo "| Kind | Name | From |"
  echo "|---|---|---|"
  cat "$ROWS"
} > "$MANIFEST"

log "installed $(grep -c . "$INSTALLED" || true) skills and agents; manifest: $MANIFEST"
rm -rf "$WORK"
exit 0
