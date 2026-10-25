// Decision recording, two ways:
//
// 1. `recordDecision`: outcome of a Recommendation already type-validated
//    (validateRecommendation). It computes the engine ticket —stop, size and
//    R:R— with its rules and arithmetic, writes the Markdown log,
//    appends the line to the decision log and, if the ticket is
//    not blocked, sends the alert.
//    Shared by index.ts ("api" backend) and pending.ts ("handoff" backend), so
//    both produce exactly the same for the same Recommendation.
// 2. `recordOwnerDecision` (`npm run decision:record`): what the owner
//    narrates they did at their broker, so nobody edits the JSONL by hand.
import { config } from "./config.js";
import {
  appendDecisions,
  readAccountEnv,
  readDecisionHistory,
  readDecisions,
  parsePortfolioText,
  readPortfolioText,
  readRulesVersion,
  readWatchlist,
  writeDecisionLog,
  writePortfolioText,
} from "./vault-io.js";
import { blockCodes, evaluateRecommendation } from "./utils/sizing.js";
import { sendAlert } from "./mailer.js";
import { YahooFinanceProvider } from "./providers/yahoo-finance.js";
import {
  benchmarkFields,
  buildDecision,
  decisionFromRecommendation,
  entryRuleViolations,
  entryAfterExit,
  findRelatedProposal,
  originOf,
  resolveFxConversion,
  twoMonthRuleWarning,
  validateOwnerInput,
  type OwnerDecisionInput,
  type Decision,
  type DecisionOrigin,
} from "./decisions.js";
import { benchmarkOnDate, type PriceSource } from "./utils/benchmark.js";
import { assertLotsMatch } from "./utils/lots-check.js";
import { portfolioWhere } from "./utils/vault-parser.js";
import { applyLotChange, lotOfEntry, planSale, type SaleShare } from "./utils/portfolio-lots.js";
import { addMoney, exactAmount, ZERO, type Money } from "./money.js";
import { atr14d } from "./utils/technicals.js";
import type { Currency, Lot, PortfolioSnapshot, Recommendation, Signal } from "./types.js";
import { tickerFileStem, type Ticker } from "./ticker.js";

export interface RecordDecisionOptions {
  /** Tells in the console which backend recorded the decision, with a trailing space ("[pending] "). */
  logPrefix?: string;
  /**
   * Signal detection date, YYYY-MM-DD. `pending:resolve` passes it because it
   * may resolve days later: price, strength and benchmark are from that day,
   * and the decision carries its date. Today by default.
   */
  detectedOn?: string;
}

export async function recordDecision(
  rec: Recommendation,
  signal: Signal,
  { logPrefix = "", detectedOn }: RecordDecisionOptions = {},
): Promise<void> {
  // The signal sets the asset, not the reasoner: with another ticker or
  // currency the decision would get another security's price, ATR and levels.
  if (rec.ticker !== signal.ticker || rec.ticket.currency !== signal.currency) {
    throw new Error(
      `The recommendation is for ${rec.ticker} (${rec.ticket.currency}) and the signal for ${signal.ticker} (${signal.currency}): not recorded`,
    );
  }
  // Before writing anything: without a rules version there is no recordable
  // decision, and a Markdown log without its line in the decision log would
  // mean measuring halfway.
  const [rulesVersion, accountEnv, history] = await Promise.all([
    readRulesVersion(),
    readAccountEnv(),
    readDecisions(),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  const evaluation = evaluateRecommendation(rec, signal);
  const codes = blockCodes(evaluation);
  // The two-month rule looks at the buy-back day, which is today.
  const twoMonths = rec.action === "BUY" ? twoMonthRuleWarning(history, rec.ticker, today, accountEnv) : null;
  const notes = twoMonths ? [twoMonths] : [];
  for (const w of notes) console.warn(`${logPrefix}⚠ ${signal.ticker}: ${w}`);

  const decision = decisionFromRecommendation(rec, signal, {
    date: detectedOn ?? today,
    rulesVersion,
    source: "heartbeat",
    logLink: `logs/${today}-${tickerFileStem(rec.ticker)}.md`,
    blocked: evaluation.blocked,
    reasons: codes,
    ticket: evaluation.ticket,
  });
  const logOpts = {
    price: signal.price,
    strength: signal.strength,
    ticket: evaluation.ticket,
    notes,
    setup: signal.setup,
    conviction: signal.conviction,
  };

  if (evaluation.blocked) {
    // The proposal is not hidden (ADR-0009 §3): Markdown log and decision log with the reasons, no email.
    console.error(`${logPrefix}✗ ${signal.ticker}: ticket blocked — ${codes.join(", ")}`);
    for (const e of evaluation.errors) console.error(`  ${e.message}`);
    await writeDecisionLog(rec, { ...logOpts, blocked: true, reasons: codes });
    if (decision) await appendDecisions([decision]);
    return;
  }

  await writeDecisionLog(rec, logOpts);
  // The decision log goes before the email: the decision exists even if
  // delivery fails (with MAIL_REQUIRE_DELIVERY the failure aborts the run).
  if (decision) await appendDecisions([decision]);
  await sendAlert(rec, evaluation.ticket, notes, signal.conviction);
  console.log(
    `${logPrefix}${signal.ticker}: ${rec.action}${signal.conviction ? ` (${signal.conviction.conviction})` : ""}`,
  );
}

/** Provider `recordOwnerDecision` needs: benchmark price and history for the ATR. */
export type OwnerDecisionProvider = PriceSource;

/**
 * Records a trade narrated by the owner. The engine fills in what the owner
 * need not know: id, rules version, silo benchmark, rules broken against the
 * current watchlist and the system proposal it comes from (which decides the
 * origin, ADR-0009 §8).
 *
 * It also keeps the lots of the silo (ADR-0015, #42): an entry adds a lot to `portfolio.md` and
 * creates or updates its position; a sale consumes the ticker's lots first in, first out and writes
 * one `exit` per lot consumed. It appends to the log first and rewrites the portfolio second; all the
 * checks run before either is written. Returns the decisions recorded: one, except a sale that
 * spans several lots.
 */
export async function recordOwnerDecision(
  raw: unknown,
  provider: OwnerDecisionProvider = new YahooFinanceProvider(),
  today = new Date().toISOString().slice(0, 10),
): Promise<Decision[]> {
  const input = validateOwnerInput(raw);
  if (input.type === "exit" && input.related_id) {
    throw new Error("related_id does not apply to an exit: a sale consumes the lots first in, first out");
  }
  // The whole history, not the live log: the entry of an open lot may sit in an archived quarter, and
  // reading it once keeps a corrupt line to one warning.
  const history = await readDecisionHistory();
  const book = await readLotBook(input.currency, history);
  if (!book && (input.type === "entry" || input.type === "exit")) {
    throw new Error(
      `portfolio.md does not exist: ${input.type === "entry" ? "an entry needs it to keep its lot" : "a sale needs it to find its lots"} (nothing was recorded)`,
    );
  }
  const date = input.date ?? today;
  // A sale is planned, and refused if it is dated before a lot it would consume, before anything goes to
  // the network: the lots are in `portfolio.md` and the refusal needs nothing else.
  const sale = input.type === "exit" ? planOwnerSale(input, book!.portfolio.lots, history, date) : undefined;
  const [rulesVersion, watchlist] = await Promise.all([readRulesVersion(), readWatchlist(input.currency)]);
  const benchmark = await benchmarkOnDate(provider, input.currency, date, today);

  const common = {
    date,
    currency: input.currency,
    source: "portfolio-sync" as const,
    ...benchmarkFields(benchmark),
    rules_version: rulesVersion,
  };
  const byId = (id: string | undefined) => (id ? history.find((d) => d.id === id) : undefined);
  const explicit = byId(input.related_id);
  if (input.related_id && !explicit) {
    throw new Error(`related_id ${input.related_id} does not exist in logs/decisions.jsonl`);
  }
  const originFrom = (related: Decision | undefined): DecisionOrigin => input.origin ?? originOf(related);

  let decisions: Decision[];
  /** The change to the silo's lots as an edit of the `portfolio.md` text, applied to the text read last. */
  let editPortfolio: ((text: string) => string) | undefined;
  switch (input.type) {
    case "entry": {
      const ticker = input.ticker!;
      // An engine block too: buying what it blocked is an owner trade, but it
      // cites the block to measure what happens when one is skipped.
      // And an armed breakout: its Buy Stop fills without the heartbeat seeing the close.
      const proposal =
        explicit ??
        findRelatedProposal(history, { ticker, date, types: ["buy_proposal", "buy_blocked", "setup_armed"] });
      const atr = await fetchAtr(provider, ticker);
      // Units and amount are one fact (the input validation refused a contradiction): the log line, the
      // lot's `Entry units` and the evaluation read the same units.
      const units = input.units ?? input.amount! / input.price!;
      const entry = buildDecision({
        ...common,
        type: "entry",
        ticker,
        origin: originFrom(proposal),
        price: input.price,
        amount: input.amount ?? exactAmount(units * input.price!),
        units,
        costs: input.costs,
        stop_initial: input.stop,
        rule_violations: [
          ...entryRuleViolations({
            price: input.price!,
            stop: input.stop,
            entry: watchlist.find((e) => e.ticker === ticker),
            proposal,
            atr,
            minStopAtr: config.strategy.stopMinAtr,
          }),
          ...(originOf(proposal) === "propietario" && proposal?.origin === "sistema" ? ["overrode_block"] : []),
        ],
        related_id: proposal?.id,
      });
      decisions = [entry];
      const lots = [...book!.portfolio.lots, lotOfEntry(entry, units)];
      editPortfolio = (text) =>
        withLots(text, input.currency, lots, {
          ticker,
          newStopLoss: entry.stop_initial ?? null,
          currentPrice: entry.price,
        });
      break;
    }
    case "exit": {
      const ticker = input.ticker!;
      const sellProposal = findRelatedProposal(history, { ticker, date, types: ["sell"] });
      const shares = sale!;
      const origin = originFrom(sellProposal);
      decisions = shares.map((share) =>
        buildDecision({
          ...common,
          type: "exit",
          ticker,
          origin,
          price: input.price,
          amount: share.amount,
          // What this exit sold from its lot: the evaluation measures from it, not from amount / price.
          units: share.unitsSold,
          costs: share.costs,
          pnl: share.pnl,
          // The lot's, never the latest open entry's: each exit is self-contained (ADR-0015).
          related_id: share.lot.entryId,
          entry_price: share.lot.entryPrice,
          entry_units: share.lot.entryUnits,
          entry_costs: share.entryCosts,
          entry_date: share.lot.date,
          entry_origin: share.lot.origin,
          entry_rules_version: share.lot.rulesVersion,
          stop_initial: share.lot.initialStop ?? undefined,
          rule_violations: share.lot.rulesViolations,
          lot_units_left: share.unitsLeft,
        }),
      );
      const left = new Map(shares.map((share) => [share.lot.entryId, share.unitsLeft]));
      const remaining = book!.portfolio.lots
        .map((lot) => ({ ...lot, units: left.get(lot.entryId) ?? lot.units }))
        .filter((lot) => lot.units > 0);
      editPortfolio = (text) => withLots(text, input.currency, remaining, { ticker });
      break;
    }
    case "adjust_stop": {
      const ticker = input.ticker!;
      const proposal = explicit ?? findRelatedProposal(history, { ticker, date, types: ["adjust_stop"] });
      decisions = [
        buildDecision({
          ...common,
          type: "adjust_stop",
          ticker,
          origin: originFrom(proposal),
          price: input.price,
          stop: input.stop,
          related_id: proposal?.id,
        }),
      ];
      break;
    }
    case "fx_conversion": {
      const { costs, fx_rate } = resolveFxConversion(input, config.broker.fxConversionPct);
      decisions = [
        buildDecision({
          ...common,
          type: "fx_conversion",
          ticker: null,
          origin: "propietario",
          amount: input.amount,
          costs,
          fx_rate,
        }),
      ];
      break;
    }
    case "deposit":
    case "withdrawal":
      decisions = [
        buildDecision({
          ...common,
          type: input.type,
          ticker: null,
          origin: "propietario",
          amount: input.amount,
        }),
      ];
      break;
  }

  if (editPortfolio) {
    // The network calls are over: another writer of this checkout (the heartbeat's prices, the owner's
    // editor) may have written portfolio.md meanwhile. The change goes onto the text read now, not the
    // one planned on; it is tried here so a refusal comes before anything is written. If the lots
    // themselves moved, the plan is stale: refuse it.
    const latest = await readLotBook(input.currency, history);
    if (!latest || JSON.stringify(latest.portfolio.lots) !== JSON.stringify(book!.portfolio.lots)) {
      throw new Error(
        `${portfolioWhere(input.currency)}: Lots changed while the trade was being recorded (nothing was recorded); run it again`,
      );
    }
    editPortfolio(latest.text);
  }
  // Log first, portfolio second (ADR-0015): a stop in between leaves an exit whose lot did not
  // shrink, which the owner fixes by hand; the other way round would leave a lot the log cannot explain.
  await appendDecisions(decisions);
  // Read again, right before writing: only the log append lies between the checked read and this one.
  // The entry is in the log now, so whatever stops the write is reported as that, never as "nothing
  // was recorded".
  if (editPortfolio) {
    let edited: string;
    try {
      const text = await readPortfolioText();
      if (JSON.stringify(parsePortfolioText(text, input.currency).lots) !== JSON.stringify(book!.portfolio.lots)) {
        throw new Error("Lots changed meanwhile");
      }
      edited = editPortfolio(text);
    } catch (err) {
      throw new Error(
        `${portfolioWhere(input.currency)}: the decision IS recorded in the log, but portfolio.md was not updated ` +
          `(${(err as Error).message.replace(/\s*\(nothing was recorded\)/g, "")}); apply the lot change by hand (ADR-0015)`,
        { cause: err },
      );
    }
    await writePortfolioText(edited);
  }
  return decisions;
}

/** The silo's `portfolio.md` as it was read, with its lots already checked against the decision history. */
interface LotBook {
  text: string;
  portfolio: PortfolioSnapshot;
}

/**
 * Reads the silo's portfolio and refuses it if its lots do not match the decision history: a
 * `Volume` that is not the sum of its lots' units, a lot or an open entry the log does not agree
 * with (ADR-0015). `null` without a portfolio.md: nothing to check, and only a trade that keeps lots
 * needs it. An unreadable one (e.g. the previous format) is refused as everywhere else.
 */
async function readLotBook(currency: Currency, history: readonly Decision[]): Promise<LotBook | null> {
  let text: string;
  try {
    text = await readPortfolioText();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const portfolio = parsePortfolioText(text, currency);
  assertLotsMatch(portfolio, history);
  return { text, portfolio };
}

/** The portfolio text with the silo's `lots` and the position of `change.ticker` recomputed from them. */
function withLots(
  text: string,
  currency: Currency,
  lots: readonly Lot[],
  change: { ticker: Ticker; newStopLoss?: number | null; currentPrice?: number },
): string {
  const own = lots.filter((lot) => lot.ticker === change.ticker);
  const volume = own.reduce((sum, lot) => sum + lot.units, 0);
  const avgPrice = volume > 0 ? own.reduce((sum, lot) => sum + lot.units * lot.entryPrice, 0) / volume : undefined;
  return applyLotChange(text, currency, lots, { ...change, volume, avgPrice });
}

/** What the exits already written took of each lot's entry costs, by entry id. */
function entryCostsTaken(history: readonly Decision[]): Map<string, Money> {
  const taken = new Map<string, Money>();
  for (const d of history) {
    if (d.type === "exit" && d.related_id && d.entry_costs != null) {
      taken.set(d.related_id, addMoney(taken.get(d.related_id) ?? ZERO, d.entry_costs));
    }
  }
  return taken;
}

/** ATR14 of the asset to evaluate the stop distance. Best-effort. */
async function fetchAtr(provider: OwnerDecisionProvider, ticker: Ticker): Promise<number | null> {
  try {
    const bars = (await provider.getHistorical?.(ticker, "1y")) ?? [];
    return atr14d(bars);
  } catch (err) {
    console.warn(
      `[decision] ${ticker}: no ATR, the stop distance is not evaluated (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

/** Readable summary for the skill to relay to the owner. */
export function describeOwnerDecision(d: Decision): string {
  const lines = [`Recorded ${d.type}${d.ticker ? ` ${d.ticker}` : ""} (${d.currency}), origin ${d.origin}.`];
  if (d.related_id) lines.push(`Related to: ${d.related_id}`);
  if (d.rule_violations && d.rule_violations.length > 0) {
    lines.push(`Rules broken: ${d.rule_violations.join(", ")}`);
  }
  if (!d.benchmark) lines.push("No silo benchmark price for that date.");
  return lines.join("\n");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// CLI dispatch only when the file runs directly — not when index.ts,
// pending.ts or the tests import it (same pattern as pending.ts).
const isMain = process.argv[1] != null && import.meta.filename === process.argv[1];
if (isMain) {
  const [cmd] = process.argv.slice(2);
  if (cmd !== "record") {
    throw new Error("Usage: decision.ts record  (trade JSON on stdin)");
  }
  readStdin()
    .then((stdin) => recordOwnerDecision(JSON.parse(stdin)))
    .then((decisions) => {
      for (const decision of decisions) {
        console.log(describeOwnerDecision(decision));
        console.log(JSON.stringify(decision));
      }
    })
    .catch((err) => {
      console.error("[decision]", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}

/**
 * The lots a sale consumes (first in, first out). Refused, with nothing recorded, if any of them was
 * entered after the sale's date: a lot cannot be sold before it was bought (the same day is a round trip).
 */
function planOwnerSale(
  input: OwnerDecisionInput,
  lots: readonly Lot[],
  history: readonly Decision[],
  date: string,
): SaleShare[] {
  const ticker = input.ticker!;
  const amount = input.amount ?? exactAmount(input.units! * input.price!);
  const units = input.units ?? amount / input.price!;
  const shares = planSale(
    lots,
    {
      ticker,
      units,
      unitsFromAmount: input.units == null,
      price: input.price!,
      amount,
      costs: input.costs,
      pnl: input.pnl,
    },
    entryCostsTaken(history),
  );
  const later = shares.find((share) => entryAfterExit(share.lot.date, date));
  if (later) {
    throw new Error(
      `entry_date ${later.lot.date} is after the exit's date ${date}: a lot cannot be sold before it was bought (nothing was recorded)`,
    );
  }
  return shares;
}
