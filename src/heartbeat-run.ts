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
import { YahooFinanceProvider } from "./providers/yahoo-finance.js";
import { fetchHeadlines } from "./providers/news-provider.js";
import {
  appendDecisions,
  getLastLogForTicker,
  listLogFiles,
  readDecisions,
  readHeartbeatSent,
  readPortfolioTolerantOfLots,
  readRulesVersion,
  readWatchlist,
  updatePortfolioPrices,
  writeHeartbeatSent,
} from "./vault-io.js";
import { shouldSkipReanalysis } from "./utils/cooldown.js";
import { checkMarketSession } from "./utils/market-session.js";
import { volumeMismatches } from "./utils/lots-check.js";
import { portfolioWhere } from "./utils/vault-parser.js";
import { detectStopBreaches } from "./utils/stop-breach.js";
import { detectTightStops, fetchAtrForPositions } from "./utils/atr-stop.js";
import { recordDecision } from "./decision.js";
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
}

export async function runHeartbeat(currency: Currency, deps: HeartbeatDeps): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const digest: HeartbeatDigest = {
    currency,
    syncedAt: "",
    minAtr: config.strategy.stopMinAtr,
    breaches: [],
    lotsWarnings: [],
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
  } = deps;

  // 1. Read the portfolio state (updated by hand from the broker).
  const { portfolio, lotsProblem } = await readPortfolioTolerantOfLots(currency);
  digest.syncedAt = portfolio.syncedAt;

  // 1a. Volume against the lots (ADR-0015), from portfolio.md alone: each lot names its ticker, so the
  // alerting path does not read the decision log. The checks that need the log run where it is read
  // (decision:record and the evaluation). Unlike them, the heartbeat never refuses the file for a
  // mismatch: a typo in Lots must not switch off the stop alerts. It keeps watching the positions and
  // says so loudly, in the log and in every digest while it lasts (they are not deduplicated). A Lots table
  // that does not read is the same: the warning replaces the volume check (no lots to compare), and nothing
  // the check itself throws can stop what follows.
  digest.lotsWarnings = lotsWarnings(portfolio, lotsProblem);
  for (const w of digest.lotsWarnings) console.warn(`[finance-agent] WARNING, Lots: ${w}`);

  // 2. Load the watchlist and get market prices from the active provider.
  // The tickers to watch are the union watchlist ∪ portfolio.positions
  //: an open position is watched for risk whether or not it has
  // an entry in watchlist.md.
  const watchlist = await readWatchlist(currency);
  const tickers = collectWatchedTickers(watchlist, portfolio);
  if (tickers.length === 0) {
    console.log(`[finance-agent] No watchlist or positions for ${currency}. End of run.`);
    return;
  }

  const prices = await provider.getPrices(tickers);
  console.log(`[finance-agent] Prices fetched for: ${[...prices.keys()].join(", ")}`);

  // Previous session close per ticker, for the big_move trigger.
  const previousCloses = (await provider.getPreviousCloses?.(tickers)) ?? new Map<string, number>();

  // 2a. T-06: update Current price and P/L in portfolio.md with the fetched
  // prices. The T-02 auto-commit persists the change.
  //
  // It goes BEFORE the session guard on purpose: if the market turns out to be
  // closed, these are the last close prices and refreshing them is harmless
  // (if they do not change, updatePortfolioPrices rewrites nothing). The other
  // way round —aborting before writing— is how the portfolio stayed four days
  // stale in August 2026 while the runs came out green.
  await updatePortfolioPrices(currency, prices);

  // 2b. Crossed-stop warning: a state question, not an analysis one — only the
  // broker account knows whether the stop filled. It goes before the session
  // guard (a close below the stop is just as urgent on a holiday) and outside
  // the escalation to the reasoner (no tokens, no cooldown wait).
  digest.breaches = detectStopBreaches(portfolio.positions, prices);
  if (digest.breaches.length > 0) {
    console.log(`[finance-agent] Crossed stop: ${digest.breaches.map((b) => b.ticker).join(", ")}`);
  }

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
    await recordDecision(result.recommendation, signal, { logPrefix: "[finance-agent] " });
  }
}

/** The lots warnings of the run: the lots that do not read, else the volume check; never a throw. */
function lotsWarnings(portfolio: PortfolioSnapshot, lotsProblem: string | null): string[] {
  if (lotsProblem) return [lotsProblem];
  try {
    return volumeMismatches(portfolio);
  } catch (err) {
    return [`${portfolioWhere(portfolio.currency)}: the lots check failed: ${(err as Error).message}`];
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
