# Routine prompt: weekly screening

Copy this into a Claude Code routine with a weekly schedule (for example Saturdays 08:00 UTC).
Adjust the paths marked with `<...>`. Setup: `docs/routine-runner.md`.

---

You run this week's Finance Agent screening for the repository you are in. The engine is installed
in `$ENGINE_DIR` by the SessionStart hook. The system prompt is
`<data-path>/routines/weekly-screening.md`: read it first and follow its JSON format exactly.

## Setup

1. Work on the default branch: `git checkout <default-branch> && git pull --ff-only`. Never
   commit to a session branch (`claude/...`).
2. Run every command from `$ENGINE_DIR`. The environment must define `VAULT_PROJECT_DIR`,
   `MAIL_TRANSPORT=outbox`, `OUTPUT_LANGUAGE` and the reference tickers. If one is missing, stop
   and report it.

## Steps

1. `npm run screening:prepare`. It ranks the universe, picks the candidates and writes one file
   per candidate to `logs/pending-screening/`; it prints their names, one per line. If it prints
   none, stop.
2. Commit and push the prepared run now, so a session that dies halfway does not lose the
   candidates (change the `finance-agent/` prefix to your data path):
   ```bash
   git add -A -- finance-agent/logs/
   git commit -m "chore(screening): prepare weekly screening $(date -u +%F)"
   git pull --rebase origin <default-branch> && git push origin <default-branch>
   ```
3. For each candidate file, one at a time:
   1. Read `finance-agent/logs/pending-screening/<file>`: technicals, setups, rank and headlines.
   2. Reason following the system prompt and use web search for the business context.
   3. Pass the single JSON object on stdin: `npm run screening:resolve -- <file> <<'JSON'` ...
      `JSON`. On success the engine records the log entry, the thesis and the watchlist entry,
      and deletes the file.
4. Commit and push the results the same way as step 2, with
   `git add -A -- finance-agent/logs/ finance-agent/tesis/ finance-agent/watchlist.md finance-agent/screening-log.md`
   and the message `chore(screening): weekly screening <date>`.
5. Do not run `screening:summarize`. The pushed `logs/pending-screening/results.jsonl` triggers the
   email relay, which composes and sends the run's summary (including candidates left
   unresolved). The email relay is required in this runner.

## When a command fails

- `screening:prepare` fails (typically Yahoo unreachable: check the network allowlist,
  `docs/routine-runner.md`): stop, commit nothing and report the error.
- `screening:resolve` rejects the JSON (it prints the validation error, for example a forbidden
  `conviction` field): fix it and resolve that file again once. If it fails a second time, leave
  the file and go on with the next candidate.
- The push fails 3 times: stop and report. Never force-push.

## Final report

List the candidates resolved (interesting or not), the ones left unresolved with the reason, and
and whether the results were pushed.
