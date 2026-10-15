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
  readDecisions,
  readPortfolio,
  readRulesVersion,
  readWatchlist,
  writeDecisionLog,
} from "./vault-io.js";
import { blockCodes, evaluateRecommendation } from "./utils/sizing.js";
import { sendAlert } from "./mailer.js";
import { YahooFinanceProvider } from "./providers/yahoo-finance.js";
import {
  benchmarkFields,
  buildDecision,
  decisionFromRecommendation,
  entryRuleViolations,
  findOpenEntry,
  findRelatedProposal,
  originOf,
  resolveFxConversion,
  twoMonthRuleWarning,
  validateOwnerInput,
  type Decision,
  type DecisionOrigin,
} from "./decisions.js";
import { benchmarkOnDate, type PriceSource } from "./utils/benchmark.js";
import { round2 } from "./utils/round.js";
import { atr14d } from "./utils/technicals.js";
import type { Currency, Recommendation, Signal } from "./types.js";

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
    logLink: `logs/${today}-${rec.ticker.toLowerCase()}.md`,
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
 */
export async function recordOwnerDecision(
  raw: unknown,
  provider: OwnerDecisionProvider = new YahooFinanceProvider(),
  today = new Date().toISOString().slice(0, 10),
): Promise<Decision> {
  const input = validateOwnerInput(raw);
  const date = input.date ?? today;
  const [rulesVersion, history, watchlist] = await Promise.all([
    readRulesVersion(),
    readDecisions(),
    readWatchlist(input.currency),
  ]);
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

  let decision: Decision;
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
      decision = buildDecision({
        ...common,
        type: "entry",
        ticker,
        origin: originFrom(proposal),
        price: input.price,
        amount: input.amount ?? round2(input.units! * input.price!),
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
      break;
    }
    case "exit": {
      const ticker = input.ticker!;
      const sellProposal = findRelatedProposal(history, { ticker, date, types: ["sell"] });
      const amount = input.amount ?? round2(input.units! * input.price!);
      decision = buildDecision({
        ...common,
        type: "exit",
        ticker,
        origin: originFrom(sellProposal),
        price: input.price,
        amount,
        costs: input.costs,
        pnl:
          input.pnl ??
          (await pnlFromPortfolio(input.currency, ticker, input.price!, input.units ?? amount / input.price!)),
        related_id: (explicit ?? findOpenEntry(history, ticker))?.id,
      });
      break;
    }
    case "adjust_stop": {
      const ticker = input.ticker!;
      const proposal = explicit ?? findRelatedProposal(history, { ticker, date, types: ["adjust_stop"] });
      decision = buildDecision({
        ...common,
        type: "adjust_stop",
        ticker,
        origin: originFrom(proposal),
        price: input.price,
        stop: input.stop,
        related_id: proposal?.id,
      });
      break;
    }
    case "fx_conversion": {
      const { costs, fx_rate } = resolveFxConversion(input, config.broker.fxConversionPct);
      decision = buildDecision({
        ...common,
        type: "fx_conversion",
        ticker: null,
        origin: "propietario",
        amount: input.amount,
        costs,
        fx_rate,
      });
      break;
    }
    case "deposit":
    case "withdrawal":
      decision = buildDecision({
        ...common,
        type: input.type,
        ticker: null,
        origin: "propietario",
        amount: input.amount,
      });
      break;
  }

  await appendDecisions([decision]);
  return decision;
}

/**
 * Result of an exit with the position's average price in portfolio.md. That
 * is why the skill records the exit before deleting the row. `undefined` if
 * the position is gone: better no data than made-up data.
 */
async function pnlFromPortfolio(
  currency: Currency,
  ticker: string,
  price: number,
  units: number,
): Promise<number | undefined> {
  const portfolio = await readPortfolio(currency).catch(() => null);
  const position = portfolio?.positions.find((p) => p.ticker === ticker);
  return position ? round2((price - position.avgPrice) * units) : undefined;
}

/** ATR14 of the asset to evaluate the stop distance. Best-effort. */
async function fetchAtr(provider: OwnerDecisionProvider, ticker: string): Promise<number | null> {
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
    .then((decision) => {
      console.log(describeOwnerDecision(decision));
      console.log(JSON.stringify(decision));
    })
    .catch((err) => {
      console.error("[decision]", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
