# Flows

How each main flow of the engine works today. With the code, this document is the source of truth
for how the system behaves; the _why_ lives in the linked ADRs (architecture) and closed specs
(design detail). Update it in the same PR that changes a flow. Domain terms link to the
[glossary](glossary.md) instead of being defined here.

Where a rule used to be numbered in a deprecated ADR (`ADR-0012 §3`), the number is kept in
parentheses so a code comment that cites it can be found here.

| Flow                                                          | Command                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Heartbeat](#heartbeat)                                       | `heartbeat:eu`, `heartbeat:us`                                                              |
| [Resolve a pending escalation](#resolve-a-pending-escalation) | `pending:list`, `pending:show`, `pending:resolve`                                           |
| [Record a decision](#record-a-decision)                       | called by the two flows above; `decision:record` for the owner's flows and stop adjustments |
| [Monday briefing](#monday-briefing)                           | `monday-briefing:prepare`, `monday-briefing:finalize`                                       |
| [Weekly screening](#weekly-screening)                         | `screening:prepare`, `screening:resolve`, `screening:summarize`                             |
| [Check the inbox](#check-the-inbox)                           | `inbox:check`                                                                               |
| [Apply the inbox](#apply-the-inbox)                           | `inbox:ingest`                                                                              |
| [Evaluate decisions](#evaluate-decisions)                     | `decisions:evaluate`, `decisions:chart`, `screening:outcomes`                               |
| [Email delivery](#email-delivery)                             | `outbox:send` and every flow that sends                                                     |

## Heartbeat

- **Starts with**: a schedule in the data repository, one run per [silo](glossary.md#silo) after
  its market closes (`npm run heartbeat:eu` and `heartbeat:us`, `--currency EUR|USD`).
- **Steps**:
  1. Check the mail configuration before doing anything: with email on and no SMTP settings the run
     fails at once (an alert that does not go out is worse than a run that does not run).
  2. Read the portfolio (the [store](glossary.md#store) once `state/portfolio.json` exists, where it reads whole and the
     tolerances below do not arise; until then `portfolio.md`) and `watchlist.md`. The [tickers](glossary.md#ticker) watched are the union of open positions and
     watchlist candidates, so a position is watched for risk even without a watchlist entry.
     With nothing to watch the run ends. A `Lots` table that does not read (a misspelled column in
     its header) and a `Lots` section that is missing (a misspelled heading, or a deleted empty
     section) do not stop the run: the lots count as empty for that run and the warning names
     `portfolio.md` and the expected section. Only the `Lots` reading is tolerant: a missing `Cash`
     or `Positions` section, or a table of them that does not read, still stops the run.
     The same tolerance applies to `pending:resolve`, the Monday briefing and the weekly screening,
     which do not use the lots; only `decisions:evaluate` refuses a broken `Lots` (and `inbox:check` and `inbox:ingest`
     refuse a portfolio whose `Volume` is not the sum of its lots).
     A ticker that does not parse (`M&M.NS`, a typo) is handled the same way: the `Positions` row or
     watchlist entry is skipped, the other positions are still priced and their stops detected, and the
     digest carries a warning naming the row in every run while it lasts. `pending:resolve`, the Monday
     briefing and the weekly screening skip such a row, entry or screening-log row with a warning and
     carry on, each also logging the warning through `warnSkipped`; only `decisions:evaluate` and the inbox refuse.
     A `Positions` `P/L`, `Available cash` or `Total cash` cell holding a number too large to count in cents
     (`1e307`) is tolerated too: it reads as 0, 0 and absent, the row is still watched, a console warning names the
     cell and the digest carries it in its own section in every run while it lasts. `pending:resolve`, the Monday
     briefing and the screening log the same warning.
     2'. Name every [rejected batch](glossary.md#rejected-batch) still awaiting an answer (a file of `inbox/rejected/` that
     no applied batch replaced or discarded, #152) in the digest, in every run while it lasts (not deduplicated), right
     after the portfolio is read (before anything can end the run), also when there is nothing else to watch. Only the list of the
     rejected files is read, never a batch run, and a folder that cannot be read is said in the log and stops nothing: a
     rejected batch never switches off a stop alert.
     2''. Judge how stale the silo is and what its latest [snapshot](glossary.md#snapshot) found (#138), once the state is
     the [store](glossary.md#store): a silo is [stale](glossary.md#stale) by its latest snapshot alone. A console warning names it, and the digest has a section for it. The differences of the latest snapshot are in the
     digest in every run (not deduplicated) until a later snapshot shows none; a snapshot with no difference says so, once,
     the day it is recorded (`recorded_on` of the silo's snapshot in the store). While the state is still `portfolio.md` there is no snapshot and its `last_manual_sync`
     keeps its own warning until #143 removes that way.
  3. Fetch prices ([market data](#market-data-freshness)) and write them into the portfolio
     (current price and P/L; with the [store](glossary.md#store), into it, regenerating `portfolio.md`; the rest of
     this step describes the old file, which is the state until the first `inbox:ingest`). This happens before the market-session guard on purpose. The write
     goes through the file's one codec and edits the priced cells in place, then replaces the file
     atomically (a temporary file renamed over it), so every other line stays where it was (notes and spacing included); every `Positions` row of a ticker that has a
     price and a readable `Volume` and `Avg price` is updated, its ticker written in upper case.
     The price refresh is the heartbeat's only write of the state, and it takes no lock and runs no compare-and-swap: the
     run reads the last commit it was started from and the write reaches the data repository through `commit-changes`
     with `state-paths`. If another run committed the [store](glossary.md#store) or its view since, the refresh is dropped
     with a warning and the rest of the run's changes (logs) is committed; the next run refreshes the prices again. The
     run's lines of `logs/decisions.jsonl` are merged with the ones another run appended meanwhile only if the data
     repository's `.gitattributes` gives that file `merge=union` (README, _State writes never overlap_); without it the
     patch conflicts, `commit-changes` fails with an error and that run's logs are not committed. A push that loses a
     race is retried from the new head and puts back only the files the run's patch touched. Stop
     detection (step 4) never waits for any of this, and a run that keeps losing the
     [compare-and-swap](glossary.md#compare-and-swap) of an ingest delays the state and never a stop check (ADR-0015).
  4. Detect crossed stops: a position priced below its recorded stop goes straight into the digest,
     with no LLM and no cooldown.
     4'. Name every open position with no stop (`stopOf`: a stop that is not above zero is none) in the digest, with its
     silo, in every run while it lasts (not deduplicated), before the session guard.
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
  12. Send the digest (crossed stops, positions without a stop, a problem with the lots, a ticker or a money cell that cannot be read, a stale silo, the differences of the latest snapshot, tight stops, armed setups, escalations) with only what is new
      since the last send today (crossed stops, the differences of a snapshot and the lots, ticker and unreadable-cell warnings are always included), and mark it as sent only if the email went out.
- **Reads / writes**: reads the portfolio (the store, else `portfolio.md`), `watchlist.md`, `logs/decisions.jsonl`, the rules
  `version` in `strategies/base.md` and the last log of each ticker. Writes the portfolio (prices: into the store,
  regenerating the view `portfolio.md`; else `portfolio.md`),
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
  a setup is blocked with `no_setup`. The owner's `buy` in `inbox/` is judged when
  [`inbox:ingest`](#apply-the-inbox) applies it: flagged `not_in_watchlist`, `entry_without_setup` (no system proposal
  with a setup within 10 days), `no_stop` and `stop_below_min_atr`, and, if it follows a proposal of the system, logged
  as the system's and citing it (a buy of a block is the owner's and flagged `overrode_block`).
- **Record (§5)**: every new detection is recorded with its `setup` (pattern, state, level),
  whether or not it is acted on.

An armed Buy Stop that fills without a close above the ceiling is not seen as confirmed: the owner
tells the engine that trade with a `buy` command in `inbox/`, which cites the armed setup. Why: [ADR-0013](decisions/0013-entry-setups.md).

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
  2. Rebuild the signal from the pending file and the current `watchlist.md` and the portfolio (the store, else `portfolio.md`).
     The detection snapshot keeps only strength, benchmark, setup, conviction and price; the entry,
     position, cash and silo value are read at resolve time, so a late resolution sizes on the
     current state. A ticker in neither file is stale and cannot be resolved.
  3. Hand over to [Record a decision](#record-a-decision), dated with the detection day.
  4. Delete the pending file, whether the ticket was blocked or not.
- **Reads / writes**: reads the pending file, `watchlist.md`, the portfolio; writes what Record a
  decision writes and deletes the pending file.
- **When it fails**: a validation or recording error exits non-zero and leaves the file for a retry.
- **Why**: [ADR-0004](decisions/0004-handoff-mode-for-the-reasoner.md).

## Record a decision

- **Starts with**: a reasoner answer (the heartbeat with the `api` backend, or `pending:resolve`),
  or the owner narrating a cash flow or a stop adjustment (`npm run decision:record`, JSON on stdin).
- **Steps (reasoner answer)**:
  1. Check the answer is for the signal's ticker and currency.
  2. Compute the engine ticket: stop, units, amount and R:R from the rules below. The reasoner
     proposes; the engine does the arithmetic.
  3. On a BUY, warn if the two-month rule applies.
  4. Blocked ticket: write the Markdown log and the decision line with the reasons; send no email.
     Otherwise write the log, then the decision line, then the alert email (the decision exists even
     if delivery fails).
- **Steps (owner narration)**: `decision:record` records what the owner narrates that is not a trade: a stop
  adjustment (`adjust_stop`), a deposit or a withdrawal. **A currency [conversion](glossary.md#conversion) is no longer recorded here (#135)**:
  `fx_conversion` is refused, with a message that names the `convert` command of the [inbox](#apply-the-inbox), the
  only way to convert cash between the silos. **A buy and a sale
  are not recorded here any more (#152)**: `entry` and `exit` are refused, with a message that names the `buy` and
  `sale` commands of the [inbox](#apply-the-inbox), which is the only way a trade is recorded, keeping the lots and
  writing the entry and exit lines of the log as telemetry. The engine validates the input (the
  [ticker](glossary.md#ticker) of an adjustment is parsed first: one that does not parse is refused before anything
  is written), then fills what the owner need not know: id, rules version, the silo benchmark and, for an adjustment,
  the system proposal it follows (within 10 days), which sets the origin.
  - With the [store](glossary.md#store) the cash moves too, as the inbox's `deposit` and `withdrawal` move it: a
    deposit and a withdrawal move it likewise, in one write. Any movement that would take the
    available cash of a silo below zero is refused, before anything is recorded (the movement is tried first, then the
    log is appended, then the same movement is written). `portfolio.md` is then a generated view and is never edited
    by hand. Without the store, the cash is the owner's cell, as before, and the flow only appends to the log.
- **Reads / writes**: reads `logs/decisions.jsonl` (and the archive, if `DECISIONS_ARCHIVE_DIR` gives one), the rules
  version and the store; writes `logs/<date>-<ticker>.md`, `logs/decisions.jsonl`, the cash of the store (and the view
  generated from it) and email. The decision log is appended first and the store written second, atomically (a
  temporary file in the same directory renamed over it). Every writer of the store (this one, `inbox:ingest` and the
  price update that the heartbeat and the Monday briefing run) goes through the portfolio
  [state port](glossary.md#state-port) (`src/portfolio-store.ts`).
  Only with `STATE_COMMIT=git` is the run (`src/decision-record.ts`) a [compare-and-swap](glossary.md#compare-and-swap)
  like `inbox:ingest`: the log line and the cash move are committed on top of the last commit, and done again over the
  new state if another run committed first. Losing every attempt records nothing and says so: say it again. No
  workflow of the engine or of `examples/workflows/` runs `decision:record` or sets `STATE_COMMIT=git` for it: the owner
  runs it by hand or from the portfolio-sync routine, which leaves its files in the working copy to commit.
- **When it fails**: nothing is written before the checks pass; a missing rules version stops the record, because a
  Markdown log without its decision line would mean measuring halfway. A failure of the store write after the log
  append (no permission, disk full) says the decision is recorded and the cash was not updated, and that the cash is
  corrected with a `deposit` or a `withdrawal` command in the inbox; the flow must not be recorded again. No message
  asks the owner to edit the portfolio by hand.
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
     table and the logs of the last 30 days, and refreshes prices in the portfolio (the store, else `portfolio.md`) first so the
     prompt describes one state.
  2. It computes technicals and current setups per asset, the weight breakdown and the USD buffer,
     and prints the prompt (progress goes to stderr).
  3. `finalize` checks the report is complete, builds the engine tickets and one decision per open
     position, writes `logs/<date>-monday-briefing.md`, applies the watchlist removals the report
     asks for (never a ticker with an open position), and emails the summary.
- **Reads / writes**: reads the portfolio (the store, else `portfolio.md`), `watchlist.md`, `portfolio-policy.md`,
  `logs/decisions-evaluation.md`, thesis notes and recent logs; writes the portfolio (prices),
  `watchlist.md`, `tesis/`, `logs/decisions.jsonl`, the briefing log and email.
- **When it fails**: an incomplete or truncated report is rejected and nothing is written or sent.
  It re-reads the portfolio instead of using `prepare`'s snapshot, since it runs in another process.
  In the GitHub workflow its price refresh reaches the data repository through `commit-changes` with `state-paths`,
  with no lock: if another run committed the [store](glossary.md#store) or its view since the briefing started, the
  refresh is dropped with a warning and the rest (logs, briefing files, watchlist, thesis notes) is committed; the
  next run refreshes the prices again. `commit-changes` commits only the paths the workflow gives it.
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
- **State**: it never writes the [store](glossary.md#store) or `portfolio.md`, so its workflow gives `commit-changes`
  no `state-paths` and commits only `logs/`, `tesis/`, `watchlist.md` and `screening-log.md`.
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

## Check the inbox

- **Starts with**: the owner, an AI or a routine having dropped [batches](glossary.md#batch) in
  `inbox/`, then `npm run inbox:check`. No LLM, no network.
- **Steps**:
  1. Read the `.yaml` and `.yml` files of `inbox/` in name order. With none, the check returns "nothing to
     check" before the portfolio is read, and names the rejected batches awaiting an answer, if any. Otherwise read both silos of the portfolio through the
     [state port](glossary.md#state-port); a silo the file has no heading of at all is absent (each command of its
     currency gets a reason), and a portfolio it cannot read whole stops the check: a silo whose headings are
     all misspelt (the error names the headings found), a `Positions` row that does not read or a ticker on two
     `Positions` rows, a `Lots` table or row that does not read, a cash or P/L cell too large to count, or a
     `Volume` that is not the sum of the units of its lots (what `decisions:evaluate` refuses, minus the checks that
     need the decision log). Read too the files of `inbox/rejected/` (regular files only) and, from the store, which
     of them a later batch settled: the others are the [rejected batches](glossary.md#rejected-batch) awaiting an
     answer, the only names a `replaces:` or a `discard` can use.
  2. Read each file as a batch ([format](input-format.md#inboxyaml)): a file that is not YAML, or whose
     `schema_version` is not `1`, is one error; every command is read on its own, so one bad command does not hide
     the next. A `replaces:` that names a file not awaiting an answer is an error of the file, at its line; a
     `discard` of such a file is an error of its command. A `discard` changes no cash, lots or stop, so a refused or
     unreadable one leaves nothing unknown and blocks no other command. A clean batch settles what it replaces and
     discards for the batches after it in name order (a second batch cannot answer the same file again).
  3. Check each command with its handler, in order, against the state the previous ones would produce, and
     each file against the state the clean batches before it produce (a rejected batch contributes nothing). A
     handler is pure: state and command in, new state or a reason out; it checks the currency of the silo
     explicitly. A sale whose costs exceed its proceeds, or whose proceeds round to zero cents (under half a cent),
     unless it uses up every remaining unit of each lot it sells, which it may close for 0.00, is refused; a refusal about lots says whether they
     are the portfolio's, were opened by an earlier command of the batch ("command 2 of this batch") or by an
     earlier file ("command 1 of inbox/a.yaml"), and a ticker none of them opened is the portfolio's alone. When
     no lot of the ticker is left, because the batch opened it and sold it out, the refusal says "the earlier
     commands"; when an earlier file did, "an earlier file".
     - **What a failure leaves unknown.** A command that did not read, or that a handler refuses, leaves the cash
       and lots of its currency (both when its currency is unknown, and only for a silo the portfolio has)
       unknown: the later commands of that currency are not checked against them, so they report no misleading
       error (a refused buy does not make its sale fail with "no open lots"). A `set_stop` or `clear_stop` that
       fails changes no cash or lots: it leaves only the stop of its ticker unknown (in every currency for a
       `clear_stop`), so the later cash and lot commands are still checked, and a later `set_stop` that succeeds
       sets the stop of its ticker and silo for sure, so it lifts that unknown. A `clear_stop` names no currency:
       it is not checked only when a command that could have changed the lots or the stop of its own ticker
       (a buy or sale of it, a `set_stop` of it in any silo, or a command that did not read) was refused or not
       checked, not for a refusal of another ticker or currency. A `set_stop` that is not checked (its currency is
       blocked) leaves the stop of its ticker unknown in the same way, until a later `set_stop` of it succeeds.
       A `snapshot` changes no cash, lot or stop, so a refused or unreadable one leaves nothing unknown; it is itself not
       checked when a command that changed the cash or the lots of its silo was refused, unread or not checked, or a split
       was (it compares both).
     - **What is listed instead.** Each command not checked is listed as "not checked" with the command that
       blocked it, so nothing is skipped without a word. The errors listed are certain; fixing them can reveal
       others in the commands listed as not checked: a `buy X` is checked once the refusal before it is fixed, a
       `set_stop X 120` is listed although its stop is known (its position or silo is not), and a `clear_stop X`
       listed because of a refusal is checked after it. A command whose refusal an earlier file that was rejected could explain is
       listed as "not checked: depends on" that file, and so is the batch that holds it: a withdrawal or a buy
       if that file changed the cash of its currency, a sale or a `set_stop` if it changed the lots of its
       ticker, a `clear_stop` if it changed the lots or the stop of its ticker, a `snapshot` that found a difference if it
       changed the cash or any lot of its silo. A rejected file that only set or cleared stops changed no cash or lots,
       so it explains none of these. Fixing the errors listed
       can also reveal a new one in a later file that depends on a rejected one but passed against the state
       without it, and in an initial stop (below) of a currency that a refusal blocked.
     - **Stops.** A stop is its own command: `buy` carries none, `set_stop` sets or moves it and `clear_stop`
       removes it; a stop that is not above zero is no stop. The initial stop of the lots a batch opened is the
       one rule of [the input format](input-format.md#inboxyaml): after the last command, a lot whose initial stop
       breaks it is refused (#159), once per `set_stop` or position, naming its lots and where the stop comes from
       (the `set_stop`, an earlier file, or `portfolio.md`; the handlers record who set each stop as they apply the
       commands). It is listed as not checked on the buy instead in a currency a refusal blocked, and when the stop
       comes from an earlier file or `portfolio.md` and a rejected file could have set or cleared the stop of that
       ticker, or sold its position out, which takes the stop with it ("not checked: depends on" that file): the
       stop it ends with is unknown until that file is fixed.
  4. Print every error, and every command not checked, as file, command position, line and reason, then a
     summary with the number of each, and exit 1; exit 0 when there is none. A clean batch whose commands leave a
     position they touched (a buy, a sale, a `set_stop` or `clear_stop`) with no stop gets a warning line for it,
     naming the silo, which does not change the exit code. So does each difference a `snapshot` found (see
     [Apply the inbox](#apply-the-inbox)): the check says what the broker and the engine hold and the size of it.
- **Writes**: nothing, neither in `inbox/` nor in the state. The [heartbeat](#heartbeat) never runs a batch: it reads
  only the list of the rejected files, to name them in its digest, so a batch with errors does not affect its stop
  check. The check names the rejected batches awaiting an answer in a line of its own, which does not change the exit
  code.
- **Applying** what it accepts is [`inbox:ingest`](#apply-the-inbox), which runs the same steps.

## Apply the inbox

- **Starts with**: the same as [Check the inbox](#check-the-inbox), then `npm run inbox:ingest`. No LLM. The only network
  call is one best-effort request of daily history per ticker a batch buys (for its ATR, see step 2), and only if one does.
  The inbox workflow starts it from a push to `inbox/`, a daily schedule or by hand, all in one `concurrency` group.
  With `STATE_COMMIT=git` (that workflow) the whole run below is one [compare-and-swap](glossary.md#compare-and-swap):
  see _Commit_ at the end of the steps.
- **Steps**:
  1. Read the files of `inbox/`: a regular file only, opened without following a link and read from the handle that
     was checked; a symbolic link, a folder or a named pipe called like a batch is reported and never read. A symbolic
     link as `inbox/` itself is refused. With none, "nothing to apply".
  2. Read the state once, through the [state port](glossary.md#state-port): the [store](glossary.md#store), or, while
     there is none, `portfolio.md` read whole (a row that does not read is refused, not dropped, so a position is
     never lost on the way). First write to the decision log the lines an earlier run committed to the store and did
     not get to write (the ones the log lacks by id), then read the decision history, whose ids no new lot may take.
     Without a `version` in `strategies/base.md` nothing is applied (the lots carry it): the run fails. When a batch
     buys, read also what the rules of an entry judge it with: the watchlist of each silo (a `watchlist.md` that cannot
     be read fails the run, as it did `decision:record`) and the ATR of each ticker bought (a failure to get it only
     leaves the stop distance unjudged). A rejected folder that cannot be read, or a file in it that is a link or hidden, is
     said in the output and stops nothing.
  3. Run the files in name order with the [same code as the check](#check-the-inbox) (`runFiles`): each command checked
     by its handler against the state the ones before it produce, a refused batch contributing nothing. The handlers
     also give each buy its lot (an id from the one source of decision ids, the rules version, the rules it breaks:
     `not_in_watchlist` or `entry_without_setup`, `overrode_block`, and `no_stop` or `stop_below_min_atr` judged with the
     stop the batch ends with; and its origin: `sistema` when it follows the latest proposal of the system for that
     ticker within 10 days that no trade cited yet, `propietario` otherwise) and each sale the exits of its lots, with the entry costs earlier exits took (from the history and from
     the batches before), its own proceeds (`units × price`) and its origin (`sistema` after a `sell` proposal of the system
     within 10 days, `propietario` otherwise). A `convert` changes the cash of both silos in one step, from the cash the
     commands before it left (a conversion refused leaves the cash of both silos unknown to the commands after it); it
     opens no lot and writes its `fx_conversion` line. A `split` (a [corporate action](glossary.md#corporate-action))
     scales every open lot of its ticker in every silo that holds it (units × new ÷ old, entry price and initial
     stop ÷ new ÷ old) and the position with them, changes no cash and keeps the order of the lots, so a sale after it
     sells the adjusted lots first in, first out; a split that would leave a whole number of units fractional, that is
     dated before a lot of the ticker was bought, or that finds no lot, is refused, and one refused or unread leaves
     the lots and the stop of its ticker unknown to the commands after it. It writes a `split` line per silo; the
     entry line of a lot the batch itself opened stays as it was bought, and the lot is a split of it, which the lots
     check and the evaluation already accept (R does not change). A `snapshot` (the broker's cash and positions of one
     silo as of a date, #138) is compared with the state the commands before it left: the cash to the cent and the units
     of each ticker either side holds (to the units tolerance). It changes no cash, position, lot or stop: it records on
     the silo the date and each difference (what each side holds, and the size, the broker's less the engine's), because the
     broker is the owner's fact but applying it silently would hide a trade missed or entered wrongly, which the owner
     corrects with a command. It is refused for a silo the portfolio lacks, a date in the future, a ticker listed twice. It writes a `reconcile` line per difference (none when there is none).
  4. Commit once: the store is written with the state the clean batches end with (a silo they changed is synced now),
     the batches applied whose files are not moved yet, the rejected batches the clean ones replaced or discarded (each
     with the hash of its file), and the decision-log lines of their trades (an `entry` per buy, an `exit` per lot
     sold, an `fx_conversion` per conversion, a `split` per silo a split scaled and a `reconcile` per difference of a snapshot, an exit of 0 included: the lot is closed in the log as in the state). Then the lines go to `logs/decisions.jsonl`, and `portfolio.md` is the view generated
     from the store (the store is written first, the view after it).
  5. Move each clean file to `inbox/applied/` and each refused one to `inbox/rejected/` with `<file>.errors.txt`
     (command position, line, reason), never over a file already there. A file in `rejected/` is never read as a
     batch again: it stays as the audit trail and awaits an answer until it is settled. Then the store forgets the
     batches moved.
  6. Print what was applied, the warnings (a position with no stop), each error and what was left unread; exit 1 if any
     batch was rejected or left unread, 0 otherwise.
  7. Commit (only with `STATE_COMMIT=git`): the changes under `state/`, `inbox/`, `portfolio.md` and `logs/` are committed
     and pushed on top of the commit the run started from, the branch's last one. If the push is refused because the
     branch moved (another run committed), the run throws its changes away, brings `state/`, `inbox/`, `portfolio.md` and
     `logs/` to the new last commit (nothing else of the checkout is touched) and does steps 1 to 6 again over it, at most `STATE_COMMIT_ATTEMPTS` times (3). A retry therefore judges each batch
     against the state it now meets: valid before and invalid now is rejected like any other, and the result is that of a
     fresh run. It asks again for nothing it already asked: the history of a ticker is requested once per run, not once
     per attempt. A push that fails for another reason (network, permission) is not a lost race: it is not retried and
     the run fails with the batches still in `inbox/`.
- **Reads / writes**: reads the last commit of the branch (with `STATE_COMMIT=git`), the state and the rest above. Writes
  `state/portfolio.json` and `portfolio.md`, `logs/decisions.jsonl` (telemetry), and moves the files of
  `inbox/`; with `STATE_COMMIT=git` it commits and pushes them as one commit, `chore(state): apply inbox <date>`. A batch
  with an error changes none of them. The writers of the store found when this was written: `inbox:ingest` and
  `decision:record` (compare-and-swap), and the price refresh of the heartbeat and the Monday briefing (through
  `commit-changes`, see [Heartbeat](#heartbeat)).
- **When it fails**: a transient failure (the store or the log cannot be written, a file cannot be moved) leaves the
  files in `inbox/` and throws; the next run finishes it without applying anything twice (the store remembers the batches
  it applied, and the lines it owes the log).
  A run that loses the race every time (step 7) leaves the batches in `inbox/`, commits nothing, says "State not committed"
  and exits 0: a delay of the state, never a rejection of a batch. The next run applies them.
- **Never**: touches the stop check, waits for it or makes it wait (the compare-and-swap takes no lock and the
  heartbeat does not import it). The [heartbeat](#heartbeat) never runs a batch, so a rejected batch cannot stop it
  (it names it in its digest); it reads the state last applied, and a refused batch leaves it as it was.

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
  2. Compute the net [R](glossary.md#r) of each closed trade, one per [lot](glossary.md#lot), from
     its exits alone (each exit carries a snapshot of its lot). Exits of one lot
     whose entry units, entry price and initial stop differ by one common ratio (a split corrected
     in `Lots` between two sales) still count as one lot, and R does not change. A lot is closed when its last exit has `lot_units_left` = 0. An
     exit without the snapshot or without `lot_units_left`, an oversold lot, and a lot whose exits do
     not add up (units left that do not follow the sales, or snapshots that disagree) are not
     measured but are reported (the exits and lots by name) in the cutoff board and on the console.
     The open trades of the board come from the lots of the portfolio (the store, else the `Lots` of `portfolio.md`; one per [lot](glossary.md#lot),
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
- **Archive**: with the archive read (`DECISIONS_ARCHIVE_DIR` set to it), archiving a quarter
  never changes the result, because an exit carries everything its R needs and a lot's entry and
  exits stay live while it is open (see [Log retention](log-retention.md)); without it, the
  archived quarters are not measured and the run warns, as in step 1; a lot whose entry is in no loaded file is a lots mismatch that
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
