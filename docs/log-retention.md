# Log retention

What in your data repository's `logs/` grows, what deletes itself, and how to archive the rest.
Nothing here is automated: the engine never archives or deletes your history. Paths are relative
to `VAULT_PROJECT_DIR`, except `DECISIONS_ARCHIVE_DIR`, which must be absolute (see below).

## Files that delete themselves

Queues. Each file is removed once its content has moved to its final place, so a healthy
repository holds none of them between runs. A file that lingers is work not done.

| Path                                               | Written by                                                       | Deleted by                | When                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------- |
| `logs/pending/<date>-<ticker>.md`                  | heartbeat ([handoff mode](glossary.md#reasoner-api-and-handoff)) | `pending:resolve`         | The answer is validated and recorded, blocked or not                  |
| `logs/pending-screening/<date>-<ticker>.md`        | `screening:prepare`                                              | `screening:resolve`       | The candidate's result is recorded                                    |
| `logs/pending-screening/results.jsonl`, `run.json` | `screening:resolve`, `prepare`                                   | `screening:summarize`     | The run's summary email is sent (or email is off); kept if it was not |
| `logs/outbox/*.json`                               | any flow with `MAIL_TRANSPORT=outbox`                            | `outbox:send` (the relay) | The email was sent; a file that failed to send is kept and retried    |
| `logs/heartbeat-sent-eur.json`, `-usd.json`        | heartbeat                                                        | rewritten daily           | Holds only today's alert keys, so it does not grow                    |

If a `pending` file stays for days, the [reasoner](glossary.md#reasoner-api-and-handoff) did not run: resolve it, or delete it by hand if
the signal is stale (it is not in the decision log until resolved).

## Files that grow

| Path                                                                 | What it is                                                            | Read back by                                                                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `logs/decisions.jsonl`                                               | The [decision log](decisions/0006-single-append-only-decision-log.md) | Everything: recording, the two-month rule, attribution, the heartbeat, the Monday briefing, the evaluation |
| `logs/<date>-<ticker>.md`                                            | One Markdown log per analysed signal                                  | The re-analysis cooldown (latest of the ticker); the Monday briefing (last 30 days)                        |
| `logs/<date>-monday-briefing.md`                                     | Weekly report                                                         | Nobody; the decision log holds its decisions                                                               |
| `logs/decisions-evaluation.md`, `.svg`, `logs/screening-outcomes.md` | Reports, regenerated on each run: never archive them                  | The Monday briefing reads `decisions-evaluation.md`                                                        |

## Archiving old logs

Markdown logs older than 30 days are not read by the briefing. Keep the latest log of each
ticker you still follow: the cooldown reads it (without it the only effect is one earlier
re-analysis, not an error). Move the rest to wherever you keep history (another folder or
repository), by year or quarter. The destination is outside the repository, so use `mv` and tell
git the files are gone (`git mv` cannot cross the repository boundary):

```bash
mkdir -p ../archive/logs/2026-Q3
# Review the list first and drop from it the latest log of every ticker you still follow.
ls logs/2026-0[7-9]-*.md
mv logs/2026-0[7-9]-*.md ../archive/logs/2026-Q3/ && git rm --cached --quiet logs/2026-0[7-9]-*.md
```

## Archiving decision-log quarters

`logs/decisions.jsonl` is append-only and loses nothing, but it only grows. Archive a **closed
quarter** once it is older than the three months the live file keeps (ADR-0006), in a dedicated
commit made when no automated run is in flight. The data repository holds your real positions and
P&L: keep it, and the archive, private.

What stays in the live file, whatever its date:

- the `entry` of a position you still hold (an entry no `exit` points to through `related_id`):
  `decision:record` looks it up in the live file to link the exit, and the evaluation pairs exits
  with entries only through that link, so archiving it away loses that trade's R for good. The
  commands below keep those entries and archive everything else in the quarter;
- anything from the last three months: the two-month rule and the attribution of trades to
  proposals (10-day window) read the live file only.

`DECISIONS_ARCHIVE_DIR` must be an **absolute** path. The engine does not resolve it against
`VAULT_PROJECT_DIR`: a relative path is resolved against the working directory of whatever runs
the engine, and a directory that does not exist is silently ignored, so archived quarters would
drop out of the evaluation without a warning.

1. Pick the quarter, for example Q2 2026 (`2026-04-01` to `2026-06-30`), and set the variables.
   The file name must match `decisions-<anything>.jsonl`; use `decisions-YYYY-QN.jsonl`, since the
   files are read in name order.

   ```bash
   QUARTER=2026-Q2 FROM=2026-04-01 TO=2026-06-30
   DECISIONS_ARCHIVE_DIR=/absolute/path/to/archive # the value you set in .env
   ARCHIVE="$DECISIONS_ARCHIVE_DIR/decisions-$QUARTER.jsonl"
   PROGRAM='. as $all
     | [range(0; length) as $i | $all[$i] as $e
       | select($e.date >= $from and $e.date <= $to)
       | (($e.type == "entry")
          and ([$all[] | select(.type == "exit" and .related_id == $e.id)] | length) == 0) as $open
       | select($open | not) | $e] as $archivable
     | .[] | . as $e | select(([$archivable[] | select(.id == $e.id)] | length > 0) == ($mode == "archive"))'
   ```

2. Copy the quarter's lines to the archive. It refuses to run when the target already exists, so
   a repeat cannot overwrite an archive with fewer lines:

   ```bash
   : "${DECISIONS_ARCHIVE_DIR:?set it to the absolute path of the archive directory}" &&
     case "$DECISIONS_ARCHIVE_DIR" in /*) ;; *) echo "DECISIONS_ARCHIVE_DIR must be absolute" >&2; false ;; esac &&
     { [ ! -e "$ARCHIVE" ] || { echo "$ARCHIVE exists: check it, delete it if step 3 never ran" >&2; false; }; } &&
     mkdir -p "$DECISIONS_ARCHIVE_DIR" &&
     jq -c -s --arg from "$FROM" --arg to "$TO" --arg mode archive "$PROGRAM" logs/decisions.jsonl > "$ARCHIVE" &&
     wc -l "$ARCHIVE"
   ```

3. Check the archive has the lines you expect, then remove them from the live file. The live file
   is replaced only if the lines add up (live before = live after + archived), and a `jq` failure
   on a malformed line stops before anything is touched:

   ```bash
   BEFORE=$(wc -l < logs/decisions.jsonl) && ARCHIVED=$(wc -l < "$ARCHIVE") &&
     jq -c -s --arg from "$FROM" --arg to "$TO" --arg mode live "$PROGRAM" logs/decisions.jsonl > logs/decisions.jsonl.new &&
     AFTER=$(wc -l < logs/decisions.jsonl.new) &&
     { [ $((BEFORE)) -eq $((AFTER + ARCHIVED)) ] || { echo "line counts do not add up: live file NOT replaced" >&2; false; }; } &&
     mv logs/decisions.jsonl.new logs/decisions.jsonl
   ```

4. Commit the live file (and the archive, if it is versioned).

Repeating: the engine counts a decision present in both places once, by `id`, so overlapping
archives are harmless to the reports. The procedure itself is safe to repeat: step 2 refuses to
overwrite an existing archive (if step 3 failed and left the live file untouched, delete that
archive file and start again), and a second run of step 3 finds nothing left to remove, so the
line counts no longer add up and the live file is not replaced.

## Reading the archive back

Set `DECISIONS_ARCHIVE_DIR` to the absolute path of the directory holding the `decisions-*.jsonl`
files (see [`.env.example`](../.env.example)). Unset or empty means no archive; a path that does
not exist is ignored without a warning. `npm run decisions:evaluate` (the SLO report and the
[silo](glossary.md#silo) reconstruction, which need the whole history) and
`npm run decisions:chart` read it: they load the archived files in name order and then the live
file. The variable must be set wherever those commands run, including your CI. A line that does
not validate is skipped with a warning naming the file and line.

## See also

- [Keep the portfolio in sync and record trades](../examples/brain/routines/portfolio-sync.md).
- [ADR-0006](decisions/0006-single-append-only-decision-log.md): why a single append-only log.
