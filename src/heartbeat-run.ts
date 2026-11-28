// One heartbeat run, scoped to one currency (silo). It lives apart from
// index.ts so it can be tested with fake providers: index.ts runs main() on
// import.
//
// Everything the run has to report goes into a single summary email at the
// end (utils/heartbeat-digest.ts), early exits included (holiday,
// no signals), without repeating what was already sent today.
import { collectWatchedTickers, evaluateSignals } from "./heartbeat.js";
import { sendSummaryEmail } from "./mailer.js";
import { config } from "./config.js";
import { describeProblems, resolveConfiguration, type ConfigurationFile } from "./configuration.js";
import { YahooFinanceProvider } from "./providers/yahoo-finance.js";
import { fetchHeadlines } from "./providers/news-provider.js";
import {
  appendDecisions,
  getLastLogForTicker,
  listLogFiles,
  readDecisions,
  readHeartbeatSent,
  readRulesVersion,
  readWatchlistSkippingBadTickers,
  writeHeartbeatSent,
} from "./vault-io.js";
import { readPortfolio, recordPrices } from "./portfolio-store.js";
import { readOpenEscalations } from "./inbox-escalations.js";
import { readAwaitingRejected } from "./inbox-rejected.js";
import { shouldSkipReanalysis } from "./utils/cooldown.js";
import { checkMarketSession } from "./utils/market-session.js";
import { volumeMismatches } from "./utils/lots-check.js";
import { detectStopBreaches } from "./utils/stop-breach.js";
import { positionsWithoutStop } from "./utils/stop.js";
import { detectTightStops, fetchAtrForPositions } from "./utils/atr-stop.js";
import { recordDecision } from "./decision.js";
import { dropStopProposals } from "./stop-proposals.js";
import type { StopProposal } from "./utils/stop-proposals.js";
import { attachStrength } from "./utils/strength.js";
import { fetchBenchmarks } from "./utils/benchmark.js";
import { describeSetup } from "./utils/setups/index.js";
import { scanSetups } from "./utils/setups/scan.js";
import { digestKeys, onlyNew, renderHeartbeatDigest, type HeartbeatDigest } from "./utils/heartbeat-digest.js";
import type { IMarketDataProvider } from "./providers/types.js";
import type { IAnalystProvider } from "./analyst/types.js";
import type { Currency, PortfolioSnapshot, Signal } from "./types.js";

export interface HeartbeatDeps {
  provider: IMarketDataProvider;
  analyst: IAnalystProvider;
  /** Headlines for the reasoner; injectable so tests stay off the network. */
  headlines?: (ticker: string) => Promise<string[]>;
  /**
   * Date of the last market tick, for the holiday guard. Yahoo's by default;
   * without it (another provider) the guard does nothing.
   */
  lastMarketDate?: (ticker: string) => Promise<Date | null>;
  /** The volume-against-lots check; injectable so a test can make it throw. */
  lotsCheck?: (portfolio: PortfolioSnapshot) => string[];
}

/** The configuration files the heartbeat reads: the rules version of the setups it records, and the reasoner's instructions. */
const HEARTBEAT_CONFIGURATION: readonly ConfigurationFile[] = ["strategies/base.md", "routines/execution-analysis.md"];

export async function runHeartbeat(currency: Currency, deps: HeartbeatDeps): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const digest: HeartbeatDigest = {
    currency,
    syncedAt: "",
    minAtr: config.strategy.stopMinAtr,
    breaches: [],
    lotsWarnings: [],
    tickerWarnings: [],
    unreadableCells: [],
    noStop: [],
    rejectedBatches: [],
    pendingEscalations: [],
    storeProblem: null,
    configurationProblems: [],
    staleness: null,
    snapshot: null,
    tightStops: [],
    armed: [],
    escalated: [],
  };
  // What was gathered goes out even if the run fails halfway: the crossed stop
  // is detected before any call that can throw and must not be lost to a later
  // error (a provider down, the reasoner). The original error is what turns
  // the run red; if sending also fails, it is only logged.
  try {
    await collect(currency, today, deps, digest);
  } catch (err) {
    await sendDigest(digest, today).catch((mailErr) => {
      console.error("[finance-agent] The summary email did not go out either:", mailErr);
    });
    throw err;
  }
  await sendDigest(digest, today);
}

/** Sends what is new in the digest and marks it as sent, only if the email went out. */
async function sendDigest(digest: HeartbeatDigest, today: string): Promise<void> {
  const sent = await readHeartbeatSent(digest.currency, today);
  const fresh = onlyNew(digest, sent);
  const email = renderHeartbeatDigest(fresh);
  if (!email) return;
  if (await sendSummaryEmail(email.subject, email.body)) {
    await writeHeartbeatSent(digest.currency, today, [...sent, ...digestKeys(fresh)]);
  }
}

async function collect(currency: Currency, today: string, deps: HeartbeatDeps, digest: HeartbeatDigest): Promise<void> {
  const {
    provider,
    analyst,
    headlines = fetchHeadlines,
    lastMarketDate = provider instanceof YahooFinanceProvider
      ? (t: string) => provider.fetchLastMarketDate(t)
      : undefined,
    lotsCheck = volumeMismatches,
  } = deps;

  // 1. Read the portfolio state (updated by hand from the broker).
  //    A state file that does not read never stops risk watch (ADR-0015, #139): the run goes on over the last state that
  //    did read and names the corruption in the digest.
  const { portfolio, lotsProblem, skippedRows, unreadableCells, staleness, storeProblem } = await readPortfolio(
    currency,
    { lastReadable: true },
  );
  digest.syncedAt = portfolio.syncedAt;
  if (storeProblem !== undefined) {
    digest.storeProblem = storeProblem;
    console.warn(`[finance-agent] WARNING, state: ${storeProblem}; watching the last state that read`);
  }
  // How stale the silo is and what its latest snapshot of the broker found (#138).
  digest.staleness = staleness;
  digest.snapshot = portfolio.reconciled
    ? {
        date: portfolio.reconciled.date,
        differences: portfolio.reconciled.differences,
        recordedToday: portfolio.reconciled.recordedOn === today,
      }
    : null;
  // The configuration files this run reads (#142): a valid one is saved as the last valid version, an invalid one is named in
  // the digest and the run goes on over its last valid version. With none yet (the first run) what needs the file refuses, but
  // only after the stops below are checked and the digest is sent. It never throws for a file: a bad edit never stops risk watch.
  digest.configurationProblems = (await resolveConfiguration(HEARTBEAT_CONFIGURATION)).problems;
  for (const line of describeProblems(digest.configurationProblems)) {
    console.warn(`[finance-agent] WARNING, configuration: ${line}`);
  }
  // A row whose ticker does not parse is skipped and reported, never a reason to stop watching the rest
  // (ADR-0015: a typo must never switch off stop alerts; ADR-0016).
  const tickerWarning = (message: string): void => {
    digest.tickerWarnings.push(message);
    console.warn(`[finance-agent] WARNING, ticker: ${message}`);
  };
  skippedRows.forEach(tickerWarning);
  // A Positions P/L or Cash cell too large to count in cents reads as unreadable (P/L 0, cash 0): the run
  // goes on and the digest names the cell (#86).
  for (const message of unreadableCells) {
    digest.unreadableCells.push(message);
    console.warn(`[finance-agent] WARNING, unreadable cell: ${message}`);
  }

  // A batch the inbox rejected and nobody answered (replaced or discarded) is named in every digest (#152). Only the
  // list of the rejected files is read, never a batch run; a folder that cannot be read is said and never stops the run:
  // the stops below must still be watched.
  digest.rejectedBatches = await readAwaitingRejected().catch((err: unknown) => {
    console.warn(`[finance-agent] WARNING, inbox/rejected: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });

  // A pending escalation no `resolve` command closed is named in every digest (#141), like a rejected batch.
  digest.pendingEscalations = await readOpenEscalations().catch((err: unknown) => {
    console.warn(`[finance-agent] WARNING, logs/pending: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });

  const checkLots = (): void => {
    digest.lotsWarnings = lotsProblem ? [lotsProblem] : lotsCheck(portfolio);
    for (const w of digest.lotsWarnings) console.warn(`[finance-agent] WARNING, Lots: ${w}`);
  };

  // 2. Load the watchlist and get market prices from the active provider.
  // The tickers to watch are the union watchlist ∪ portfolio.positions
  //: an open position is watched for risk whether or not it has
  // an entry in watchlist.md.
  const watchlist = await readWatchlistSkippingBadTickers(currency, tickerWarning);
  const tickers = collectWatchedTickers(watchlist, portfolio);
  if (tickers.length === 0) {
    console.log(`[finance-agent] No watchlist or positions for ${currency}. End of run.`);
    checkLots(); // no position, so no stop to lose to a failure of the check
    return;
  }

  const prices = await provider.getPrices(tickers);
  console.log(`[finance-agent] Prices fetched for: ${[...prices.keys()].join(", ")}`);

  // Previous session close per ticker, for the big_move trigger.
  const previousCloses = (await provider.getPreviousCloses?.(tickers)) ?? new Map<string, number>();

  // 2a. T-06: record the fetched prices as the last prices (telemetry, #133): the generated portfolio.md view shows them
  // and every read of the portfolio puts them over its positions. The state is not written: `inbox:ingest` is its only
  // writer, and the stop check below reads the state last applied and the prices just fetched.
  //
  // It goes BEFORE the session guard on purpose: if the market turns out to be
  // closed, these are the last close prices and recording them is harmless
  // (if they do not change, recordPrices rewrites nothing). The other
  // way round —aborting before writing— is how the portfolio stayed four days
  // stale in August 2026 while the runs came out green.
  await recordPrices(currency, prices);

  // 2b. Crossed-stop warning: a state question, not an analysis one — only the
  // broker account knows whether the stop filled. It goes before the session
  // guard (a close below the stop is just as urgent on a holiday) and outside
  // the escalation to the reasoner (no tokens, no cooldown wait).
  digest.breaches = detectStopBreaches(portfolio.positions, prices);
  // A position with no stop is named in every digest (#132): there is no stop for the heartbeat to watch.
  digest.noStop = positionsWithoutStop(portfolio.positions).map(({ ticker, currency }) => ({ ticker, currency }));
  if (digest.breaches.length > 0) {
    console.log(`[finance-agent] Crossed stop: ${digest.breaches.map((b) => b.ticker).join(", ")}`);
  }

  // 2b'. Volume against the lots (ADR-0015), from portfolio.md alone: each lot names its ticker, so the
  // alerting path does not read the decision log. The checks that need the log run where it is read
  // (the evaluation). Unlike them, the heartbeat never refuses the file for a
  // mismatch: a typo in Lots must not switch off the stop alerts. It keeps watching the positions and
  // says so loudly, in the log and in every digest while it lasts (they are not deduplicated). A Lots table
  // that does not read is the same: the warning replaces the volume check (no lots to compare).
  // It goes after the stop detection and has no catch of its own: if the check itself throws, the crossed
  // stops are already in the digest that the run sends before failing, so a bug here cannot hide them.
  checkLots();

  // 2c. T-09: detect holidays by the age of the last market tick. It is not
  // compared with the runner date: Actions crons run late and, crossing UTC
  // midnight, perfectly valid data looked like another day's.
  // See utils/market-session.ts.
  if (lastMarketDate && prices.size > 0) {
    const refTicker = [...prices.keys()][0];
    const marketDate = await lastMarketDate(refTicker);
    const session = checkMarketSession(marketDate, new Date(), config.marketData.maxSessionAgeHours);
    if (session.stale) {
      console.log(
        `[finance-agent] Market closed — last session: ${marketDate?.toISOString()}` +
          ` (${session.ageHours.toFixed(1)}h old). End of run (holiday).`,
      );
      return;
    }
  }

  // 2d. Stop hygiene: a stop closer than STOP_MIN_ATR to the price
  // is within the asset's normal noise — a bad session will hit it, not a
  // broken thesis (see utils/atr-stop.ts).
  //
  // It goes after the session guard —on a holiday there is no new price to
  // check, and no history is downloaded— and outside the escalation to the
  // reasoner: it is a sizing review, not a market signal. Best-effort: without
  // ATR, the position is simply not evaluated (see fetchAtrForPositions).
  const atrByTicker = await fetchAtrForPositions(portfolio.positions, provider);
  digest.tightStops = detectTightStops(portfolio.positions, prices, atrByTicker, config.strategy.stopMinAtr);
  if (digest.tightStops.length > 0) {
    console.log(
      `[finance-agent] Tight stop (< ${config.strategy.stopMinAtr} ATR): ` +
        digest.tightStops.map((t) => `${t.ticker} ${t.multiple.toFixed(1)} ATR`).join(", "),
    );
  }

  // 3. Silo benchmark with its regime: used by setup
  // eligibility and the record of each decision. Best-effort.
  const benchmark = (await fetchBenchmarks(provider, [currency]))[currency];

  // 3a. Candidates' entry setups (ADR-0013): the only way the
  // system proposes a buy. Blocked ones and armed breakouts are recorded
  // here; buyable ones go on as `setup` signals.
  const history = await readDecisions();
  const setupScan = await scanSetups({
    watchlist,
    portfolio,
    prices,
    benchmark,
    provider,
    date: today,
    rulesVersion: await readRulesVersion(),
    history,
  });
  for (const n of setupScan.notices) console.log(`[finance-agent] Setup: ${describeSetup(n)}`);
  // A run repeated the same day (manual retry) does not duplicate the log.
  await appendDecisions(
    setupScan.decisions.filter(
      (d) =>
        !history.some(
          (h) =>
            h.date === d.date && h.ticker === d.ticker && h.type === d.type && h.setup?.pattern === d.setup?.pattern,
        ),
    ),
  );
  digest.armed = setupScan.notices.filter((n) => n.setup.state === "armed");

  // 3b. Cheap risk filter (no LLM), merged with the setups: a candidate with
  // a setup and a big_move on the same day is a single signal.
  const signals = mergeSignals(
    evaluateSignals(watchlist, portfolio, prices, config.strategy.stopProximityPct, previousCloses),
    setupScan.signals,
  );

  if (signals.length === 0) {
    console.log("[finance-agent] No signals. End of run (no API cost).");
    return;
  }

  console.log(`[finance-agent] Signals detected: ${signals.map((s) => s.ticker).join(", ")}`);

  // 3c. Technical strength of the tickers with a signal, which travels with
  // the decision to its Markdown log and the decision log (ADR-0006). It does not block
  // the run if it fails.
  await attachStrength(signals, provider);
  for (const signal of signals) signal.benchmark = benchmark;

  // 4. Escalate each new signal to Claude.
  // logFiles is listed once and reused for all the run's signals.
  const logFiles = await listLogFiles();
  // The stops the reasoner proposes leave as one batch in inbox/ (#136), also when a later signal fails: the proposal
  // is already in the decision log and in an email. The heartbeat never writes the state for a stop.
  const stopProposals: StopProposal[] = [];
  try {
    for (const signal of signals) {
      const lastLog = await getLastLogForTicker(signal.ticker, logFiles);
      if (
        shouldSkipReanalysis({
          currentTriggers: signal.triggers,
          currentPrice: signal.price,
          lastLog,
          reanalysisPriceDeltaPct: config.strategy.reanalysisPriceDeltaPct,
        })
      ) {
        console.log(
          `[finance-agent] ${signal.ticker}: cooldown active (same trigger, no relevant price change), skipping.`,
        );
        continue;
      }

      // T-04: fetch recent headlines as extra context (non-blocking).
      const result = await analyst.escalate(signal, await headlines(signal.ticker));
      if (result.status === "deferred") {
        // The BUY/SELL alert arrives when the Routine resolves it; here only an informational line.
        console.log(`[finance-agent] ${signal.ticker}: escalation deferred (${result.pendingPath}).`);
        digest.escalated.push(signal);
        continue;
      }

      // Deterministic guardrail + recording: checks financial consistency before
      // alerting (shared with pending.ts — see decision.ts).
      const proposal = await recordDecision(result.recommendation, signal, { logPrefix: "[finance-agent] " });
      if (proposal) stopProposals.push(proposal);
    }
  } finally {
    const { dropped, waiting } = await dropStopProposals(stopProposals, `heartbeat-${currency.toLowerCase()}`);
    digest.stopProposed = dropped.length + waiting.length > 0;
  }
}

/** Merges each setup signal into the same ticker's risk signal, or adds it as new. */
function mergeSignals(risk: Signal[], setups: Signal[]): Signal[] {
  const merged = [...risk];
  for (const s of setups) {
    const same = merged.find((r) => r.ticker === s.ticker);
    if (same)
      Object.assign(same, {
        triggers: [...same.triggers, ...s.triggers],
        price: s.price,
        setup: s.setup,
        strength: s.strength,
        conviction: s.conviction,
      });
    else merged.push(s);
  }
  return merged;
}
