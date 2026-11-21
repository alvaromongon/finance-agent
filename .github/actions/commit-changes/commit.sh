#!/usr/bin/env bash
# Applies the patch a reusable workflow left and commits only the given paths, as the `commit-changes` action.
#
# Why it is not `git pull --rebase && git push` (ADR-0018, #134): the engine's state (STATE_PATHS: the store and the view
# generated from it) is written by runs that can overlap, and the patch of a heartbeat or a briefing carries the engine's
# price refresh over the state it read. If another run committed state since the checkout this run started from (BASE),
# a textual merge could mix the two states, so this run's state changes are dropped, with a warning: the refresh of
# prices is rewritten whole by the next run, and nothing the owner told the engine is lost. Everything else in the patch
# (logs, the briefing's files) is still committed. A push that loses a race is retried from the remote's new head.
set -euo pipefail

: "${PATCH_FILE:?}" "${COMMIT_PATHS:?}" "${COMMIT_MESSAGE:?}"
STATE_PATHS="${STATE_PATHS:-}"
REMOTE="${COMMIT_REMOTE:-origin}"
REF="${GITHUB_REF_NAME:?}"
ATTEMPTS="${COMMIT_ATTEMPTS:-3}"

if [ ! -s "$PATCH_FILE" ]; then
  echo "The run changed no data — nothing to commit."
  exit 0
fi

git config user.name "finance-agent[bot]"
git config user.email "finance-agent@users.noreply.github.com"
BASE="$(git rev-parse HEAD)"

for attempt in $(seq 1 "$ATTEMPTS"); do
  git fetch --quiet "$REMOTE" "$REF"
  git reset --quiet --hard "$REMOTE/$REF"

  excludes=()
  # shellcheck disable=SC2086 # the paths are separated by spaces, as in COMMIT_PATHS
  if [ -n "$STATE_PATHS" ] && ! git diff --quiet "$BASE" "$REMOTE/$REF" -- $STATE_PATHS; then
    echo "::warning::The state changed in $REMOTE/$REF since this run started: its changes to $STATE_PATHS are not committed (the next run refreshes them)."
    for path in $STATE_PATHS; do
      excludes+=("--exclude=${path%/}" "--exclude=${path%/}/*")
    done
  fi

  # --3way: the remote may have moved other files (logs) since BASE; the patch is merged over them.
  if ! git apply --3way --binary ${excludes[@]+"${excludes[@]}"} "$PATCH_FILE"; then
    echo "::error::The run's changes do not apply over $REMOTE/$REF (a file they change was changed there too)."
    exit 1
  fi
  # Only what changed is added: a path the run never created (no store before the first ingest) is not a pathspec
  # `git add` accepts.
  # shellcheck disable=SC2086
  git ls-files -z --modified --deleted --others --exclude-standard -- $COMMIT_PATHS | xargs -0 -r git add -A --
  if git diff --cached --quiet; then
    echo "Nothing to commit under the given paths."
    exit 0
  fi
  git commit --quiet -m "$COMMIT_MESSAGE $(date -u +%Y-%m-%d)"

  if out="$(git push --quiet "$REMOTE" "HEAD:$REF" 2>&1)"; then
    exit 0
  fi
  if ! grep -Eq '\[(remote )?rejected\].*(non-fast-forward|fetch first|stale info|failed to update ref|cannot lock ref)' <<<"$out"; then
    echo "$out" >&2
    exit 1
  fi
  echo "Attempt $attempt of $ATTEMPTS lost the race: the remote has new commits."
done

echo "::error::The push lost the race $ATTEMPTS times; the changes were not committed."
exit 1
