# Routine prompt: Monday briefing

Copy this into a Claude Code routine with a weekly schedule (for example Mondays 06:00 UTC, before
the European open). Adjust the paths marked with `<...>`. Setup: `docs/routine-runner.md`.

---

You write this week's Finance Agent briefing for the repository you are in. The engine is
installed in `$ENGINE_DIR` by the SessionStart hook. The system prompt is
`<data-path>/routines/monday-briefing.md`: read it first and follow its report and
`AUTOMATED_ACTIONS` formats exactly.

## Setup

1. Work on the default branch: `git checkout <default-branch> && git pull --ff-only`. Never
   commit to a session branch (`claude/...`).
2. Run the `npm run` commands from `$ENGINE_DIR` and the git commands from the root of the data
   repository. The environment must define `ENGINE_DIR`, `VAULT_PROJECT_DIR`,
   `MAIL_TRANSPORT=outbox`, `OUTPUT_LANGUAGE` and the reference tickers. If one is missing, stop
   and report it.

## Steps

1. Evaluate the decision log first: `npm run --silent decisions:evaluate`. It writes
   `logs/decisions-evaluation.md`, which the briefing prompt reads.
2. `npm run --silent monday-briefing:prepare > /tmp/briefing-prompt.md`. It refreshes the prices in
   `portfolio.md` and prints the user prompt. Progress goes to stderr.
3. Read `/tmp/briefing-prompt.md` and write the report to `/tmp/briefing.md`. Use web search for
   the macro and sector section and cite each source; if search fails, say so in that section.
4. `npm run --silent monday-briefing:finalize < /tmp/briefing.md`. It validates the report, writes the log,
   retires the watchlist entries, archives their theses and queues the email in `logs/outbox/`.
5. Commit and push (change the `finance-agent/` prefix to your data path):
   ```bash
   git add -A -- finance-agent/logs/ finance-agent/portfolio.md finance-agent/watchlist.md finance-agent/tesis/
   git diff --cached --quiet || git commit -m "chore(logs): Monday briefing $(date -u +%F)"
   git pull --rebase origin <default-branch> && git push origin <default-branch>
   ```
   If the push is rejected, pull with rebase and push again, up to 3 times.

## When a command fails

- `decisions:evaluate` fails: go on without it and say so in the final report; the briefing
  prompt tolerates a missing evaluation.
- `monday-briefing:prepare` fails (typically Yahoo unreachable: check the network allowlist,
  `docs/routine-runner.md`): do not write a briefing from memory. Stop and commit nothing.
- `monday-briefing:finalize` rejects the report (it prints what is missing, for example a
  section heading or `PLAN_SUMMARY:`): fix the report and run it again once. If it fails twice,
  stop, commit nothing and report the error. Do not write the log or the outbox entry by hand.
- The push fails 3 times: stop and report. Never force-push.

## Final report

State whether the briefing was finalized and pushed, which tickers were retired, and any step
that was skipped.
