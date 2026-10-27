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

- `portfolio.md` gets a required `Lots` table per currency, in a new, incompatible version of its format (`schema_version` 2; the version is per file, so no other file changes). Each row carries what an exit's snapshot needs, with `Ticker` first: ticker, entry id, date, units left, entry units, entry price, initial stop, entry costs, origin, rules version and rules violations. The ticker is in the row so that `Volume` can be checked against the lots from `portfolio.md` alone. The reader refuses a version 1 file; there is no reading of it and no migration.
- `portfolio.md` has one codec: parsing gives a model that keeps every line (notes and spacing included) and serializing writes it back, so read then write unchanged is identical. Its writers edit that model instead of patching text: `decision:record`, and the price update that both the heartbeat and the Monday briefing run. Neither drops the lines it did not change, except that `decision:record` drops placeholder rows of `Positions` when it rewrites that table. Only `decision:record` guards against an edit made meanwhile: it reads the file again right before it writes, applies its change to that text and writes atomically. The price update has no re-read and no lots check and writes the file in place (see _Consequences_).
- `decision:record` is the only writer of lots: an entry adds a lot; a sale consumes lots FIFO, writes one exit per lot consumed and recomputes `Volume` and `Avg price` in `Positions` (it creates the ticker's row on its first entry, with the lot's initial stop as `Stop loss`, the current price, or the average price when none is known, as `Current price`, a `P/L` of 0 and every other column empty; it updates only `Volume` and `Avg price` of an existing row, and deletes the row with the last lot). It appends to the log first and rewrites the portfolio second, and both changes go in one commit. A lot that a sale uses up is removed from `Lots`; its history lives in its exit lines.
- Each exit carries the snapshot of its lot, in optional fields of the decision log: `related_id` (the entry id of the lot, never the latest open entry), `entry_price`, `entry_units`, `entry_costs` (the exit's share of the lot's entry costs, pro rata to the units sold, the remainder on the last exit of the lot, so the shares add up exactly to the lot's costs), `entry_date`, `entry_origin`, `entry_rules_version`, `stop_initial`, `rule_violations`, `units` (the units the exit sold from its lot; the exits of one sale add up to the units sold) and `lot_units_left`. An exit's `amount` is its exact share of the sale amount (not rounded to the cent, the shares add up to the sale), so a lot with very few units can still be sold.
- A lot is closed when its last exit has `lot_units_left` = 0, the units the lot has left after that exit. The writer knows exactly when a lot is used up, so the evaluation does not infer it. Inferring it by summing the units of the exits against a rounding slack was rejected: on a low-priced asset the slack can exceed a real unsold remainder (100 units at 0.02 with 99 sold at 0.01 read as closed), exits of one lot that disagree go unnoticed, and the sum depends on float arithmetic. The evaluation also checks that, across a lot's exits followed by `lot_units_left`, highest first (the order they were written in, whatever their dates; a backdated sale breaks date order), `lot_units_left` falls by the units each exit sold (its `units`; `amount / price`, within cent rounding, only for an exit without it) and never below 0, and that the exits agree on the rest of the snapshot. Exits whose `entry_units`, `entry_price` and `stop_initial` differ by one common ratio r (a split corrected in `Lots` between two sales: units × r, price and stop ÷ r, the rule of the lots check) still agree, and their `units` and `lot_units_left` are rescaled by r before the check; a lot that fails is not measured and the report names it.
- A trade is one lot (one entry): its R is Σ(unitsᵢ / entry_units) × Rᵢ over the exits that consumed it. Scale-ins are separate trades.
- The owner reconciles `Volume` against the broker. A mismatch (split, partial fill, recording mistake) is fixed by editing `Lots` by hand in a correction commit. `decision:record` and the evaluation, which read the whole decision log, refuse the file when:
  - `Volume` differs from the sum of its lots' units;
  - a lot has more units than its entry bought, or two rows share an entry id;
  - a ticker is on several `Positions` rows, or a `Lots` row cannot be read (the message names it and the reason; the file is never rewritten around a row the reader skipped);
  - a lot's entry id is not in the log (the message says the quarter may be archived), its ticker is not its entry's, or its snapshot of the entry (price, units, initial stop, date, origin, rules version, rules violations, entry costs to the cent) differs from the entry's;
  - an entry in the log is still open and has no lot, where an entry is open until an exit citing it has `lot_units_left` = 0 (an entry whose log line has no `units` was recorded before this contract and is not checked);
  - a lot is still in `Lots` although an exit used it up.

  Once the file has parsed, all the messages of the lots comparison are reported together, so one round of fixes is enough for them; a `Positions` ticker that does not parse, or a `Lots` table that does not read (missing section or header), stops the read first, on its own. An unreadable `Lots` row does not stop it: it is reported with the other messages. The heartbeat does not read the log: it checks `Volume` against the lots from `portfolio.md` alone, after it has detected the crossed stops and with no catch of its own (a defect in the check fails the run visibly, with the stops already in the digest), keeps watching the positions for risk and raises a loud warning that is repeated in every digest while it lasts, because a typo must never switch off stop alerts. An unreadable or missing `Lots` table is the same warning there. Every other reader of the portfolio (`pending:resolve`, the Monday briefing, the weekly screening) uses only positions, cash and silo value (the Monday briefing also runs the price update) and tolerates a broken `Lots` table; only `decision:record` and the evaluation, which write or measure with the lots, refuse it. A split is corrected by scaling units, entry price and stop by one common ratio r (units × r, price and stop ÷ r), which the snapshot comparison accepts; any other difference is refused. The check cannot catch a wrong ratio. A split between two exits of one lot keeps the lot measurable for the same reason, and R does not change with a split. A partial sale that reached the log but not the portfolio cannot be told from a split correction, so it is not caught on read; the owner catches it when reconciling `Volume` with the broker.

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
- Good: archiving a quarter can never strand data a measurement needs.
- Good: the owner no longer has to record a sale before touching its row, because the engine updates the row.
- Bad: two kinds of writer now touch `portfolio.md`. The price update (run by the heartbeat and by the Monday briefing) rewrites prices, and `decision:record` rewrites lots and positions. `decision:record` re-reads before writing, so on one checkout it keeps an edit made meanwhile. The price update does not: it receives prices already fetched, then reads, edits and writes the file in place without a re-read, so a price update that read before a `decision:record` renamed its file and writes after it overwrites the new `Lots` and `Positions` rows with its stale copy, and the recorded trade is lost from the portfolio while its decision stays in the log. This is accepted as a known risk. What mitigates it today: the window is only the gap between the price update's read and its write, with no network call in between; the next read of `Lots` against the log refuses the file (an entry open in the log with no lot, or a lot still there although an exit used it up), and the owner reconciles `Volume` with the broker; no concurrency group or lock in the engine's repository serializes the two, and the heartbeat workflow only returns a patch that the calling repository's workflow commits, so any serialization there is outside what this record can state. Between checkouts a heartbeat run in flight while the owner records a trade can also conflict on rebase. The decision log avoids this by merging appended lines, but a Markdown table cannot. The conflict is visible, not silent: each writer commits and rebases, and a heartbeat job that clashes fails. Moving prices to a file only the price update writes would remove the conflict; it is left out until a conflict actually happens.
- Bad: the price update writes `portfolio.md` in place, not atomically. A process stopped in the middle of that write can leave the file cut short, and every reader that refuses a broken file then refuses it until it is restored from git.
- Bad: `decision:record` writes two files. If it stops between the log and the portfolio, the exit exists but the lot does not shrink. When the sale used the lot up, the next read refuses the file (the lot is still there although an exit used it up) and the owner fixes `Lots` by hand. When the lot only shrank, the units left in `Lots` are not compared with the last exit's `lot_units_left` (a split correction would trip that comparison), so the owner has to notice. The portfolio rewrite itself is atomic (a temporary file in the same directory, renamed over `portfolio.md`), so a stop can only fall between the two files, not inside one.
- Bad: a hand correction of `Lots` is not traced in the log, only in git history.
- Bad: a lot written by hand can carry a transcription mistake into R (a measured reproduction: an `Entry costs` of 40.00 instead of 4.00 was accepted and moved a trade's R from 1.96 to 1.60, which is why the costs are compared with the entry's). Every lot needs a real entry id, so open positions are recorded as entries, never typed straight into `Lots`.

### Confirmation

Engine tests with hand-calculated expectations, grouped as R1 to R5 in one suite, the measurable-exits suite, which runs in CI:

- R1: one entry and one exit give the same R as before this decision;
- R2: two partial exits of one entry count as one trade, weighted by units; a lot only partly sold is open, not a closed trade;
- R3: sales that span two lots are matched first in, first out, one R per lot;
- R4: archiving any quarter, including one that separates an entry from a later exit, leaves the evaluation unchanged when the archive is read; with the archive not set, the evaluation warns that decisions are missing instead of changing silently;
- R5: lots that do not match the log fail on read; a sale spanning two lots writes one exit per lot and keeps `Lots`, `Volume` and `Avg price` consistent.

**Success measure**: those tests pass in CI. Measured 2026-10-27: 36 tests in the measurable-exits suite (the whole suite, not only R1 to R5), 36 pass, 0 fail, 1 local run, plus the CI run of the same commit green; before the change four of R1 to R5 failed (measured 2026-10-19). A check on the owner's real log was dropped, because the owner starts from scratch on the new format.

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
- The previous-format rewrite is risky, and open positions have no entry id: addressed (re-record as entries, check against a broker statement).
