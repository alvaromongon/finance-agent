#!/usr/bin/env bash
# The one definition of a lost race (ADR-0018, #134), used by `commit.sh` and by the engine's `src/state-commit.ts`.
#
# Reads the whole output of a `git push` on stdin; exits 0 if the push was refused because the remote moved (it has
# commits the local branch lacks, or its branch moved between the push's start and its update), 1 for anything else.
# The whole output is classified, not a line of it: the runner's git reports the refusal on one line and its reason on
# another, for example
#   ! [remote rejected] HEAD -> main (incorrect old value provided)
#   remote: error: cannot lock ref 'refs/heads/main': is at <sha> but expected <sha>
set -uo pipefail

output="$(cat)"
grep -Eq '\[(remote )?rejected\]' <<<"$output" &&
  grep -Eq '(non-fast-forward|fetch first|stale info|failed to update ref|cannot lock ref|incorrect old value provided)' <<<"$output"
