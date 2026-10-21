#!/usr/bin/env bash
# ── PASTE THIS INTO THE ROUTINE'S CLOUD ENVIRONMENT, IN THE "Setup script" FIELD ──
#
# It runs once when the environment is built, before any session. It clones the orchestrator
# and runs scripts/cloud-skill-sync.sh, which copies into ~/.claude the orchestrator's own
# skills (loop-notify) and the skills and agents from every repo in SKILL_SOURCES, so the
# routine can call them by name. Then it runs any stacks you turn on below.
#
# TO PICK UP NEWER SKILLS: bump the `rebuild:` number and save. The environment is cached, and
# only a change to this field's text rebuilds it. A newer commit in a source repo doesn't.
#
# ALLOWED DOMAINS: the environment needs github.com, to clone, plus what each stack you turn on
# lists in its own header. Changing the allowed domains doesn't rebuild the environment by
# itself; bump `rebuild:` as well.
#
# SKILL NAMES: copied skills have no plugin prefix. Route prompts call `/issue-triage`, not
# `/my-plugin:issue-triage`.
#
# WHAT HAPPENED: ~/loop-setup.log and ~/loop-env-manifest.md, readable from inside a session.
set -u
# rebuild: 1

# Public repos to copy skills and agents from, in order. A later repo's skill replaces an
# earlier one with the same name. Add @branch to pin one.
SKILL_SOURCES=(
  # "https://github.com/owner/my-plugins"
  # "https://github.com/owner/other-plugins@some-branch"
)

ORCHESTRATOR="${LOOP_ORCHESTRATOR:-https://github.com/mattbrailsford/github-loop-orchestrator}"
ORCHESTRATOR_REF="${LOOP_ORCHESTRATOR_REF:-main}"
BOOT=/tmp/loop-boot

rm -rf "$BOOT"
if git clone --quiet --depth 1 --branch "$ORCHESTRATOR_REF" "$ORCHESTRATOR" "$BOOT"; then
  bash "$BOOT/scripts/cloud-skill-sync.sh" "$BOOT" ${SKILL_SOURCES[@]+"${SKILL_SOURCES[@]}"}
else
  echo "FATAL: could not clone $ORCHESTRATOR at $ORCHESTRATOR_REF; the environment has no skills." | tee -a "$HOME/loop-setup.log"
fi

# ── Stacks: what a session needs to build and run the product. Turn on what fits. ──

# Umbraco packages: the .NET SDK, an optional SQL Server image, and ~/.loop/run-umbraco.sh.
# Set --channel to the major.minor in the repo's global.json. Use --provider sqlserver for
# CI-parity runs (adds ~2.3 GB to the environment).
# bash "$BOOT/stacks/umbraco/setup.sh" --channel 10.0 --provider sqlite

# Anything else your stack needs goes below.
