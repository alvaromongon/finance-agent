# Log retention

What in your data repository's `logs/` grows, what deletes itself, and how to archive the rest.
Nothing here is automated: the engine never archives or deletes your history. Paths are relative
to `VAULT_PROJECT_DIR`.

## Files that delete themselves

Queues. Each file is removed once its content has moved to its final place, so a healthy
repository holds none of them between runs. A file that lingers is work not done.

| Path                                               | Written by                            | Deleted by                | When                                                                  |
| -------------------------------------------------- | ------------------------------------- | ------------------------- | --------------------------------------------------------------------- |
| `logs/pending/<date>-<ticker>.md`                  | heartbeat (handoff mode)              | `pending:resolve`         | The answer is validated and recorded, blocked or not                  |
| `logs/pending-screening/<date>-<ticker>.md`        | `screening:prepare`                   | `screening:resolve`       | The candidate's result is recorded                                    |
| `logs/pending-screening/results.jsonl`, `run.json` | `screening:resolve`, `prepare`        | `screening:summarize`     | The run's summary email is sent (or email is off); kept if it was not |
| `logs/outbox/*.json`                               | any flow with `MAIL_TRANSPORT=outbox` | `outbox:send` (the relay) | The email was sent; a file that failed to send is kept and retried    |
| `logs/heartbeat-sent-eur.json`, `-usd.json`        | heartbeat                             | rewritten daily           | Holds only today's alert keys, so it does not grow                    |

If a `pending` file stays for days, the reasoner did not run: resolve it, or delete it by hand if
the signal is stale (it is not in the decision log until resolved).

## Files that grow

| Path                                                                 | What it is                                                            | Read back by                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `logs/decisions.jsonl`                                               | The [decision log](decisions/0006-single-append-only-decision-log.md) | Everything: recording, the two-month rule, attribution, the evaluation              |
| `logs/<date>-<ticker>.md`                                            | One Markdown log per analysed signal                                  | The re-analysis cooldown (latest of the ticker); the Monday briefing (last 30 days) |
| `logs/<date>-monday-briefing.md`                                     | Weekly report                                                         | Nobody; the decision log holds its decisions                                        |
| `logs/decisions-evaluation.md`, `.svg`, `logs/screening-outcomes.md` | Reports                                                               | Regenerated on each run; never archive them                                         |

## Archiving old logs

Markdown logs older than 30 days are not read by the briefing. Move them to wherever you keep
history (another folder or repository), by year or quarter:

```bash
mkdir -p ../archive/logs/2026-Q3
git mv logs/2026-0[7-9]-*.md ../archive/logs/2026-Q3/
```

Keep the latest log of each ticker you still follow: the cooldown reads it. Without it the only
effect is one earlier re-analysis, not an error.

## Archiving decision-log quarters

`logs/decisions.jsonl` is append-only and loses nothing, but it only grows. Archive a **closed
quarter** once it is older than the three months the live file keeps (ADR-0006), in a dedicated
commit made when no automated run is in flight:

1. Pick the quarter, for example Q2 2026 (`2026-04-01` to `2026-06-30`).
2. Copy its lines, by `date`, to `decisions-2026-Q2.jsonl` in your archive directory. The name
   must match `decisions-<anything>.jsonl`; use `decisions-YYYY-QN.jsonl`, since the files are read
   in name order.

   ```bash
   mkdir -p "$DECISIONS_ARCHIVE_DIR"
   jq -c 'select(.date >= "2026-04-01" and .date <= "2026-06-30")' logs/decisions.jsonl \
     > "$DECISIONS_ARCHIVE_DIR/decisions-2026-Q2.jsonl"
   ```

3. Check the archive has the lines you expect (`wc -l`), then remove them from the live file:

   ```bash
   jq -c 'select(.date < "2026-04-01" or .date > "2026-06-30")' logs/decisions.jsonl > logs/decisions.jsonl.new
   mv logs/decisions.jsonl.new logs/decisions.jsonl
   ```

4. Commit the live file (and the archive, if it is versioned).

Do **not** archive away:

- the `entry` of a position you still hold: `decision:record` finds it in the live file to link
  the exit;
- anything from the last three months: the two-month rule and the attribution of trades to
  proposals (10-day window) read the live file only.

Archiving is safe to repeat or overlap: a decision in both places counts once, by `id`.

## Reading the archive back

Set `DECISIONS_ARCHIVE_DIR` to the directory holding the `decisions-*.jsonl` files (see
[`.env.example`](../.env.example)). Unset or empty means no archive. Only
`npm run decisions:evaluate` (the SLO report and the silo reconstruction, which need the whole
history) reads it: it loads the archived files in name order and then the live file. The
variable must be set wherever that command runs, including your CI. A line that does not validate
is skipped with a warning naming the file and line.

## See also

- [Keep the portfolio in sync and record trades](../examples/brain/routines/portfolio-sync.md).
- [ADR-0006](decisions/0006-single-append-only-decision-log.md): why a single append-only log.
