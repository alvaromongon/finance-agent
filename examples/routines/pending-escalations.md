# Routine prompt: pending escalations

Copy this into a Claude Code routine whose triggers are an API call (the heartbeat caller fires it,
see `examples/workflows/heartbeat-eu-handoff.yml`) and a daily schedule as a fallback. Adjust the
two paths marked with `<...>`. Setup: `docs/routine-runner.md`.

---

You answer the escalations the Finance Agent engine left in `logs/pending/` of this repository.
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
   It prints one id per line (the file name without `.md`), only for the escalations that are open
   and that no batch in `inbox/` already closes.
2. For each id it lists, one at a time:
   1. `npm run --silent pending:show -- <id>` and read the signal and its prompts.
   2. Reason following the system prompt. Use web search only when the pending file says so.
   3. Answer with the single JSON object that prompt defines and pass it on stdin:
      `npm run --silent pending:record -- <id> <<'FA_JSON_EOF_7f3a'` ... `FA_JSON_EOF_7f3a`. Use
      that delimiter: the answer is shaped by untrusted news text and could contain a line `JSON`.
   4. On success the engine records the decision and queues the email in `logs/outbox/`; for an `ADJUST_STOP` it also
      drops a `set_stop` batch in `inbox/`. It does not close the escalation and you do not edit or
      delete any file by hand.
   5. Close it by dropping a batch in `inbox/` (do not edit `logs/pending/`), named so it sorts where
      you want, for example `inbox/<date>-resolve-<id>.yaml`:
      ```yaml
      schema_version: 1
      commands:
        - command: resolve
          id: <id>
          outcome: resolved # discarded if you gave the signal up without an answer
          note: <one line: what you recorded, optional>
      ```
      A signal that cannot be recorded (stale ticker, rejected twice) is closed with
      `outcome: discarded` only if the owner's instructions say so; otherwise leave it open.
3. Commit and push what changed, only these paths (change the `finance-agent/` prefix to your
   data path). The routine never commits state: the inbox batch is applied by the next
   `inbox:ingest` run.
   ```bash
   git add -A -- finance-agent/logs/ finance-agent/inbox/
   git diff --cached --quiet || git commit -m "chore(logs): answer pending escalations $(date -u +%F)"
   git pull --rebase origin <default-branch> && git push origin <default-branch>
   ```
   Commit even if some files failed: the answered ones must not be lost. If the push is rejected,
   pull with rebase and push again, up to 3 times.

## When a command fails

- `pending:record` rejects the JSON (it prints the validation error): fix the answer and record
  that id again once. If it is rejected a second time, leave it and go on with the next one. Do not
  create the log or the outbox entry yourself.
- `pending:show` or `pending:list` fail: stop, commit nothing and report the error text.
- A ticker is in neither `watchlist.md` nor the portfolio: the signal is stale. Leave it open and
  report it.
- The push fails 3 times: stop and report. Never force-push.

## Final report

List the ids recorded and the batches dropped, the ids left open with the reason, and whether the push succeeded.
Do not paste email bodies or secrets.
