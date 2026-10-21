---
status: Proposed
date: 2026-10-19
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

- `portfolio.md` gets a required `Lots` table per currency, in a new, incompatible version of its format. Each row carries what an exit's snapshot needs: ticker, entry id, date, units left, entry units, entry price, initial stop, entry costs, origin, rules version and rules violations. The ticker is in the row so that `Volume` can be checked against the lots from `portfolio.md` alone.
- `decision:record` is the only writer: an entry adds a lot; a sale consumes lots FIFO, writes one exit per lot consumed and recomputes `Volume` and `Avg price` in `Positions`. It appends to the log first and rewrites the portfolio second, and both changes go in one commit. A lot that a sale uses up is removed from `Lots`; its history lives in its exit lines.
- Each exit carries the snapshot of its lot, in optional fields of the decision log: `related_id` (the entry id of the lot, never the latest open entry), `entry_price`, `entry_units`, `entry_costs` (the exit's share of the lot's entry costs, pro rata to the units sold, the remainder on the last exit of the lot, so the shares add up exactly to the lot's costs), `entry_date`, `entry_origin`, `entry_rules_version`, `stop_initial`, `rule_violations`, and `lot_units_left`.
- A lot is closed when its last exit has `lot_units_left` = 0, the units the lot has left after that exit. The writer knows exactly when a lot is used up, so the evaluation does not infer it. Inferring it by summing the units of the exits against a rounding slack was rejected: on a low-priced asset the slack can exceed a real unsold remainder (100 units at 0.02 with 99 sold at 0.01 read as closed), exits of one lot that disagree go unnoticed, and the sum depends on float arithmetic. The evaluation also checks that, across a lot's exits in date order, `lot_units_left` falls by the units each exit sold (within cent rounding) and never below 0, and that the exits agree on the rest of the snapshot; a lot that fails is not measured and the report names it.
- A trade is one lot (one entry): its R is Σ(unitsᵢ / entry_units) × Rᵢ over the exits that consumed it. Scale-ins are separate trades.
- The owner reconciles `Volume` against the broker. A mismatch (split, partial fill, recording mistake) is fixed by editing `Lots` by hand in a correction commit. `decision:record` and the evaluation, which read the whole decision log, refuse the file when:
  - `Volume` differs from the sum of its lots' units;
  - a lot has more units than its entry bought, or two rows share an entry id;
  - a lot's entry id is not in the log, its ticker is not its entry's, or its snapshot of the entry (price, units, initial stop, date, origin, rules version, rules violations) differs from the entry's;
  - an entry in the log is still open and has no lot, where an entry is open until an exit citing it has `lot_units_left` = 0 (an entry cited by an exit with no `lot_units_left` was closed before this contract and is not checked);
  - a lot is still in `Lots` although an exit used it up.

  The heartbeat does not read the log: it checks `Volume` against the lots from `portfolio.md` alone, keeps watching the positions for risk and raises a loud warning, because a typo must never switch off stop alerts. A split is corrected by scaling units, entry price and stop by the same ratio; the check cannot catch a wrong ratio.

**What we give up**:

- The owner no longer edits position rows, only corrects lots.
- About five static entry fields are duplicated in every exit. This is safe because the log is append-only.
- No backward compatibility: portfolio files in the previous format and log lines without a snapshot are discarded and rewritten by hand, with no migration script. Accepted because the owner is the only user.

**Scope**: `decision:record`, the `portfolio.md` format with its reader and writer, the evaluation and its chart, and the owner's routine for keeping the portfolio in sync.

**Confidence**: medium. Revisit if:

- a second user arrives with data in the previous format, which would need a real migration;
- another consumer of entries cannot work from the snapshot;
- the evaluation takes more than 1 s, or the live log exceeds 10,000 lines (then consider views of the log).

### Consequences

- Good: realized R of a partial or scaled trade is computed from exit lines alone.
- Good: archiving a quarter can never strand data a measurement needs.
- Good: the owner no longer has to record a sale before touching its row, because the engine updates the row.
- Bad: two writers now touch `portfolio.md`. The heartbeat rewrites prices and `decision:record` rewrites lots and positions, so a heartbeat run in flight while the owner records a trade can conflict on rebase. The decision log avoids this by merging appended lines, but a Markdown table cannot. The conflict is visible, not silent: each writer commits and rebases. Moving prices to a file only the heartbeat writes would remove the conflict; it is left out until a conflict actually happens.
- Bad: `decision:record` writes two files. If it stops between the log and the portfolio, the exit exists but the lot does not shrink. When the sale used the lot up, the next read refuses the file (the lot is still there although an exit used it up) and the owner fixes `Lots` by hand. When the lot only shrank, the units left in `Lots` are not compared with the last exit's `lot_units_left` (a split correction would trip that comparison), so the owner has to notice.
- Bad: a hand correction of `Lots` is not traced in the log, only in git history.
- Bad: rewriting the previous format by hand can carry a transcription mistake into R. Open positions are re-recorded as entries with their original date, so each lot has a real entry id, and the result is checked once against a broker statement.

### Confirmation

Engine tests with hand-calculated expectations:

- one entry and one exit;
- two partial exits of one entry;
- FIFO across two lots;
- archiving any quarter leaves the evaluation unchanged;
- a sale spanning two lots keeps `Lots` and `Positions` consistent, and a mismatch fails on read;
- a lot sold in two partial sales and then a sale across two lots gives each exit its own lot's entry id, and the entry costs of one lot add up across its exits.

**Success measure**: those tests pass in CI, and on the owner's real log single-lot trades keep their R (a human check once the change is complete).

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
