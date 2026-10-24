// English output catalog. It defines the shape of `Messages`:
// every other catalog must provide the same keys with the same signatures.
import type { BuyTicket, ConvictionPoint, MarketRegime } from "../types.js";
import type { WatchlistExit } from "../utils/watchlist-exit.js";

export const en = {
  /** Locale for numbers in tables (thousands separator and decimal mark). */
  locale: "en-US",
  /** Separator of a short list (the report horizons are two). */
  and: " and ",

  mail: {
    alertSubject: (action: string, ticker: string) => `[Finance Agent] TRADE ALERT: ${action} ${ticker}`,
    orderTicketTitle: "ORDER TICKET",
    adjustStopTitle: "STOP-LOSS ADJUSTMENT",
    tickerField: "Ticker",
    directionField: "Direction",
    engineNote: "Stop, units and amount are computed by the engine (ADR-0009); the target comes from the analysis.",
    noticesTitle: "NOTICES",
    assumptionsTitle: "ASSUMPTIONS",
    thesisTitle: "THESIS",
    convictionLabel: "Conviction:",
    triggersLabel: "Triggers:",
    disclaimer:
      "This message is decision support, not financial advice. " +
      "Executing any order is manual and the owner's responsibility.",
  },

  ticket: {
    units: "Units",
    approxUnits: "Approx. units",
    amount: "Amount",
    referencePrice: "Reference price",
    stopLoss: "Stop-loss",
    target: "Target",
    risk: "Risk",
    riskValue: (risk: string, budget: string, cap: string) => `${risk} of ${budget} (${cap})`,
    rewardRisk: "R:R",
    rewardRiskValue: (gross: string, net: string) => `${gross} gross · ${net} net`,
    estimatedCosts: "Estimated costs",
    taxedCosts: (costs: string, taxPct: number) => `${costs} (transaction tax ${taxPct}%)`,
    untaxedCosts: (zero: string) => `${zero} (no transaction tax)`,
    newStop: "New stop-loss",
    newStopValue: (stop: string, atr: number) => `${stop} (${atr} ATR below the price)`,
    previousStop: "Previous stop",
    noStop: "no stop",
    cappedBy: {
      risk: "risk budget",
      position: "capped by the per-position limit",
      cash: "capped by available cash",
    } satisfies Record<BuyTicket["cappedBy"], string>,
  },

  conviction: {
    points: (minRewardRisk: number): Record<ConvictionPoint, string> => ({
      top_quintile: "top quintile",
      regime_favorable: "favorable regime",
      reward_risk: `R:R ≥ ${minRewardRisk}`,
      dated_catalyst: "dated catalyst",
    }),
  },

  regime: {
    effects: {
      favorable: "FAVORABLE (benchmark above its SMA200 and SMA50 rising)",
      neutral: "NEUTRAL (no effect)",
      adverso: "ADVERSE (benchmark below its SMA200): every new entry is BLOCKED",
    } satisfies Record<MarketRegime, string>,
    noData: "no data, does not block",
    line: (currency: string, reference: string, description: string) =>
      `Regime ${currency}${reference}: ${description}`,
  },

  setup: {
    patterns: { pullback: "trend pullback", breakout: "breakout" },
    armed: (ticker: string, pattern: string, level: number, currency: string, target: number) =>
      `${ticker}: ${pattern} ARMED — Buy Stop at ${level} ${currency}, target ${target}`,
    confirmed: (ticker: string, pattern: string, level: number, currency: string, target: number) =>
      `${ticker}: ${pattern} confirmed at ${level} ${currency}, target ${target}`,
    sizing: (stop: number, units: string, amount: string, currency: string, rrNet: string) =>
      ` · stop ${stop}, ${units} units ≈ ${amount} ${currency}, net R:R ${rrNet}`,
    sma50Distance: (atr: number) => ` · SMA50 dist. ${atr} ATR`,
    eligible: "ELIGIBLE",
    blocked: (reasons: string) => `BLOCKED (${reasons})`,
  },

  heartbeatDigest: {
    subject: (currency: string, sections: string) => `[Finance Agent] Heartbeat ${currency} — ${sections}`,
    labels: {
      breaches: "stop crossed",
      lots: "problem with the lots",
      tightStops: "tight stop",
      armed: "armed breakout",
      escalated: "to analysis",
    },
    breachIntro: (syncedAt: string) => [
      `## Stops crossed — check your broker`,
      ``,
      `These positions trade **below their recorded stop-loss**.`,
      ``,
      `The engine cannot know whether the broker already executed the stop: \`portfolio.md\` is`,
      `synced by hand and its last sync is from **${syncedAt}**.`,
      `Check the account and, if the stop did not fire, decide with the discipline of`,
      `\`strategies/base.md\` (respect the stop even if the thesis is still alive).`,
      ``,
    ],
    breachHeader: [`| Ticker | Price | Stop | Below the stop | Unrealized P/L |`, `|---|---|---|---|---|`],
    breachOutro: [
      ``,
      `After updating the account, reflect the change in \`portfolio.md\``,
      `(guide: \`routines/portfolio-sync.md\`) so the rest of the system stops`,
      `reasoning about a position that no longer exists.`,
    ],
    lotsIntro: [
      `## \`portfolio.md\`: problem with the lots`,
      ``,
      `The \`Lots\` table cannot be read, is missing, or does not match \`Positions\` or the decision log. The heartbeat keeps`,
      `watching your positions (stops, \`Volume\`, \`Avg price\`), but \`decision:record\` and the`,
      `evaluation refuse the file until it is fixed:`,
      ``,
    ],
    lotsOutro: [
      ``,
      `Fix \`Lots\` by hand: it must exist and be readable, each \`Volume\` must be the sum of the \`Units\` of its lots and`,
      `every \`Entry id\` must be an entry of the log (\`logs/decisions.jsonl\`; see \`docs/input-format.md\`).`,
    ],
    tightIntro: (minAtr: number) => [
      `## Stops too tight`,
      ``,
      `These positions have the stop-loss **less than ${minAtr} ATR** from the current`,
      `price: it sits inside the asset's normal noise, so it will most likely`,
      `fire on a bad session rather than because the thesis broke.`,
      ``,
    ],
    tightHeader: (referenceAtr: number) => [
      `| Ticker | Price | Stop | Distance | ATR14 | Multiple | Stop at ${referenceAtr} ATR |`,
      `|---|---|---|---|---|---|---|`,
    ],
    tightOptions: [
      ``,
      `Options, in order of preference (\`portfolio-policy.md\` → "Stop-loss in`,
      `ATR multiples"):`,
      ``,
      `1. **Widen the stop** to the reference distance in the last`,
      `   column, if the thesis is still alive and you accept that loss comfortably.`,
      `2. **Reduce the size** of the position and widen the stop: the loss in`,
      `   money becomes tolerable again without tightening the distance.`,
      `3. **Close** if you no longer believe in the thesis — but close it for that reason, not`,
      `   by leaving a tight stop that makes the decision for you.`,
      ``,
      `You don't move a stop closer to risk less: you buy less for that.`,
    ],
    tightBelowEntry: (tickers: string) => [
      ``,
      `⚠️ In ${tickers} the reference stop sits **below`,
      `the average purchase price**: widening it turns a stop that protected`,
      `profit into one that allows a loss. If the position is already in profit and you want`,
      `to lock in part of it, option 2 (trimming volume) is usually better than tightening the stop.`,
    ],
    tightOutro: (syncedAt: string) => [
      ``,
      `The real stop lives in your broker: the engine only reads the Stop loss column of`,
      `\`portfolio.md\` (last sync: **${syncedAt}**). If you`,
      `change it, reflect it there (guide: \`routines/portfolio-sync.md\`).`,
    ],
    armedIntro: [
      `## Armed breakouts`,
      ``,
      `Base formed near highs and not yet broken (ADR-0013).`,
      "If it is ELIGIBLE, you can leave a Buy Stop order in your broker at the level, with a short expiry and the engine's stop.",
      ``,
    ],
    armedOutro: [
      ``,
      "They are logged in logs/decisions.jsonl as setup_armed. If the order fills, record it with decision:record.",
    ],
    escalatedIntro: [`## Signals sent to analysis`, ``],
    escalatedLine: (ticker: string, triggers: string, price: string, currency: string) =>
      `- ${ticker}: ${triggers} at ${price} ${currency}`,
    escalatedSetup: (pattern: string, target: number) => ` (${pattern}, pattern target ${target})`,
    escalatedOutro: [
      ``,
      `The Routine analyzes them when this heartbeat finishes; you will get a separate alert`,
      `only if the analysis proposes a trade.`,
    ],
  },

  evaluation: {
    frontmatterTitle: "Decision evaluation — cut board",
    generated: (asOf: string, count: number, span: string) => [
      `*Generated by \`npm run decisions:evaluate\` on ${asOf} from \`logs/decisions.jsonl\` and the archived quarters:`,
      `${count} ${count === 1 ? "decision" : "decisions"} (${span}).  No LLM.*`,
    ],
    span: (from: string, to: string) => `${from} to ${to}`,
    emptyRegistry: "Empty log: there are no decisions to measure yet.",
    counterNotStarted: (rulesVersion: string, measuredFrom: string) => [
      "> [!info] Counter not started",
      `> C v1 is under construction (rules ${rulesVersion}): the counter starts with the first entry under rules 1.0.`,
      `> Until then, portfolios and drawdown are measured **as a trial** from the start of the log (${measuredFrom}) and do not count for the cut.`,
    ],
    counterRunning: (start: string, rulesVersion: string) =>
      `*Counter running since ${start}. Rules in force: ${rulesVersion}.*`,
    expectancyNone: "— (no trades with an initial stop)",
    expectancy: (r: string, withR: number, winners: number) => `${r} over ${withR} (${winners}/${withR} winners)`,
    excludedNoStop: (n: number) => `; ${n} without an initial stop, left out`,
    totalNone: "— (no EUR/USD rate or no shadow portfolio for some silo)",
    total: (real: string, shadow: string, diff: string) => `${real} vs ${shadow} (${diff})`,
    boardHeader: ["| Indicator | Value | Criterion (ADR-0009 §4) |", "|---|---|---|"],
    closedTradesRow: (total: number, review: number, decision: number) =>
      `| System trades closed under C v1 | ${total} | review at ${review}, decision at ${decision} |`,
    expectancyRow: (value: string) => `| Expectancy, net R | ${value} | > 0R |`,
    openTradesRow: (open: number) => `| System trades open under C v1 | ${open} | — |`,
    portfoliosRow: (value: string) => `| Real vs shadow portfolios, in EUR | ${value} | real ≥ shadow |`,
    siloHeader: [
      "| Silo | Benchmark | Since | Real | Shadow | Difference | Real return | Shadow return | Drawdown from peak | Max drawdown |",
      "|---|---|---|---|---|---|---|---|---|---|",
    ],
    drawdownPause: (currency: string, pct: string, peakDate: string, threshold: number) => [
      `> [!danger] Drawdown pause in the ${currency} silo`,
      `> Down ${pct}% from its peak of ${peakDate} (threshold ${threshold}%):` +
        " no new entries are opened in it until the monthly retrospective.",
    ],
    drawdownTrial: "> As a trial: the official measurement starts with the counter.",
    groupsSmallSample: (min: number) => [
      "> [!warning] Small sample",
      `> Some group has fewer than ${min} cases: a difference of a few points between groups is noise.`,
    ],
    tradesSmallSample: (min: number) => [
      "> [!warning] Small sample",
      `> With fewer than ${min} trades, the expectancy describes, it does not decide.`,
    ],
    decisionsMissing: {
      title: "> [!warning] Part of the decision log was not loaded",
      line: (before: string) => `decisions are missing before ${before}: is \`DECISIONS_ARCHIVE_DIR\` set?`,
    },
    reconstructionMismatch: "> [!warning] The silo reconstruction does not add up",
    unmeasured: {
      title: "> [!warning] Some exits and lots were not measured",
      exitsWithoutSnapshot: (n: number) =>
        `${n} ${n === 1 ? "exit" : "exits"} without a lot snapshot, left out of the closed trades.`,
      oversoldLot: (ticker: string, lotId: string) =>
        `${ticker}, lot ${lotId}: its sales add up to more units than the entry bought (inconsistent data); not measured.`,
      skippedExit: (ticker: string, date: string, lotId?: string) =>
        `${ticker}, ${date}${lotId ? `, lot ${lotId}` : ""}`,
      moreSkippedExits: (n: number) => `… and ${n} more.`,
      inconsistentLot: (ticker: string, lotId: string, reason: "units_left" | "snapshot") =>
        `${ticker}, lot ${lotId}: ${
          reason === "units_left"
            ? "the units left after each of its exits do not follow what the exits sold"
            : "its exits disagree on the data of the entry"
        } (inconsistent data); not measured.`,
    },
    stopAt: (atr: number, horizon: string) => `${atr} ATR in ${horizon}`,
    howToRead: (o: { horizons: string; stops: string; minRewardRisk: number; planWindow: number }) => [
      "## How to read it",
      "",
      "- **Closed trade:** an `entry` and the `exit` that cites it. **Net R** = (exit − entry − costs per unit) / (entry − initial stop)",
      "  (ADR-0009 §2). The initial stop is the entry's or, if missing, that of the proposal it cites; without it, the trade stays out of the",
      "  expectancy. Entries by the system under C v1 (rules 1.0 or later) count for the cut.",
      "- **Portfolios:** each silo's real value is rebuilt backwards from `portfolio.md` (total cash and positions at the close),",
      "  undoing the log's trades and flows. The shadow starts with that value the day before the start and replicates",
      "  every deposit, withdrawal and conversion in the silo's benchmark (ADR-0009 §1). Money-weighted return (modified",
      "  Dietz). Drawdown is measured on the return without flows, so deposits do not hide losses.",
      `- **Return at ${o.horizons} sessions** of the asset itself from the last close ≤ the decision date, and **excess**`,
      "  over the silo's benchmark between the same dates. Price only, no dividends. For a `hold`, a sale or an exit it is what",
      "  the asset did afterwards: positive after a sale means it was sold early. Aggregates only count complete horizons.",
      "- **Plan in R** of the buys (proposals, blocks, entries, screening and eligible not proposed): stop and target of the ticket.",
      `  If missing, stop at the horizon's distance with the recorded ATR (${o.stops}) and target at ${o.minRewardRisk}R, marked with †.`,
      `  Over the following ${o.planWindow} sessions: maximum gain and maximum loss in R, and which was hit first. If a session hits both, the stop counts.`,
      `  **Plan R:** the target's, −1R at the stop (the daily bar does not see gaps) or the last close's if in ${o.planWindow} sessions it hit`,
      "  neither. “Stop → target” is a stop that fired before the price reached the target: many of them point to stops set too tight.",
      "- **Non-independent observations:** decisions in the same week share a market; the effective sample is smaller than the number of rows.",
      "",
    ],
    tradesTitle: "## Closed trades",
    noTrades: "No closed trades yet.",
    tradeGroupsHeader: [
      "| Group | Trades | With initial stop | Expectancy (net R) | Winners |",
      "|---|---|---|---|---|",
    ],
    tradesHeader: [
      "| Entry | Exit | Ticker | Silo | Origin | Rules | Rule breaks | Initial stop | Net R |",
      "|---|---|---|---|---|---|---|---|---|",
    ],
    countsLegend: "✓ Counts for the cut.",
    aggregatesTitle: "## Aggregates",
    noDecisions: "No decisions yet.",
    aggregatesHead: "| Group | Decisions | ",
    aggregatesHorizon: (h: number) => `Complete ${h}s | Mean ${h}s | Excess ${h}s`,
    aggregatesTail: " | With plan R | Target first | Stop first | Stop → target | Mean plan R |",
    noData: "no data",
    pending: "pending",
    neither: "neither",
    neitherAfter: (sessions: number) => `neither (${sessions}s)`,
    target: "target",
    stop: "stop",
    stopToTarget: "stop → target",
    detailTitle: "## Detail by decision",
    detailNote:
      "*In italics, horizon not yet complete (in brackets, sessions elapsed). † stop or target inferred, not from the ticket.*",
    noDecisionsToFollow: "No decisions to follow yet.",
    detailHead: "| Date | Ticker | Type | Origin | Conv. | Rules | Price | ",
    detailHorizon: (h: number) => `${h} sessions | Excess ${h}s`,
    detailTail: " | Stop / target | Max gain | Max loss | First | Plan R |",
    noHistory: (tickers: string) => `No usable history from Yahoo: ${tickers}.`,
    groupings: {
      originRules: (system: boolean, broke: boolean) =>
        `${system ? "System" : "Owner"}, ${broke ? "breaking rules" : "without breaking rules"}`,
      cutCounter: "Cut counter (system, C v1)",
      entriesTitle: "Entries by origin and rules",
      entriesNote:
        "Do the system's entries beat the discretionary ones, and those that follow the rules beat those that don't?",
      convictionTitle: "Buy proposals by conviction",
      convictionNote:
        "Proposals and blocks, by the conviction of the engine's rubric (ADR-0012 §7), which the heartbeat computes too. Does high conviction hit more often than medium? The one the reasoner used to set is kept apart.",
      noEngineConviction: "no engine conviction",
      eligibleTitle: "Eligible vs blocked",
      eligibleNote:
        "Do the engine's blocks (ADR-0010 and the framework) avoid bad entries? “Eligible not proposed” are the eligible setups the reasoner let pass. The two blocked groups are disjoint: “by regime” is the hypothesis of version 0.6 and “for other reasons” its control group.",
      proposals: "Proposals",
      eligibleNotProposed: "Eligible not proposed",
      blockedByRegime: "Blocked by regime",
      blockedOther: "Blocked for other reasons",
      screeningTitle: "Screening: interesting vs rejected",
      screeningNote: "Does what the screening marks as interesting beat what it rejects?",
      interesting: "Interesting",
      rejected: "Rejected",
      screeningConvictionTitle: "Screening: interesting by conviction",
      screeningConvictionNote:
        "Does the conviction of the engine's rubric (ADR-0012 §7) order the returns? Only since rules 0.8: before, the reasoner chose it.",
      rankingTitle: "Screening: ranking vs exploration",
      rankingNote: "Do the best of the ranking beat those picked at random among the ones passing filter 0 (ADR-0012)?",
      ranking: "Ranking",
      exploration: "Exploration",
      versionTitle: "By rules version",
      versionNote:
        "Proposals, blocks and entries. Each rules change is assessed only with the decisions after it (ADR-0009 §5).",
    },
    siloWarnings: {
      negativeCash: (currency: string, start: string, cash: string) =>
        `${currency}: cash on ${start} comes out negative (${cash}); some deposit, conversion or sale is missing from the log, or the total cash in portfolio.md is out of date.`,
      oversold: (currency: string, ticker: string, units: string, start: string) =>
        `${currency}: ${ticker} would have ${units} units on ${start}; the log buys more than portfolio.md holds, so a sale is missing from the log.`,
      missingCloses: (currency: string, tickers: string) =>
        `${currency}: no closes for ${tickers}; they are valued at the last known price.`,
      noShadow: (currency: string, reference: string) =>
        `${currency}: no closes for ${reference} in the period; there is no shadow portfolio.`,
    },
  },

  chart: {
    title: "Proposal quality (SLI 1)",
    insufficient: (n: number, min: number) => `Insufficient data: ${n} of ${min} evaluated proposals`,
    enough: (n: number) => `${n} evaluated proposals. The confidence bound is not computed yet (ADR-0014).`,
    summary: (meanR: string, benchmarkR: string) => `Mean plan R ${meanR} · benchmark, same windows ${benchmarkR}`,
    noProposals: "No evaluated buy proposals yet.",
    meanRLabel: "Mean plan R (cumulative)",
    benchmarkLabel: "Benchmark, same windows (in R)",
    countLabel: "Evaluated proposals (n)",
    minSampleLabel: (min: number) => `n = ${min}`,
    method: [
      "Plan R: each proposal's stop, target or last close over 60 sessions.",
      "Benchmark: its return over the same window, divided by the stop distance.",
    ],
    notice: "Not financial advice. R and counts only; no money amounts.",
    description: (n: number, from: string, to: string) =>
      `Cumulative mean plan R of ${n} evaluated buy proposals against the benchmark, from ${from} to ${to}, and the number of evaluated proposals over time.`,
    descriptionEmpty: "No evaluated buy proposals yet.",
  },

  outcomes: {
    frontmatterTitle: "Screening outcomes — What happened after each evaluation",
    generated: (today: string, count: number, tickers: number, span: string) => [
      `*Generated by \`npm run screening:outcomes\` on ${today} from \`screening-log.md\`: ${count} evaluations`,
      `of ${tickers} tickers (${span}).  No LLM.*`,
    ],
    benchmarkFor: (symbol: string, index: string) => `${symbol} for ${index}`,
    howToRead: (o: { horizons: string; benchmarks: string; dd0010: string; dd0016: string }) => [
      "## How to read it",
      "",
      "- **Base close:** last complete close ≤ analysis date (the screening runs on Saturday: Friday's close).",
      "  No look-ahead bias: the screening result was already written that day.",
      `- **Return at ${o.horizons} sessions** of the asset itself. If the horizon is not complete, the row`,
      "  shows what has elapsed up to the last close, but **aggregates only count complete horizons**.",
      `- **Excess:** the asset's return minus its index's between the same dates (${o.benchmarks}).`,
      "  Commodities has no benchmark: 4GLD.DE is gold only and does not represent the block.",
      "- Price only: no dividends (neither in the asset nor in the index) and in the quote currency.",
      "- **Random-pick baseline: only “All (draw)”, and approximate.** Candidates come from a draw",
      "  of the universe that excludes what is already in the watchlist and what was analyzed in the previous 8 weeks.",
      "  “Not interesting” is not random: it is exactly what the filter rejected.",
      `  Since ${o.dd0016} candidates come from the ranking and “All (ranking)” is not random: the comparison`,
      "  with chance is “Screening: ranking vs exploration” in `logs/decisions-evaluation.md` (ADR-0012).",
      "- **Non-independent observations:** evaluations in the same week share a market, and those of",
      "  adjacent weeks much of the horizon. The effective sample is smaller than the number of rows.",
      `- **Cohorts split at ${o.dd0010} (DD-0010) and ${o.dd0016} (ADR-0012):** before DD-0010 what was near`,
      "  highs was rejected; with DD-0010, the analyst rejects what is below the SMA200; since ADR-0012,",
      "  the engine ranks the universe and the analyst no longer sees what fails filter 0. They are not mixed.",
      "",
    ],
    cohorts: { pre: "Before DD-0010", post: "DD-0010 to ADR-0012", ranking: "Since ADR-0012" },
    results: { interesting: "Interesting", not_interesting: "Not interesting" },
    all: "All",
    allRanking: "All (ranking)",
    allDraw: "All (draw)",
    summaryTitle: (horizon: number) => `## Summary at ${horizon} sessions`,
    summaryHeader: [
      "| Cohort | Result | Complete | Mean | Median | Mean excess | Median excess | Beats the index | Pending | No data |",
      "|---|---|---|---|---|---|---|---|---|---|",
    ],
    noneComplete: (horizon: number) => `> [!info] No evaluation has completed ${horizon} sessions yet.`,
    smallSample: (min: number) => [
      "> [!warning] Small sample",
      `> Some group has fewer than ${min} complete evaluations. With these sizes, a difference`,
      "> of a few points between groups is noise: this table describes, it does not decide.",
    ],
    reasonsTitle: "## Rejections by reason",
    reasonsNote: [
      "*Reason inferred from the `Summary` (truncated to 80 characters): heuristic classification, indicative only.*",
      "*Each cohort's “Interesting” row is there for reference.*",
    ],
    reasonsHead: "| Cohort | Reason | Evaluations | ",
    reasonsHorizon: (h: number) => `Complete ${h}s | Mean ${h}s | Excess ${h}s`,
    interestingReference: "*(Interesting)*",
    detailTitle: "## Detail by evaluation",
    detailNote:
      "*In italics, horizon not yet complete (in brackets, sessions elapsed). † ticker evaluated more than once.*",
    detailHead: "| Date | Ticker | Block | Result | Reason | Base close | ",
    detailHorizon: (h: number) => `${h} sessions | Excess ${h}s`,
    noData: "no data",
    pending: "pending",
    repeated: (tickers: string) => [
      `† Evaluated more than once: ${tickers}. Each evaluation counts as one observation,`,
      "but they share an asset and are not fully independent.",
    ],
    noHistory: (tickers: string) => `No usable history from Yahoo: ${tickers}.`,
    reasons: {
      filter0Failed: "Fails filter 0",
      filter0Borderline: "Filter 0 borderline",
      criteriaNotMet: "Passes filter 0, not the criteria",
      driverCovered: "Driver already covered in watchlist",
      badData: "Insufficient or doubtful data",
      downtrend: "Downtrend",
      nearHighs: "Near highs (previous criterion)",
      notEnoughCriteria: "Not enough criteria met",
      other: "Other (see summary)",
    },
  },

  screening: {
    candidateHeader: (ticker: string, name: string, conviction: string, selection: string) =>
      `${ticker} — ${name}  [conviction: ${conviction}${selection ? ` · ${selection}` : ""}]`,
    setupLine: (setup: string) => `Setup: ${setup}`,
    parseFailed: "Error parsing Claude's response",
    noReason: "No answer",
    buyOnlyWithSetup:
      "It will only be bought with a setup: the heartbeat looks for a pullback or a breakout every day (ADR-0013).",
    nextCatalyst: (catalyst: string) => `Next catalyst: ${catalyst}`,
    exitReasons: {
      out_of_universe: "out of the universe",
      filter_zero: "fails filter 0",
      out_of_top: "out of the top half of the ranking",
      no_setup: "no setup",
    } satisfies Record<WatchlistExit["reason"], string>,
    exitDetails: {
      notInUniverse: "not in screening-universe.md",
      rankPosition: (rank: number, size: number, currency: string) => `rank ${rank} of ${size} in the ${currency} silo`,
      noSetupWeeks: (weeks: number) => `no setup in the last ${weeks} weeks`,
    },
    exitArchiveReason: (date: string, detail: string) => `Mechanical exit ${date}: ${detail}`,
    rankingFallback: {
      noReferenceHistory: (ticker: string) => `no recent history for the benchmark ${ticker}`,
      lowCoverage: (withData: number, total: number) => `only ${withData} of ${total} assets with data`,
      staleMedian: (date: string | undefined) => `the universe's median last session is ${date ?? "none"}`,
    },
    noRanking: (reason: string) => [
      `⚠️  NO RANKING: ${reason}. Candidates were drawn as before the ranking existed,`,
      "    only among those passing filter 0 (ADR-0012).",
    ],
    siloWithoutCandidates: (currency: string, cause: string) => `⚠️  ${currency} SILO WITHOUT CANDIDATES: ${cause}.`,
    noDrawnPassesFilter: "no drawn asset of the silo passes filter 0",
    noneEligible: "no asset of the silo passes filter 0",
    allEligibleTaken: (eligible: number) =>
      `the ${eligible} eligible in the ranking are in the watchlist or were rejected recently`,
    exploration: "exploration",
    rankingLabel: (rank: number) => `ranking #${rank}`,
    subjectAdded: (added: number) => `[Finance Agent] Screening — ${added} new in watchlist`,
    subjectNoneAdded: (analyzed: number) => `[Finance Agent] Screening — ${analyzed} analyzed, none added`,
    emailTitle: (today: string) => `Finance Agent — Weekly Screening (${today})`,
    counts: (analyzed: number, added: number, rejected: number) =>
      `Analyzed: ${analyzed} | Added to watchlist: ${added} | Rejected: ${rejected}`,
    overdueReview: (date: string) => [
      `⚠️  REMINDER: screening-universe.md has next_review=${date} (already overdue).`,
      "    Review and update the universe list.",
    ],
    unresolved: (count: number, tickers: string) => [
      `⚠️  ATTENTION: ${count} candidate(s) were left unresolved in logs/pending-screening/:`,
      `    ${tickers}`,
    ],
    withSetupTitle: "── WITH AN ACTIVE OR ARMED SETUP ──────────────────────────────",
    toWatchTitle: "── WATCH ───────────────────────────────────────────────────────",
    addedTitle: "── ADDED TO WATCHLIST (reason) ───────────────────────────────",
    retiredTitle: "── RETIRED FROM THE WATCHLIST ──────────────────────────────────",
    rejectedTitle: "── REJECTED ─────────────────────────────────────────────────",
    pendingExitCriteria: (tickers: string) => [
      "── REMINDER: THESES WITHOUT AN EXIT CRITERION ───────────────────",
      `These active theses still have no "When it would stop being valid" defined: ${tickers}.`,
      "When you fill it in, remove `exit_criteria: pending` from the thesis frontmatter or the reminder will keep showing up.",
    ],
    footer: [
      "This is an automatic summary from the Finance Agent.",
      "The added assets are already in watchlist.md and will be monitored in the next heartbeat.",
      "NOTE: Adding to the watchlist is automatic; review and adjust thresholds if needed.",
    ],
  },

  briefing: {
    emailTitle: (today: string) => `[Finance Agent] Monday Briefing — ${today}`,
    subject: (today: string, plan: string) => `[Finance Agent] Monday Briefing ${today} — ${plan}`,
    planFallback: "see the full report",
    retired: (tickers: string) => `Automatic watchlist retirements: ${tickers}`,
    noneRetired: "No automatic watchlist retirements this week.",
    retireReason: (today: string) => `Monday Briefing ${today}: thesis invalidated`,
    macroSearchWarning:
      "> ⚠ Automatic notice: the web search returned no results in this run (blocked, exhausted or unused) — the context in this section may rest only on trained knowledge, not real time.\n",
    ticketsTitle: "## Engine tickets",
    ticketsNote:
      "Sell amount and trailing stop are computed by the engine (ADR-0009). What is blocked is not executed.",
    proposed: "PROPOSED",
    blocked: (codes: string) => `BLOCKED (${codes})`,
    ticketHeader: ["| Field | Value |", "|---|---|"],
    noTicket: "No ticket: the engine could not compute it.",
  },

  decisionLog: {
    decisionTitle: "## Decision",
    fieldHeader: ["| Field | Value |", "|---|---|"],
    action: "Action",
    conviction: "Conviction",
    setup: "Setup",
    setupValue: (pattern: string, level: number, target: number) => `${pattern} at ${level}, target ${target}`,
    triggers: "Triggers",
    rangePosition: "Range position",
    bias: "Bias",
    ticketTitle: "## Ticket",
    direction: "Direction",
    referencePrice: "Reference price",
    proposedTarget: "Proposed target",
    block: "Block",
    assumptionsTitle: "## Assumptions",
    noticesTitle: "## Notices",
    thesisTitle: "## Thesis",
  },

  thesis: {
    title: (ticker: string, name: string) => `Thesis ${ticker} — ${name}`,
    investmentThesis: "## Investment thesis",
    thesisPending: "(thesis still to be written)",
    technicalAnalysis: (date: string) => `## Technical analysis (screening ${date})`,
    nextCatalyst: "## Next catalyst",
    entryTitle: "## Entry",
    entry: "Only with a heartbeat setup (pullback or breakout, ADR-0013); stop and size are computed by the engine.",
    invalidationTitle: "## When it would stop being valid",
    exitCriteriaPending: "(to be defined: fill it in and remove `exit_criteria: pending` from the frontmatter)",
    referencesTitle: "## References",
    references: [
      "- `watchlist.md` — watched assets",
      "- `architecture/decisions/0017-setups-de-entrada.md` — when to buy",
    ],
  },

  twoMonthRule: (ticker: string, pnl: number, currency: string, date: string, until: string) =>
    `Two-month rule (art. 33.5.f LIRPF): ${ticker} was sold at a loss (${pnl} ${currency}) on ${date}. ` +
    `Buying it back before ${until} defers that loss.`,
};
