#!/usr/bin/env bash
# Applies the patch a reusable workflow left and commits only the given paths, as the `commit-changes` action.
#
# Why it is not `git pull --rebase && git push` (ADR-0018, #134): the engine's state (STATE_PATHS: the store and the view
# generated from it) is written by runs that can overlap, and the patch of a heartbeat or a briefing carries the engine's
# price refresh over the state it read. If another run committed state since the checkout this run started from (BASE),
# a textual merge could mix the two states, so this run's state changes are dropped, with a warning: the refresh of
# prices is rewritten whole by the next run, and nothing the owner told the engine is lost. Everything else in the patch
# (logs, the briefing's files) is still committed. A push that loses a race is retried from the remote's new head; what
# is a lost race is decided by `is-lost-race.sh`, the one definition the engine's `src/state-commit.ts` uses too.
#
# Nothing outside what the patch touched is changed: the checkout is moved to the remote's head with a fast-forward, and
# after a lost race only the files the patch touched are put back as they were (never a repository-wide `reset --hard`
# or `clean`), so untracked files of earlier steps neither get lost nor make the retry's apply fail.
set -euo pipefail

: "${PATCH_FILE:?}" "${COMMIT_PATHS:?}" "${COMMIT_MESSAGE:?}"
STATE_PATHS="${STATE_PATHS:-}"
REMOTE="${COMMIT_REMOTE:-origin}"
REF="${GITHUB_REF_NAME:?}"
ATTEMPTS="${COMMIT_ATTEMPTS:-3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -s "$PATCH_FILE" ]; then
  echo "The run changed no data — nothing to commit."
  exit 0
fi

git config user.name "finance-agent[bot]"
git config user.email "finance-agent@users.noreply.github.com"
BASE="$(git rev-parse HEAD)"
TOUCHED="$(git rev-parse --git-path commit-changes-touched)"

# After a lost race: drops this run's commit and puts back, as they were before it, the files the patch touched (the
# ones it created are removed). Everything else in the checkout is left alone.
undo_run() {
  git reset --quiet --mixed "$BEFORE"
  while IFS= read -r -d '' file; do
    if git cat-file -e "$BEFORE:./$file" 2>/dev/null; then
      git checkout --quiet "$BEFORE" -- "$file"
    else
      rm -f -- "$file"
    fi
  done <"$TOUCHED"
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  git fetch --quiet "$REMOTE" "$REF"
  git merge --quiet --ff-only "$REMOTE/$REF"
  BEFORE="$(git rev-parse HEAD)"

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
  # --3way stages everything the patch touches: note which files they are (for `undo_run`), then unstage them, so that
  # only the given paths are committed.
  git diff --cached --name-only --no-renames --relative -z >"$TOUCHED"
  git reset --quiet
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
  if ! "$HERE/is-lost-race.sh" <<<"$out"; then
    echo "$out" >&2
    exit 1
  fi
  echo "Attempt $attempt of $ATTEMPTS lost the race: the remote has new commits."
  undo_run
done

echo "::error::The push lost the race $ATTEMPTS times; the changes were not committed."
exit 1
