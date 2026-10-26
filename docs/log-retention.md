# Log retention

What in your data repository's `logs/` grows, what deletes itself, and how to archive the rest.
Nothing here is automated: the engine never archives or deletes your history. Paths are relative
to `VAULT_PROJECT_DIR`, except `DECISIONS_ARCHIVE_DIR`, which must be absolute (see below).

## Files that delete themselves

Queues. Each file is removed once its content has moved to its final place, so a healthy
repository holds none of them between runs. A file that lingers is work not done.

| Path                                               | Written by                                                                                | Deleted by                | When                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------- |
| `logs/pending/<date>-<ticker>.md`                  | [heartbeat](glossary.md#heartbeat) ([handoff mode](glossary.md#reasoner-api-and-handoff)) | `pending:resolve`         | The answer is validated and recorded, blocked or not                  |
| `logs/pending-screening/<date>-<ticker>.md`        | `screening:prepare`                                                                       | `screening:resolve`       | The candidate's result is recorded                                    |
| `logs/pending-screening/results.jsonl`, `run.json` | `screening:resolve`, `prepare`                                                            | `screening:summarize`     | The run's summary email is sent (or email is off); kept if it was not |
| `logs/outbox/*.json`                               | any flow with `MAIL_TRANSPORT=outbox`                                                     | `outbox:send` (the relay) | The email was sent; a file that failed to send is kept and retried    |
| `logs/heartbeat-sent-eur.json`, `-usd.json`        | [heartbeat](glossary.md#heartbeat)                                                        | rewritten daily           | Holds only today's alert keys, so it does not grow                    |

If a `pending` file stays for days, the [reasoner](glossary.md#reasoner-api-and-handoff) did not run: resolve it, or delete it by hand if
the signal is stale (it is not in the [decision log](glossary.md#decision-log) until resolved).

## Files that grow

| Path                                                                 | What it is                                           | Read back by                                                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `logs/decisions.jsonl`                                               | The [decision log](glossary.md#decision-log)         | Everything: recording, the two-month rule, attribution, the heartbeat, the Monday briefing, the evaluation |
| `logs/<date>-<ticker>.md`                                            | One Markdown log per analysed signal                 | The re-analysis cooldown (latest of the ticker); the Monday briefing (last 30 days)                        |
| `logs/<date>-monday-briefing.md`                                     | Weekly report                                        | Nobody; the decision log holds its decisions                                                               |
| Report files of the emails not sent (see below)                      | With email off, each message as a Markdown file      | The Monday briefing, if the name starts with a date (last 30 days); otherwise nobody: you read them        |
| `logs/decisions-evaluation.md`, `.svg`, `logs/screening-outcomes.md` | Reports, regenerated on each run: never archive them | The Monday briefing reads `decisions-evaluation.md`                                                        |

## Report files written when email is off

With `MAIL_TRANSPORT=none` (`email: false` in the reusable workflows) nothing is sent. From
[#33](https://github.com/alvaromongon/finance-agent/issues/33) on, each message the engine would
have emailed (heartbeat digest, screening summary, Monday briefing summary, alerts) is written
instead as one Markdown file under `logs/`, with its subject, body and source, named so that it
sorts by date. They are for you to read in the data repository. Nothing deletes them, so they grow
like the other Markdown logs and are archived the same way (next section). They are not write-only: the Monday briefing reads every `logs/<YYYY-MM-DD>*.md` of the last 30 days, apart
from the files with `weekly-review` or `monday-briefing` in their name, as context for its
summary. A report file whose name starts with a date is therefore read back for 30 days; one
whose name does not is not (`src/monday-briefing.ts`). Until #33
lands, the engine writes no such file and an email that is off is only logged.

## Archiving old logs

Markdown logs older than 30 days are not read by the briefing. Keep the latest log of each
ticker you still follow: the cooldown reads it (without it the only effect is one earlier
re-analysis, not an error). Move the rest to wherever you keep history (another folder or
repository), by year or quarter. The destination is outside the repository, so use `mv` and tell
git the files are gone (`git mv` cannot cross the repository boundary). The commands never
overwrite: if a file of the same name is already in `$DEST` they stop before moving anything (and
`mv -n` would refuse it anyway).

Move only what you reviewed, never a whole glob: list the candidates, drop from the list the latest
log of every ticker you still follow, and put what is left in `FILES`. The expansions are quoted,
so the same lines work in bash and in zsh (an unquoted glob in `git rm --cached` makes zsh stop
with "no matches found" once the files have moved):

```bash
ls logs/2026-0[7-9]-*.md # review this list first
FILES=(logs/2026-07-14-ko.md logs/2026-08-03-sap-de.md) # only the files you reviewed
DEST=../archive/logs/2026-Q3
mkdir -p "$DEST" &&
  CLASH=$(for f in "${FILES[@]}"; do [ -e "$DEST/${f##*/}" ] && echo "$DEST/${f##*/}"; done; true) &&
  { [ -z "$CLASH" ] || { echo "already archived, nothing moved: $CLASH" >&2; false; }; } &&
  mv -n -- "${FILES[@]}" "$DEST/" && git rm --cached --quiet -- "${FILES[@]}"
```

## Archiving decision-log quarters

`logs/decisions.jsonl` is append-only and loses nothing, but it only grows. Archive a **closed
quarter** once it is older than the three months the live file keeps (ADR-0006), in a dedicated
commit made when no automated run is in flight. The data repository holds your real positions and
P&L: keep it, and the archive, private.

What stays in the live file, whatever its date:

- **every line of a [lot](glossary.md#lot) that is still open**: its `entry` and all its `exit`
  lines, partial sales included. A lot is open until an `exit` citing it has `lot_units_left` 0 (an
  `exit` without `lot_units_left` does not use it up). A lot's entry and exits move to the archive
  only together, in the quarter of the `exit` that used the lot up, whatever the dates of the entry
  and of the earlier exits; until then they all stay. So a lot bought in Q1, partly sold in Q2 and
  used up in Q3 is archived by the Q3 run, in one piece. An `exit` that cites a lot that is never
  used up (one written before `lot_units_left` existed) stays with its entry;
- anything from the last three months. Archive only quarters older than that. Two readers read the
  live file only: the heartbeat and the two-month rule (an archived decision is invisible to them).

Every other line (deposits, withdrawals, conversions, proposals, stop changes, an `exit` that cites
no lot) is archived by its own date.

Why a lot goes whole: `decision:record` needs, to record a sale, the entry of each open lot (the
check of `Lots` against the log) and what the earlier exits of the lot took of its entry costs
(`entry_costs`, so the last exit takes the rest). Both come from the lot's own lines, which the
rule above leaves in the live file. The other history it reads is the proposal a trade follows
(10-day window) and the trades that already cite it, all recent. So **with no archive readable at
all, `decision:record` records every later sale correctly**; the archive adds nothing to it. The
exception is a trade dated in an archived quarter: its proposal is gone from the live file, so
the trade is recorded as yours (`propietario`) instead of the system's. Archives made with an earlier version of this program may hold the exits of a lot that was still
open: for those, `decision:record` still needs the archive readable.

`DECISIONS_ARCHIVE_DIR` must be an **absolute** path. The engine does not resolve it against
`VAULT_PROJECT_DIR`: a relative path is resolved against the working directory of whatever runs
the engine. The engine warns on stderr when it is unset, missing, not a directory or not absolute
(see below).

1. Pick the quarter, for example Q2 2026 (`2026-04-01` to `2026-06-30`), and set the variables.
   The file name must match `decisions-<anything>.jsonl`; use `decisions-YYYY-QN.jsonl`, since the
   files are read in name order.

   ```bash
   QUARTER=2026-Q2 FROM=2026-04-01 TO=2026-06-30
   DECISIONS_ARCHIVE_DIR=/absolute/path/to/archive # the value you set in .env
   ARCHIVE="$DECISIONS_ARCHIVE_DIR/decisions-$QUARTER.jsonl"
   PROGRAM='[.[] | select(.type == "exit" and .lot_units_left == 0 and .related_id != null)] as $closers
     | (reduce $closers[] as $x ({}; .[$x.related_id] = (if .[$x.related_id] == null or .[$x.related_id] < $x.date then $x.date else .[$x.related_id] end))) as $closed_on
     | def in_quarter: . != null and . >= $from and . <= $to;
     .[] | select((if .type == "entry" then ($closed_on[.id] | in_quarter)
         elif .type == "exit" and .related_id != null then ($closed_on[.related_id] | in_quarter)
         else (.date | in_quarter) end) == ($mode == "archive"))'
   ```

2. Copy the quarter's lines to the archive. It refuses to run when the target already exists, so
   a repeat cannot overwrite an archive with fewer lines. It writes to `decisions-<quarter>.jsonl.tmp`
   and moves the file into place only when `jq` succeeded, so a bad line cannot leave an empty
   archive behind that would block the retry (a `.tmp` file is never read as an archive):

   ```bash
   : "${DECISIONS_ARCHIVE_DIR:?set it to the absolute path of the archive directory}" &&
     case "$DECISIONS_ARCHIVE_DIR" in /*) ;; *) echo "DECISIONS_ARCHIVE_DIR must be absolute" >&2; false ;; esac &&
     { [ ! -e "$ARCHIVE" ] || { echo "$ARCHIVE exists: check it, delete it if step 3 never ran" >&2; false; }; } &&
     mkdir -p "$DECISIONS_ARCHIVE_DIR" &&
     { jq -c -s --arg from "$FROM" --arg to "$TO" --arg mode archive "$PROGRAM" logs/decisions.jsonl > "$ARCHIVE.tmp" ||
       { rm -f "$ARCHIVE.tmp"; false; }; } &&
     mv -n -- "$ARCHIVE.tmp" "$ARCHIVE" &&
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
files (see [`.env.example`](../.env.example)). `npm run decisions:evaluate` (the
[SLO](glossary.md#sli-and-slo) report and the [silo](glossary.md#silo) reconstruction, which need
the whole history), `npm run decisions:chart` and `npm run decision:record` read it: they load the
archived files in name order and then the live file. A line that does not validate is skipped with
a warning naming the file and line.

**Where it must be set.** Only where you want the full history: your `decisions:evaluate` and
`decisions:chart` runs, including the CI that runs them. `decision:record` does not need it (see
above); it uses it when it is there. **What is lost without it**: the evaluation measures the live
file only, so trades closed in an archived quarter drop out of the SLIs, and the silo
reconstruction cannot see archived flows (it then warns about negative cash or oversold units, and
the cutoff board says decisions are missing before a date). Nothing is written wrongly: the
reports are regenerated on each run. The reusable workflows do not take the variable yet, so in
their CI the evaluation is of the live file until it does.

**Warnings.** The engine never changes its result for these, but says on stderr:

- unset or empty: `[vault-io] NOTE: DECISIONS_ARCHIVE_DIR is not set ...`, one line per run,
  not per read. If you have never archived, it is expected: ignore it;
- set but the directory does not exist, is not a directory, or cannot be read:
  `[vault-io] WARNING: DECISIONS_ARCHIVE_DIR "..." does not exist ...`; the live file is read alone;
- set but not absolute: `[vault-io] WARNING: ... is not an absolute path ...`; it is still read,
  against the working directory, which is why it is not reliable.

## See also

- [Keep the portfolio in sync and record trades](../examples/brain/routines/portfolio-sync.md).
- [ADR-0006](decisions/0006-single-append-only-decision-log.md): why a single append-only log.
