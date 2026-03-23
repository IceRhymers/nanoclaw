#!/usr/bin/env bash
# Updates the dev-workflow plugin skills from the marketplace remote.
# Usage: ./scripts/update-dev-workflow.sh

set -euo pipefail

REMOTE="marketplace"
REMOTE_URL="https://github.com/IceRhymers/claude-marketplace-builder.git"
PLUGIN_PATH="plugins/dev-workflow/skills"
SKILLS_DIR=".claude/skills"
SKILLS=(start-task finish-task check-regressions)

# Ensure remote exists
if ! git remote get-url "$REMOTE" &>/dev/null; then
  echo "Adding $REMOTE remote..."
  git remote add "$REMOTE" "$REMOTE_URL"
fi

echo "Fetching $REMOTE..."
git fetch "$REMOTE" --quiet

for skill in "${SKILLS[@]}"; do
  echo "Updating $skill..."
  mkdir -p "$SKILLS_DIR/$skill"
  git show "$REMOTE/main:$PLUGIN_PATH/$skill/SKILL.md" > "$SKILLS_DIR/$skill/SKILL.md"
done

echo "Done. Updated ${#SKILLS[@]} skills from dev-workflow plugin."
