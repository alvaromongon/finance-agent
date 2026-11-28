// Decision recording, two ways:
//
// 1. `recordDecision`: outcome of a Recommendation already type-validated
//    (validateRecommendation). It computes the engine ticket —stop, size and
//    R:R— with its rules and arithmetic, writes the Markdown log,
//    appends the line to the decision log and, if the ticket is
//    not blocked, sends the alert.
//    Shared by index.ts ("api" backend) and pending.ts ("handoff" backend), so
//    both produce exactly the same for the same Recommendation.
// 2. `recordOwnerDecision` (`npm run decision:record`): the owner's stop adjustments, so nobody edits the JSONL by hand. Everything that moves the portfolio goes only through the inbox (ADR-0018, #152, #197).
import { appendDecisions, readDecisionHistory, readDecisions, readRulesVersion, writeDecisionLog } from "./vault-io.js";
import { blockCodes, evaluateRecommendation } from "./utils/sizing.js";
import { sendAlert } from "./mailer.js";
import { YahooFinanceProvider } from "./providers/yahoo-finance.js";
import {
  benchmarkFields,
  buildDecision,
  decisionFromRecommendation,
  findRelatedProposal,
  originOf,
  twoMonthRuleWarning,
  validateOwnerInput,
  type Decision,
} from "./decisions.js";
import { benchmarkOnDate, type PriceSource } from "./utils/benchmark.js";
import { readAccountEnv } from "./portfolio-store.js";
import type { Recommendation, Signal } from "./types.js";
import { tickerFileStem } from "./ticker.js";
import type { StopProposal } from "./utils/stop-proposals.js";

export interface RecordDecisionOptions {
  /** Tells in the console which backend recorded the decision, with a trailing space ("[pending] "). */
  logPrefix?: string;
  /**
   * Signal detection date, YYYY-MM-DD. `pending:record` passes it because it
   * may resolve days later: price, strength and benchmark are from that day,
   * and the decision carries its date. Today by default.
   */
  detectedOn?: string;
}

/**
 * Records the decision and returns the stop it proposes, if it proposes one: an `ADJUST_STOP` the engine did not block.
 * The caller drops it in `inbox/` as a `set_stop` (`dropStopProposals`, #136); this never writes the state for it.
 */
export async function recordDecision(
  rec: Recommendation,
  signal: Signal,
  { logPrefix = "", detectedOn }: RecordDecisionOptions = {},
): Promise<StopProposal | null> {
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
    return null;
  }

  await writeDecisionLog(rec, logOpts);
  // The decision log goes before the email: the decision exists even if
  // delivery fails (with MAIL_REQUIRE_DELIVERY the failure aborts the run).
  if (decision) await appendDecisions([decision]);
  await sendAlert(rec, evaluation.ticket, notes, signal.conviction);
  console.log(
    `${logPrefix}${signal.ticker}: ${rec.action}${signal.conviction ? ` (${signal.conviction.conviction})` : ""}`,
  );
  const ticket = evaluation.ticket;
  return ticket?.kind === "ADJUST_STOP" ? { ticker: rec.ticker, currency: ticket.currency, stop: ticket.stop } : null;
}

/** Provider `recordOwnerDecision` needs: the benchmark price on the date. */
export type OwnerDecisionProvider = PriceSource;

/**
 * Records what the owner narrates that is not told through the inbox: a stop adjustment, one line of the log. Everything
 * that moves the portfolio (a buy, a sale, a deposit, a withdrawal, a conversion, a split) is told to the engine only
 * through the inbox (`inbox/`, ADR-0018), which keeps the lots and the cash and writes the lines of the log as telemetry:
 * `validateOwnerInput` refuses them here. The engine fills in what the owner need not know: id, rules version, silo
 * benchmark and the system proposal an adjustment comes from (which decides the origin, ADR-0009 §8). Returns the
 * decisions recorded (one).
 */
export async function recordOwnerDecision(
  raw: unknown,
  provider: OwnerDecisionProvider = new YahooFinanceProvider(),
  today = new Date().toISOString().slice(0, 10),
): Promise<Decision[]> {
  const input = validateOwnerInput(raw);
  // The whole history, not the live log: a proposal an adjustment cites may sit in an archived quarter, and
  // reading it once keeps a corrupt line to one warning.
  const history = await readDecisionHistory();
  const date = input.date ?? today;
  const [rulesVersion, benchmark] = await Promise.all([
    readRulesVersion(),
    benchmarkOnDate(provider, input.currency, date, today),
  ]);

  const byId = (id: string | undefined) => (id ? history.find((d) => d.id === id) : undefined);
  const explicit = byId(input.related_id);
  if (input.related_id && !explicit) {
    throw new Error(`related_id ${input.related_id} does not exist in logs/decisions.jsonl`);
  }

  const ticker = input.ticker!;
  const proposal = explicit ?? findRelatedProposal(history, { ticker, date, types: ["adjust_stop"] });
  const decisions = [
    buildDecision({
      date,
      currency: input.currency,
      source: "portfolio-sync",
      ...benchmarkFields(benchmark),
      rules_version: rulesVersion,
      type: "adjust_stop",
      ticker,
      origin: input.origin ?? originOf(proposal),
      price: input.price,
      stop: input.stop,
      related_id: proposal?.id,
    }),
  ];
  await appendDecisions(decisions);
  return decisions;
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
