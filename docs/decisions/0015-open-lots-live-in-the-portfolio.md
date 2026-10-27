---
status: Accepted
date: 2026-10-27
decision-makers: Repository owner
---

# 0015. Open lots live in the portfolio, written by the engine; every exit carries a snapshot of its lot

**Decision**: the open lots of each position live in `portfolio.md`, written only by `decision:record`. A lot is the units of one ticker bought in a single entry. A sale consumes lots first in, first out (FIFO) and appends one self-contained `exit` line per lot consumed to the decision log (the append-only JSON Lines file of every decision and trade), carrying the lot's entry data. We expect realized R to be right for partial sales and scale-ins, and archiving any quarter of the log to leave the evaluation unchanged.

## Context and problem statement

An `exit` stored only its half of the trade and pointed to its entry through `related_id`. After a partial sale the rest of the position was left unlinked, scale-ins were not modelled, and archiving a quarter by date could strand an entry whose exit was archived. Matching a sale to its lots needs to know which lots are open, and `portfolio.md` held only a total volume and an average price per ticker, kept by hand.

**Why it matters**: the mean net R of closed trades, one of the measures the system is judged by, is wrong or missing exactly for partial and scaled trades, which are normal in swing trading. The owner trades real money on this output.

## Decision drivers

- Realized R is computed from one exit line, with no join that archiving can break.
- The portfolio is the single source of truth for what is owned and what is watched for risk.
- The owner reads the state and corrects it by hand, in git.
- Reading the whole log stays cheap: measured 2026-10-19, ~21 ms for 10,000 lines (see _More information_); estimated growth ~2,600 lines a year (assumption: fewer than 50 lines a week).

## Considered options

- **Derive open lots from the decision log**: entries minus the units their exits consumed.
- **Lots in `portfolio.md`, written by the engine**, with each exit carrying a snapshot of its lot.
- **A side file of open lots**, next to an unchanged `portfolio.md`.
- **Log with checkpoints**: derive lots from the log, and when a quarter is archived write an open-lots snapshot into the live log.
- **Do nothing**: keep `related_id` and the average price.

## Decision outcome

Chosen option: "lots in `portfolio.md`, written by the engine", because it is the only one where both the open state and each closed trade are readable without scanning or joining the log, and it keeps one source of truth for what is owned.

- `portfolio.md` gets a required `Lots` table per currency, in a new, incompatible version of its format; the version is per file, so no other file changes. Each row carries the ticker and what an exit needs to measure its trade: the entry id, date, units left and the entry's units, price, initial stop, costs, origin and rules. A file in the previous version is refused; there is no migration.
- `decision:record` is the only program that writes lots; the owner corrects them by hand (below). An entry adds a lot; a sale consumes lots first in, first out, writes one exit per lot consumed and keeps the ticker's position row in step with its lots. It appends to the decision log first and rewrites the portfolio second.
- Each exit carries a snapshot of its lot (the entry id and the entry data its R needs, its share of the entry costs, the units it sold and the units the lot has left), so it can be measured on its own. A lot is closed when an exit leaves it no units: the writer records that, the evaluation does not infer it. Inferring it by summing the units of the exits against a rounding slack was rejected: on a low-priced asset the slack can exceed a real unsold remainder (100 units at 0.02 with 99 sold at 0.01 would read as closed).
- A trade is one lot: its R is the units-weighted sum of the R of the exits that consumed it. Scale-ins are separate trades.
- The owner reconciles the position's volume against the broker and corrects a mismatch (a split, a partial fill, a recording mistake) by editing `Lots` by hand in a correction commit; a split multiplies the units by one ratio and divides the price and the stop by it, so R does not change.
- Lots are checked against the decision log on read. The commands that write or measure with the lots (`decision:record` and the evaluation) refuse a file whose lots do not match the log. The heartbeat checks the volume against the lots from `portfolio.md` alone and only warns, loudly and in every digest while it lasts, because a typo must never switch off stop alerts; every other reader tolerates a broken `Lots` table.

**What we give up**:

- The owner no longer edits position rows, only corrects lots.
- About five static entry fields are duplicated in every exit. This is safe because the log is append-only.
- No backward compatibility: portfolio files in the previous format and log lines without a snapshot are discarded, with no migration script. Accepted because the owner is the only user and starts from scratch on the new format instead of converting a live portfolio.

**Scope**: `decision:record`, the `portfolio.md` format with its reader and writer, the evaluation and its chart, and the owner's routine for keeping the portfolio in sync.

**Confidence**: medium. Revisit if:

- a second user arrives with a portfolio in the previous format, which would need a real migration;
- another consumer of entries cannot work from the snapshot;
- the evaluation takes more than 1 s, or the live log exceeds 10,000 lines (then consider views of the log).

### Consequences

- Good: realized R of a partial or scaled trade is computed from exit lines alone.
- Good: as long as a lot's entry and exits stay readable together while it is open, archiving a quarter cannot strand data a measurement needs.
- Good: the owner no longer has to record a sale before touching its row, because the engine updates the row.
- Bad: more than one process writes `portfolio.md`: the price refresh rewrites prices and `decision:record` rewrites lots and positions. A price refresh that works on a copy read before a recorded trade can write that trade's lot change away; the decision stays in the log. When that trade added a lot or used one up, the next check of the lots against the log refuses the file until the owner fixes `Lots`; when it only shrank a lot, the check cannot tell, and the owner notices it when reconciling against the broker. Between checkouts, writes to a Markdown table can also conflict when the calling repository merges them, which the decision log avoids by only appending lines. Moving prices to a file only the price refresh writes would remove both; it is left out until a conflict actually happens.
- Bad: `decision:record` writes two files. If it stops between the log and the portfolio, the exit exists but the lot does not shrink. When the sale used the lot up, the next check refuses the file; when the lot only shrank, the check cannot tell it from a split correction, so the owner has to notice it when reconciling against the broker.
- Bad: a hand correction of `Lots` is not traced in the log, only in git history.
- Bad: a lot written by hand can carry a transcription mistake into R; the check compares each lot with its entry to catch it. Every lot needs a real entry id, so open positions are recorded as entries, never typed straight into `Lots`.

### Confirmation

Engine tests with hand-calculated expectations, grouped as R1 to R5 in one suite, the measurable-exits suite, which runs in CI:

- R1: one entry and one exit give the same R as before this decision;
- R2: two partial exits of one entry count as one trade, weighted by units; a lot only partly sold is open, not a closed trade;
- R3: sales that span two lots are matched first in, first out, one R per lot;
- R4: archiving any quarter, including one that separates an entry from a later exit, leaves the evaluation unchanged when the archive is read; with the archive not set, the evaluation warns that decisions are missing instead of changing silently;
- R5: lots that do not match the log fail on read; a sale spanning two lots writes one exit per lot and keeps the lots and the position row consistent.

**Success measure**: those tests pass in CI. Measured 2026-10-27: the measurable-exits suite has 36 tests (R1 to R5 and the cases around them), and all 36 pass, in 1 local run and in the CI run of the same commit; before the change four of R1 to R5 failed (measured 2026-10-19). A check on the owner's real log was dropped, because the owner starts from scratch on the new format.

The rules that change with the code are not in this record: the table's columns and the checks are in the input format, how the file is read and written in the flow document, and the archive procedure in the log retention guide.

## Pros and cons of the options

### Derive open lots from the decision log

- Good: no format change; the log stays the only record.
- Bad: every sale scans the log, and archiving must keep each entry and its exits together until the lot closes; archiving by date already stranded entries this way.

### Lots in `portfolio.md`, written by the engine

- Good: open state readable at a glance in the file that already decides what is owned; exits are self-contained.
- Bad: a public versioned format changes; the engine becomes a writer of a file the owner used to keep by hand.

### A side file of open lots

- Good: `portfolio.md` unchanged.
- Bad: a second source of truth for what is owned, to keep in sync with the first.

### Log with checkpoints

- Good: the log stays the only source; the lots become a rebuildable view.
- Bad: every sale still reads the log from the last checkpoint, and the open state is not readable in the portfolio, where the owner reconciles against the broker.

### Do nothing

- Good: no cost.
- Bad: R stays wrong for partial and scaled trades.

## More information

Shapes rejected inside the chosen option: several rows per ticker in `Positions`, which breaks the one-row-per-ticker reader, and an encoded lot list in one column, which is unreadable when reconciling by hand.

Log read cost, measured 2026-10-19 on a synthetic JSONL of 684-byte lines (Node 25, owner's Mac, 7 runs per size, median and min–max): 1,000 lines 1.9 ms (1.9–2.5); 10,000 lines 21 ms (19–24); 100,000 lines 223 ms (210–251). Method: N copies of one realistic decision line, timing read + split + `JSON.parse` + an index by id, without the evaluation's computation. The log is never sent to Claude.

Doubt review (2026-10-19, fresh-context reviewer, one round). Each finding and how it was handled:

- Two-file write can stop halfway: addressed (log first, one commit, lot check on read).
- Heartbeat and recorder both write `portfolio.md`: accepted under _Bad_, with the alternative of a heartbeat-only price file left for when a conflict happens.
- Failing on read would stop risk watch: addressed (the heartbeat warns and keeps watching).
- FIFO assigns a stopped-out scale-in to the wrong lot: rejected. The stop is per ticker, so a stop sells the whole position and FIFO and lot choice give the same total.
- Hand corrections leave nothing in the log, and a split needs price and stop scaled: the split rule is addressed; the lack of trace is accepted under _Bad_.
- Missed option, log with checkpoints: added to the options and rejected.
- Trade R undefined for scale-ins: addressed (a trade is one lot).
- Pro-rata costs lose cents: design detail, outside this record (the last exit of a lot takes the remainder).
- The previous-format rewrite is risky, and open positions have no entry id: addressed (re-record as entries, check against a broker statement); later made moot, because the owner starts from scratch on the new format.
