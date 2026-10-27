# Flows

How each main flow of the engine works today. With the code, this document is the source of truth
for how the system behaves; the _why_ lives in the linked ADRs (architecture) and closed specs
(design detail). Update it in the same PR that changes a flow. Domain terms link to the
[glossary](glossary.md) instead of being defined here.

Where a rule used to be numbered in a deprecated ADR (`ADR-0012 §3`), the number is kept in
parentheses so a code comment that cites it can be found here.

| Flow                                                          | Command                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| [Heartbeat](#heartbeat)                                       | `heartbeat:eu`, `heartbeat:us`                                  |
| [Resolve a pending escalation](#resolve-a-pending-escalation) | `pending:list`, `pending:show`, `pending:resolve`               |
| [Record a decision](#record-a-decision)                       | called by the two flows above; `decision:record` for the owner  |
| [Monday briefing](#monday-briefing)                           | `monday-briefing:prepare`, `monday-briefing:finalize`           |
| [Weekly screening](#weekly-screening)                         | `screening:prepare`, `screening:resolve`, `screening:summarize` |
| [Evaluate decisions](#evaluate-decisions)                     | `decisions:evaluate`, `decisions:chart`, `screening:outcomes`   |
| [Email delivery](#email-delivery)                             | `outbox:send` and every flow that sends                         |

## Heartbeat

- **Starts with**: a schedule in the data repository, one run per [silo](glossary.md#silo) after
  its market closes (`npm run heartbeat:eu` and `heartbeat:us`, `--currency EUR|USD`).
- **Steps**:
  1. Check the mail configuration before doing anything: with email on and no SMTP settings the run
     fails at once (an alert that does not go out is worse than a run that does not run).
  2. Read `portfolio.md` and `watchlist.md`. The [tickers](glossary.md#ticker) watched are the union of open positions and
     watchlist candidates, so a position is watched for risk even without a watchlist entry.
     With nothing to watch the run ends. A `Lots` table that does not read (a misspelled column in
     its header) and a `Lots` section that is missing (a misspelled heading, or a deleted empty
     section) do not stop the run: the lots count as empty for that run and the warning names
     `portfolio.md` and the expected section. Only the `Lots` reading is tolerant: a missing `Cash`
     or `Positions` section, or a table of them that does not read, still stops the run.
     The same tolerance applies to `pending:resolve`, the Monday briefing and the weekly screening,
     which do not use the lots; only `decision:record` and `decisions:evaluate` refuse a broken `Lots`.
     A ticker that does not parse (`M&M.NS`, a typo) is handled the same way: the `Positions` row or
     watchlist entry is skipped, the other positions are still priced and their stops detected, and the
     digest carries a warning naming the row in every run while it lasts. `pending:resolve`, the Monday
     briefing and the weekly screening skip such a row, entry or screening-log row with a warning and
     carry on, each also logging the warning through `warnSkipped`; only `decision:record` and `decisions:evaluate` refuse.
     A `Positions` `P/L`, `Available cash` or `Total cash` cell holding a number too large to count in cents
     (`1e307`) is tolerated too: it reads as 0, 0 and absent, the row is still watched, a console warning names the
     cell and the digest carries it in its own section in every run while it lasts. `pending:resolve`, the Monday
     briefing and the screening log the same warning.
  3. Fetch prices ([market data](#market-data-freshness)) and write them into `portfolio.md`
     (current price and P/L). This happens before the market-session guard on purpose. The write
     goes through the file's one codec, which keeps every line it does not change (notes and
     spacing included), as `decision:record`'s does; every `Positions` row of a ticker is updated.
  4. Detect crossed stops: a position priced below its recorded stop goes straight into the digest,
     with no LLM and no cooldown.
     4a. Check the [lots](glossary.md#lot), from `portfolio.md` alone (it does not read the decision
     log), after the stops are detected: a `Lots` row the reader skipped (named with the reason), a
     `Lots` table that does not read or is missing, a ticker on several `Positions` rows, and each
     `Volume` that is not the sum of its lots' units are warnings. The run does not refuse the file: it keeps watching and puts the
     warning in the digest (see [Lots](input-format.md#portfoliomd)). The warning is loud: unlike
     tight stops it is not deduplicated, so it is in every digest while it lasts, and a lots warning
     alone still produces a digest. The check has no catch of its own: if it throws, the crossed
     stops are already in the digest, which is sent before the run fails visibly, so a defect in
     the lots check cannot switch off the stop alerts.
  5. Market-session guard: if the last tick is older than the allowed age, the market was closed
     (holiday) and the run ends here.
  6. Stop hygiene: a position whose stop is closer than `STOP_MIN_ATR` goes into the digest
     ([stops in ATR](#stops-in-atr)).
  7. Fetch the silo [benchmark](glossary.md#benchmark) and its [regime](glossary.md#market-regime).
  8. Scan the watchlist for [entry setups](#entry-setups): blocked ones and armed breakouts are
     recorded in the decision log (a retry the same day does not duplicate them); buyable ones
     continue as signals.
  9. Evaluate [risk triggers](glossary.md#risk-trigger) on every watched ticker (price within
     `STOP_PROXIMITY_PCT`, default 3 %, of the stop, or a move of `BIG_MOVE_PCT`, default 5 %, from
     the previous close) and merge them with the setup signals, one signal per ticker.
     No signals ends the run at no cost.
  10. Attach technical strength to each signal, then for each one skip it if the last log has the
      same triggers and the price moved less than `REANALYSIS_PRICE_DELTA_PCT` (default 3 %).
  11. [Escalate](glossary.md#escalation) the rest to the [reasoner](glossary.md#reasoner-api-and-handoff).
      With `ANALYST_PROVIDER=api` the answer comes back at once and is passed to
      [Record a decision](#record-a-decision). With `handoff` the engine writes
      `logs/pending/<date>-<ticker>.md` and the signal is listed in the digest as escalated.
  12. Send the digest (crossed stops, a problem with the lots, a ticker or a money cell that cannot be read, tight stops, armed setups, escalations) with only what is new
      since the last send today (crossed stops and the lots, ticker and unreadable-cell warnings are always included), and mark it as sent only if the email went out.
- **Reads / writes**: reads `portfolio.md`, `watchlist.md`, `logs/decisions.jsonl`, the rules
  `version` in `strategies/base.md` and the last log of each ticker. Writes `portfolio.md` (prices),
  `logs/decisions.jsonl`, `logs/<date>-<ticker>.md`, `logs/pending/`, `logs/heartbeat-sent-<ccy>.json`
  and email ([delivery](#email-delivery)). Market data comes from Yahoo Finance.
- **When it fails**: what was gathered before the failure still goes out in the digest, and the
  original error turns the run red; if that email also fails, it is only logged. A provider failure
  on one ticker's extras (strength, ATR, benchmark) does not stop the run; they are best-effort.
- **Why**: [ADR-0002](decisions/0002-escalate-to-claude-only-after-deterministic-filters.md) (filters
  first), [ADR-0007](decisions/0007-portfolio-is-the-source-of-truth-for-risk-watch.md) (what is
  watched), [ADR-0004](decisions/0004-handoff-mode-for-the-reasoner.md) (two reasoner backends).
  For the lots check and the portfolio write: [spec #27](https://github.com/alvaromongon/finance-agent/issues/27).

### Market data freshness

(Was ADR-0008.)

- Quotes are fetched in batches of up to 20 symbols from Yahoo Finance `spark`, falling back to
  `chart` per ticker. Both endpoints are unofficial: the automatic fallback is what makes depending
  on them acceptable. Revisit if they break, or when the provider is made pluggable for a paid one.
- The "market closed" guard looks at the age of the last tick (18 h by default,
  `MARKET_SESSION_MAX_AGE_HOURS`), not at calendar dates. A late schedule (up to 13 h in the worst
  observed case) is told apart from a holiday (at least 25 h) or a weekend (at least 49 h).
- Portfolio prices are refreshed before that guard, so a closed market still leaves fresh closes.
- A price below a recorded stop sends a direct email, with no LLM and no cooldown. It repeats on
  every run until the portfolio is synced, deliberately: it means the account has not been checked.
  The engine cannot know whether the broker executed the stop; only a manual sync answers that.

### Entry setups

(Was ADR-0013.) Buys come only from setups the heartbeat detects every day on each watchlist
candidate, from one year of daily bars. A [setup](glossary.md#setup) is one of two patterns:

- **Pullback (§1)**: the close is above its SMA200; in the last 5 sessions the low touched the SMA20
  or SMA50; today it closes back above that average with a higher low; the 20-session high is still
  above the close.
- **Breakout base (§1)**: 15 sessions with a range of at most 3 ATR (the ATR from before the base)
  and a ceiling within 5 % of the 52-week high. _Armed_: the base ends today, unbroken, and the
  alert gives its ceiling as a Buy Stop level. _Confirmed_: today's close beats yesterday's ceiling
  with volume at least 1.5 times the 50-session average.

Only setups that are new compared with yesterday are alerted and recorded.

- **Target from the pattern (§2)**: pullback, the high it pulled back from plus the size of the
  pullback; breakout, the ceiling plus the pole (the rise from the low of the 40 sessions before
  the base). A swing-high target never reaches the minimum R:R, so pullbacks would always be blocked.
- **Eligibility (§3)**: a confirmed, eligible setup is escalated; if the reasoner holds, an eligible
  `hold` is recorded. A blocked one is recorded as `buy_blocked` without escalating. Armed
  breakouts are recorded as `setup_armed` and emailed with their Buy Stop.
- **Single way in (§4)**: the Monday briefing does not propose buys. A buy from the reasoner without
  a setup is blocked with `no_setup`; a user entry with no preceding setup is flagged
  `entry_without_setup`.
- **Record (§5)**: every new detection is recorded with its `setup` (pattern, state, level),
  whether or not it is acted on.

An armed Buy Stop that fills without a close above the ceiling is not seen as confirmed: the owner
records that trade by hand, citing the armed setup. Why: [ADR-0013](decisions/0013-entry-setups.md).

### Entry eligibility

(Was ADR-0010.) The engine blocks every entry setup that fails one of three rules. Blocked setups
are not escalated and are recorded with their reasons ([eligibility](glossary.md#eligibility)).

1. **Trend**: price < SMA50 < SMA200 (bearish bias).
2. **Momentum**: `(price − SMA50) / ATR14 < −1.5`.
3. **Regime**: the silo benchmark is below its SMA200 (`adverso`).

Thresholds are in ATR, not percent: a −5 % day is noise for a volatile security and a serious fall
for a quiet one. The regime uses the silo benchmark alone, with one year of daily closes: `favorable`
when it is above its SMA200 and its SMA50 is rising (higher than 20 sessions ago), `adverso` below
its SMA200, `neutral` otherwise. Only `adverso` blocks; `favorable` adds a point to
[conviction](glossary.md#conviction). Without enough history there is no regime and nothing blocks.
A pending item is judged with the regime of its detection date, frozen in its snapshot.

### Stops in ATR

(Was ADR-0011.) The stop distance is a multiple of ATR14, not a percentage: 3 ATR for the `medium`
horizon, 2.5 ATR for `short`, never less than 2 ATR. The engine sets the stop of every
[ticket](glossary.md#ticket). On `ADJUST_STOP` it raises the stop to that distance below today's
price and never lowers it. The heartbeat warns directly, with no LLM, when an open position's real
stop is closer than `STOP_MIN_ATR` (default 2). The warning has no cooldown and repeats until the
stop is fixed; positions already below their stop are excluded because the crossed-stop alert covers
them. It needs one history request per position with a stop; without ATR the position is skipped.

## Resolve a pending escalation

- **Starts with**: an agent session (a routine or a person) after a handoff heartbeat left files in
  `logs/pending/`: `pending:list`, `pending:show -- <file>`, then `pending:resolve -- <file>` with
  the answer as JSON on stdin.
- **Steps**:
  1. Validate the answer's shape.
  2. Rebuild the signal from the pending file and the current `watchlist.md` and `portfolio.md`.
     The detection snapshot keeps only strength, benchmark, setup, conviction and price; the entry,
     position, cash and silo value are read at resolve time, so a late resolution sizes on the
     current state. A ticker in neither file is stale and cannot be resolved.
  3. Hand over to [Record a decision](#record-a-decision), dated with the detection day.
  4. Delete the pending file, whether the ticket was blocked or not.
- **Reads / writes**: reads the pending file, `watchlist.md`, `portfolio.md`; writes what Record a
  decision writes and deletes the pending file.
- **When it fails**: a validation or recording error exits non-zero and leaves the file for a retry.
- **Why**: [ADR-0004](decisions/0004-handoff-mode-for-the-reasoner.md).

## Record a decision

- **Starts with**: a reasoner answer (the heartbeat with the `api` backend, or `pending:resolve`),
  or the owner narrating a trade (`npm run decision:record`, JSON on stdin).
- **Steps (reasoner answer)**:
  1. Check the answer is for the signal's ticker and currency.
  2. Compute the engine ticket: stop, units, amount and R:R from the rules below. The reasoner
     proposes; the engine does the arithmetic.
  3. On a BUY, warn if the two-month rule applies.
  4. Blocked ticket: write the Markdown log and the decision line with the reasons; send no email.
     Otherwise write the log, then the decision line, then the alert email (the decision exists even
     if delivery fails).
- **Steps (owner trade)**: validate the input and refuse the portfolio if its lots do not match the
  decision history (a `Lots` row the reader skipped, a ticker on several `Positions` rows, a `Volume` that is not the
  sum of its lots' units, a lot that disagrees with its entry, entry costs included, or an entry
  still open in the log with no lot), reporting together the messages of the lots comparison once the file has parsed (a `Lots` row or a `Positions` ticker that does not parse stops the read first, on its own), then fill what the owner need not know: id,
  rules version, benchmark, the rules broken against the current watchlist, and the system proposal it
  follows (within 10 days), which sets the origin. A buy after a blocked proposal is the owner's with
  `overrode_block`. The engine also keeps the [lots](glossary.md#lot):
  - The [ticker](glossary.md#ticker) is parsed first: one that does not parse is refused before
    anything is written.
  - Units and amount are one fact: given both, they must agree to within a cent
    (`|amount − units × price| ≤ 0.01`), otherwise the trade is refused and nothing is written; given
    one, the other is derived.
  - An entry writes `units` (the units bought) on its log line and adds a lot to `Lots`, whose
    `Entry units` is that number; it creates the ticker's row in `Positions` (with the lot's
    initial stop as `Stop loss`; the other columns stay as they are) or updates its `Volume` and
    `Avg price`. It needs `portfolio.md`:
    without it the lot would be lost, so the entry is refused.
  - A sale consumes the ticker's lots first in, first out (oldest entry date first) and writes one
    `exit` per lot consumed. Each exit cites its own lot, carries `units` (the units it sold from the
    lot; those of a sale's exits add up to the units sold), the snapshot the evaluation needs
    (entry price, units, date, origin, rules version, initial stop, rules broken, its share of the
    entry costs) and `lot_units_left`, the lot's units after the exit (0 when it uses the lot up). A
    sale narrated by amount alone has units known only to half a cent of price, so a lot it leaves
    with less than that is used up; units the owner gave are exact and nothing is snapped.
    The costs of the sale are shared across the exits in whole cents (largest remainder: no share
    is negative, they add up to the total). An exit's `amount` is its exact share of the sale amount
    and can have sub-cent decimals (owner decision of 2026-10-22 in #27); when only units are given,
    the sale amount derived is to the cent unless that rounds to 0.00, then exact. Its
    `pnl` comes from the lot's entry price, costs not included. When the owner gives the `pnl` of
    the whole sale, each exit still keeps its own lot's result and only the difference between the
    owner's total and the computed sum (costs, FX) is shared by units, in whole cents (largest
    remainder), so the exits add up to the owner's total and a losing lot stays a loss (lots bought
    at 100 and 130, sold together at 120 with +50 given: the exits get +100 and −50, and the
    two-month warning cites the −50). The lots a sale uses up are removed
    from `Lots`, the others shrink, `Volume` and `Avg price` are recomputed and, with the last lot,
    the position's row is deleted. The owner no longer edits `Volume` before recording a sale.
  - A sale of a ticker with no lots, of more units than are open, with no `portfolio.md`, or dated
    before the entry of a lot it would consume (a lot cannot be sold before it was bought; the same
    day is allowed), a lot whose Entry price or entry costs (or the sums made from them) are too
    large to count in cents, or a partial sale of a lot with entry costs and Entry units 0, is an
    error. All of them are refused before any call to the market data
    provider ("no open lots" and "more units than open" included), and nothing is recorded; the last
    one names both dates.
- **Reads / writes**: reads `logs/decisions.jsonl` (and the archive, if `DECISIONS_ARCHIVE_DIR` gives
  one: an owner trade is recorded correctly from the live file alone, because the quarter archive
  keeps every line of an open lot live, see [Log retention](log-retention.md)), `portfolio.md`, `watchlist.md`,
  the rules version; writes `logs/<date>-<ticker>.md`, `logs/decisions.jsonl`, the `Lots` and
  `Positions` tables of `portfolio.md` and email. The decision log is appended first and
  `portfolio.md` rewritten second, atomically (a temporary file in the same directory renamed over
  it), so a stop never leaves `portfolio.md` cut short. Both writers of the file (this one and
  the heartbeat's price update) share one codec: it keeps the lines of the file, notes and spacing
  included, so reading and writing back unchanged is identical; when this writer rewrites the
  `Positions` table it drops the placeholder (`—`) rows. Only this writer re-reads the file and
  writes atomically; the heartbeat's price update has no re-read and no lots check and writes the file
  in place, so a heartbeat that read the file before a record and writes after it overwrites the new
  `Lots` and `Positions` rows (see _Bad_ in the ADR). The portfolio is read again after the
  market-data calls, right before the decision is appended, and if the lots moved meanwhile the
  record is refused with nothing written. It is read once more after the append, and if the lots
  moved in that short window the decision is already in the log: the error says so, and the trade
  must not be recorded again (apply the lot change by hand).
- **When it fails**: nothing is written before the checks pass; a missing rules version stops the
  record, because a Markdown log without its decision line would mean measuring halfway. If the
  process stops between the log and the portfolio, an exit exists whose lot did not shrink; the
  owner corrects `Lots` by hand. A partial sale that reached the log but not the portfolio is not
  caught on read (a split correction looks the same); the owner finds it when reconciling `Volume`
  with the broker, and a failure of the check or the edit after the log append says the decision is recorded
  and the lot change has to be applied by hand. A failure of the final atomic rewrite (no permission,
  disk full) does not say so today: it surfaces as a raw error although the decision is already in the
  log, and the owner then applies the lot change by hand and does not record the trade again
  ([#91](https://github.com/alvaromongon/finance-agent/issues/91) will make every such failure say so).
- **Why**: [ADR-0006](decisions/0006-single-append-only-decision-log.md),
  [ADR-0009](decisions/0009-swing-framework-risk-sizing-and-measurement.md),
  [ADR-0015](decisions/0015-open-lots-live-in-the-portfolio.md) (lots), and for the lot design
  [spec #27](https://github.com/alvaromongon/finance-agent/issues/27). The contract of the `Lots` table is in
  [input-format.md](input-format.md#portfoliomd).

Sizing parameters in force (the framework itself stays in ADR-0009): each trade risks 1 % of the silo
value, a position is capped at 25 %, and a buy needs a reward:risk of at least 2:1 net of costs.

## Monday briefing

- **Starts with**: a weekly schedule. Handoff: `monday-briefing:prepare`, the reasoner reasons on the
  printed prompt, then `monday-briefing:finalize` with the report on stdin. With
  `ANALYST_PROVIDER=api`, `monday-briefing` (no subcommand) does both; in `handoff` it refuses, so
  the API is not spent by accident.
- **Steps**:
  1. `prepare` reads both portfolios and watchlists, the portfolio policy, the latest evaluation
     table and the logs of the last 30 days, and refreshes prices in `portfolio.md` first so the
     prompt describes one state.
  2. It computes technicals and current setups per asset, the weight breakdown and the USD buffer,
     and prints the prompt (progress goes to stderr).
  3. `finalize` checks the report is complete, builds the engine tickets and one decision per open
     position, writes `logs/<date>-monday-briefing.md`, applies the watchlist removals the report
     asks for (never a ticker with an open position), and emails the summary.
- **Reads / writes**: reads `portfolio.md`, `watchlist.md`, `portfolio-policy.md`,
  `logs/decisions-evaluation.md`, thesis notes and recent logs; writes `portfolio.md` (prices),
  `watchlist.md`, `tesis/`, `logs/decisions.jsonl`, the briefing log and email.
- **When it fails**: an incomplete or truncated report is rejected and nothing is written or sent.
  It re-reads the portfolio instead of using `prepare`'s snapshot, since it runs in another process.
- **Why**: [ADR-0004](decisions/0004-handoff-mode-for-the-reasoner.md).

## Weekly screening

- **Starts with**: a weekly schedule. Handoff: `screening:prepare`, then one `screening:resolve --
<file>` per candidate, then `screening:summarize`. `weekly-screening` with `ANALYST_PROVIDER=api`
  runs the whole thing.
- **Steps**:
  1. `prepare` ranks the universe in `screening-universe.md` ([the funnel](#the-screening-funnel)),
     retires watchlist entries by mechanical rules, selects the candidates, and writes one context
     file per candidate in `logs/pending-screening/` plus `run.json`. Securities already on the
     watchlist or rejected with a review date still in the future are excluded.
  2. `resolve` validates the evaluation, records it in `screening-log.md` (next review in two months
     if not interesting) and, if interesting, writes the thesis note and adds the candidate to the
     watchlist; it records `screen_interesting` or `screen_rejected` with `rank`, `score` and
     `exploration`, appends the result to `results.jsonl` and deletes the candidate file.
  3. `summarize` sends one aggregated email from `results.jsonl` and deletes it. Unresolved
     candidates are listed and kept. If the email did not go out, `results.jsonl` is kept for the
     relay.
- **Reads / writes**: reads `screening-universe.md`, `watchlist.md`, both portfolios, the screening
  log; writes `screening-log.md`, `tesis/`, `watchlist.md`, `logs/decisions.jsonl`,
  `logs/pending-screening/` and email.
- **When it fails**: if the ranking cannot be trusted the run falls back to a random draw among
  filter-0 eligibles and the email says **NO RANKING** with the reason. A candidate that fails to
  prepare is skipped with a warning.
- **Why**: [ADR-0012 (deprecated, detail below)](decisions/0012-screening-funnel.md),
  [ADR-0002](decisions/0002-escalate-to-claude-only-after-deterministic-filters.md).

### The screening funnel

(Was ADR-0012.) The screening does not draw candidates at random.

1. **Filter 0 (§1)**: a security is eligible with data from this week, at least 240 sessions in the
   last year, a last close above its SMA200 and a median 50-session traded value of at least
   500,000 in its currency. No exception for "turnaround catalysts".
2. **Score (§2)**: per silo, the mean percentile of two factors: proximity to the 52-week high and
   6-month relative strength against the silo benchmark. Two factors, to overfit less.
3. **Selection (§3)**: the best 4 in EUR and 6 in USD, excluding the watchlist and recent
   rejections, plus 1 random [exploration candidate](glossary.md#exploration-candidate) per silo
   among the remaining eligibles, marked `exploration: true`.
4. **Record (§4)**: `screen_interesting` and `screen_rejected` carry `rank`, `score`, `exploration`.
5. **Fallback (§5)**: the ranking is skipped if a benchmark lacks recent history, if less than 80 %
   of the universe has data, or if the median last session is more than 5 days old.
6. **The question (§6)**: "is there a thesis that justifies trading this security when a setup
   appears?". The reasoner judges what the engine cannot see: an identifiable driver, no unpriced
   fundamental risk, no thematic duplicate.
7. **Conviction rubric (§7)**: one point each for top quintile of the ranking, a `favorable` regime,
   an active setup with net R:R at least 3, and a dated catalyst (the only qualitative point).
   High is 3 or more points, medium 2, low 0–1. The heartbeat applies the same rubric to setups.
8. **Mechanical watchlist exit (§8)**: a candidate is retired if it left the universe
   (`out_of_universe`), fails filter 0 (`filter_zero`), falls out of the top half of its silo
   (`out_of_top`) or spent 4 weeks without any setup (`no_setup`). A security with an open position
   is never retired and a data failure retires nothing. The Monday briefing can only bring an exit
   forward, by citing the thesis's own invalidation criterion.

Candidates excluded by filter 0 are not recorded; only the run's progress output shows why.

## Evaluate decisions

- **Starts with**: step 1 of the Monday briefing, or by hand: `decisions:evaluate`,
  `decisions:chart`, `screening:outcomes`. No LLM.
- **Steps**:
  1. Read the whole decision history: the live `logs/decisions.jsonl` and any
     `decisions-YYYY-QN.jsonl` in `DECISIONS_ARCHIVE_DIR`, de-duplicated by id and in date order; a
     line that fails to validate is skipped with a warning. Without the variable only the live file
     is read, and the engine says so on stderr, as it does for a directory that does not exist, is
     not a directory or is not absolute (a note once per run when it is unset; no exit code or output
     changes; see [Log retention](log-retention.md#reading-the-archive-back)). Check the portfolio's lots against it,
     and stop if they do not match.
  2. Compute the net R of each closed trade from its exits alone (each exit carries a snapshot of
     its [lot](glossary.md#lot)). A trade is one [lot](glossary.md#lot) and its [R](glossary.md#r)
     is measured on its exits. Exits of one lot
     whose entry units, entry price and initial stop differ by one common ratio (a split corrected
     in `Lots` between two sales) still count as one lot, and R does not change. A lot is closed when its last exit has `lot_units_left` = 0. An
     exit without the snapshot or without `lot_units_left`, an oversold lot, and a lot whose exits do
     not add up (units left that do not follow the sales, or snapshots that disagree) are not
     measured but are reported (the exits and lots by name) in the cutoff board and on the console.
     The open trades of the board come from the `Lots` of `portfolio.md` (one per [lot](glossary.md#lot),
     a lot sold in part included), never from the decision log; an entry with no lot is not an open
     trade (entries recorded before the lots carry no `units` and have none until the owner re-records
     the open positions). The counter starts at the earliest entry date among the entry lines still
     read, the exits' snapshots and the lots, only those of a system entry (origin `sistema`) under
     C v1, so archiving a quarter does not move it. If that date is before the earliest decision
     loaded, part of the log was not read: the board warns "decisions are missing before
     \<date\>: is `DECISIONS_ARCHIVE_DIR` set?" (and prints it on the console) and goes on; the
     market data is downloaded back to the counter start. Then
     simulate each proposal's plan and compare it with the silo [benchmark](glossary.md#benchmark)
     and the [shadow portfolio](glossary.md#shadow-portfolio).
  3. `decisions:evaluate` writes `logs/decisions-evaluation.md` (the cutoff board, expectancy,
     real versus shadow value); `decisions:chart` writes `logs/decisions-evaluation.svg` (SLI 1);
     `screening:outcomes` writes `logs/screening-outcomes.md` (what happened 20 and 60 sessions
     after each screening evaluation).
- **Reads / writes**: reads the decision history, market data and `screening-log.md`; writes only
  the files above. It never touches the decision log, `portfolio.md` or the watchlist.
- **When it fails**: it exits non-zero and writes nothing, also when the portfolio's lots do not
  match the decision history; "insufficient data" is a status, not a failure.
- **Archive**: archiving a quarter never changes the result, because an exit carries everything
  its R needs and a lot's entry and exits stay live while it is open (see [Log
  retention](log-retention.md)); a lot whose entry is in no loaded file is a lots mismatch that
  names `DECISIONS_ARCHIVE_DIR`.
- **Why**: [ADR-0014](decisions/0014-decision-quality-slo.md),
  [ADR-0009](decisions/0009-swing-framework-risk-sizing-and-measurement.md) §4, and for the
  per-lot exits [spec #27](https://github.com/alvaromongon/finance-agent/issues/27).

## Email delivery

- **Starts with**: any flow that sends an alert or summary (`sendAlert`, `sendSummaryEmail`), and the
  relay (`outbox:send`).
- **Steps**: the transport is `MAIL_TRANSPORT`.
  - `smtp`: send directly. The default.
  - `outbox`: write the message as a JSON file in `logs/outbox/`. The email relay workflow later
    runs `outbox:send` in `smtp` mode, sends each file and deletes it only after it was delivered.
    A malformed file or a failed send is kept and does not stop the rest.
  - `none`: email is switched off; nothing is sent and the call counts as handled.
    ([#33](https://github.com/alvaromongon/finance-agent/issues/33) will write the message to
    `logs/` instead of dropping it.)
- **Reads / writes**: `logs/outbox/`; SMTP settings from the environment.
- **When it fails**: with `MAIL_REQUIRE_DELIVERY=true` and no SMTP configured, every entry point
  that can send fails at startup, before any work. A send that fails afterwards turns the run red.
- **Why**: [ADR-0005](decisions/0005-email-outbox-and-relay.md).
