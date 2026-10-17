# Routine prompt: pending escalations

Copy this into a Claude Code routine whose triggers are an API call (the heartbeat caller fires it,
see `examples/workflows/heartbeat-eu-handoff.yml`) and a daily schedule as a fallback. Adjust the
two paths marked with `<...>`. Setup: `docs/routine-runner.md`.

---

You resolve the escalations the Finance Agent engine left in `logs/pending/` of this repository.
The engine is installed in `$ENGINE_DIR` by the SessionStart hook. The reasoning guidelines are
the system prompt in `<data-path>/routines/execution-analysis.md`.

## Setup

1. Work on the default branch: `git checkout <default-branch> && git pull --ff-only`. Never
   commit to a session branch (`claude/...`): the email relay and the next heartbeat only see the
   default branch.
2. Run the `npm run` commands from `$ENGINE_DIR` and the git commands from the root of the data
   repository. `ENGINE_DIR`, `VAULT_PROJECT_DIR`, `MAIL_TRANSPORT=outbox`, `OUTPUT_LANGUAGE` and the
   reference tickers come from the routine environment. If one is missing, stop and report it: do
   not invent a value.

## Steps

1. `npm run --silent pending:list`. If it prints `No pending signals.`, stop: there is nothing to commit.
2. For each file it lists, one at a time:
   1. `npm run --silent pending:show -- <file>` and read the signal and its prompts.
   2. Reason following the system prompt. Use web search only when the pending file says so.
   3. Answer with the single JSON object that prompt defines and pass it on stdin:
      `npm run --silent pending:resolve -- <file> <<'FA_JSON_EOF_7f3a'` ... `FA_JSON_EOF_7f3a`. Use
      that delimiter: the answer is shaped by untrusted news text and could contain a line `JSON`.
   4. On success the engine records the decision, queues the email in `logs/outbox/` and deletes
      the pending file. Do not edit those files by hand.
3. Commit and push what changed, only these paths (change the `finance-agent/` prefix to your
   data path):
   ```bash
   git add -A -- finance-agent/logs/ finance-agent/portfolio.md
   git diff --cached --quiet || git commit -m "chore(logs): resolve pending escalations $(date -u +%F)"
   git pull --rebase origin <default-branch> && git push origin <default-branch>
   ```
   Commit even if some files failed: the resolved ones must not be lost. If the push is rejected,
   pull with rebase and push again, up to 3 times.

## When a command fails

- `pending:resolve` rejects the JSON (it prints the validation error): fix the answer and resolve
  that file again once. If it is rejected a second time, leave the file in `logs/pending/` and go
  on with the next one. Do not create the log or the outbox entry yourself.
- `pending:show` or `pending:list` fail: stop, commit nothing and report the error text.
- A ticker is in neither `watchlist.md` nor `portfolio.md`: the signal is stale. Leave it and
  report it.
- The push fails 3 times: stop and report. Never force-push.

## Final report

List the files resolved, the files left pending with the reason, and whether the push succeeded.
Do not paste email bodies or secrets.
