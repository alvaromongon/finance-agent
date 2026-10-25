// Monday Briefing decisions and tickets.
//
// The briefing report is Markdown to read, but its proposals must be
// measurable. So the reasoner repeats them as JSON on the `PROPOSALS:` line of
// AUTOMATED_ACTIONS, and finalize crosses them with the vault state and the
// technicals at that moment. The engine computes stop and amount, and
// the report comes out with an engine tickets section.
//
// The briefing proposes no buys: the only way in is the
// heartbeat setups (ADR-0013). What is left here is the open positions: sell,
// adjust the stop or, if nothing is proposed, `hold`.
//
// Pure functions: monday-briefing.ts supplies the network (technicals, benchmark).
import { messages, type Messages } from "../i18n/index.js";
import { asHorizon, benchmarkFields, buildDecision, strengthFields, type Decision } from "../decisions.js";
import { validateTicket } from "../risk.js";
import { buildAdjustStopTicket, buildSellTicket, describeTicket } from "./sizing.js";
import { snapshotFromTechnicals } from "./strength.js";
import { type Technicals } from "./technicals.js";
import { CONVICTIONS } from "../types.js";
import type { Benchmark, Conviction, Currency, EngineTicket, Horizon, Position, WatchlistEntry } from "../types.js";
import { checkTicker, parseTicker, type Ticker } from "../ticker.js";

export const PROPOSAL_ACTIONS = ["SELL", "ADJUST_STOP"] as const;
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

/** An actionable proposal from the position health section. */
export interface BriefingProposal {
  ticker: Ticker;
  action: ProposalAction;
  conviction: Conviction;
  horizon?: Horizon;
  /** SELL: amount to sell; the whole position by default. */
  amount?: number;
}

const KNOWN_PROPOSAL_FIELDS = new Set(["ticker", "action", "conviction", "horizon", "amount"]);

/**
 * Reads the `PROPOSALS:` line of AUTOMATED_ACTIONS. Returns `null` if missing
 * and throws if the JSON or any proposal is invalid: in both cases finalize
 * rejects the report before writing anything. An empty `PROPOSALS:` equals `[]`.
 */
export function extractProposals(report: string): BriefingProposal[] | null {
  const section = report.split(/^##\s+AUTOMATED_ACTIONS\s*$/m)[1];
  if (section == null) return null;
  const match = /^PROPOSALS:[ \t]*(.*)$/m.exec(section);
  if (!match) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(match[1].trim() || "[]");
  } catch (err) {
    throw new Error(`PROPOSALS is not valid single-line JSON: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  return validateProposals(raw);
}

/** Validates the proposals array; collects every problem into a single error. */
export function validateProposals(raw: unknown): BriefingProposal[] {
  if (!Array.isArray(raw)) throw new Error("PROPOSALS must be an array JSON");
  const errors: string[] = [];
  const seen = new Set<string>();

  raw.forEach((p, i) => {
    const at = `PROPOSALS[${i}]`;
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      errors.push(`${at} is not an object`);
      return;
    }
    const o = p as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      if (!KNOWN_PROPOSAL_FIELDS.has(key)) errors.push(`${at}.${key} is not a PROPOSALS field`);
    }
    const ticker = checkTicker(o.ticker);
    if ("problem" in ticker) errors.push(`${at}.ticker: ${ticker.problem}`);
    else if (seen.has(ticker.ticker)) errors.push(`${at}: ${ticker.ticker} appears twice`);
    else seen.add(ticker.ticker);
    if (o.action === "BUY") {
      errors.push(`${at}: the briefing proposes no buys; the only way in is the heartbeat setups (ADR-0013)`);
    } else if (!PROPOSAL_ACTIONS.includes(o.action as ProposalAction)) {
      errors.push(`${at}.action must be one of [${PROPOSAL_ACTIONS.join(", ")}]; got: ${JSON.stringify(o.action)}`);
    }
    if (!CONVICTIONS.includes(o.conviction as Conviction)) {
      errors.push(`${at}.conviction must be one of [${CONVICTIONS.join(", ")}]; got: ${JSON.stringify(o.conviction)}`);
    }
    if (o.horizon != null && asHorizon(o.horizon) == null) {
      errors.push(`${at}.horizon must be short or medium; got: ${JSON.stringify(o.horizon)}`);
    }
    if (o.amount != null && (typeof o.amount !== "number" || !Number.isFinite(o.amount) || o.amount <= 0)) {
      errors.push(`${at}.amount must be a number > 0; got: ${JSON.stringify(o.amount)}`);
    }
  });

  if (errors.length > 0) throw new Error(`Invalid PROPOSALS:\n- ${errors.join("\n- ")}`);
  return (raw as BriefingProposal[]).map((p) => ({ ...p, ticker: parseTicker(p.ticker) }));
}

/** Price and technicals of a ticker at finalize time. */
export interface TickerSnapshot {
  price: number;
  technicals: Technicals;
}

export interface BriefingDecisionsInput {
  date: string;
  rulesVersion: string;
  logLink: string;
  proposals: BriefingProposal[];
  /** Watchlist of both silos, for each position's horizon. */
  watchlist: WatchlistEntry[];
  positions: Position[];
  snapshots: ReadonlyMap<Ticker, TickerSnapshot>;
  /** Each silo's benchmark with its regime, which goes to each decision. */
  benchmarks: Partial<Record<Currency, Benchmark>>;
}

/** Engine ticket for a proposal, with its block reasons. */
export interface BriefingTicket {
  ticker: Ticker;
  action: ProposalAction;
  ticket: EngineTicket | null;
  codes: string[];
}

/**
 * Turns the briefing into decisions and tickets. The warnings are proposals
 * that cannot be recorded (SELL or ADJUST_STOP without a position): reasoner
 * errors, not decisions.
 */
export function buildBriefingDecisions(input: BriefingDecisionsInput): {
  decisions: Decision[];
  tickets: BriefingTicket[];
  warnings: string[];
} {
  const decisions: Decision[] = [];
  const tickets: BriefingTicket[] = [];
  const warnings: string[] = [];
  const entryByTicker = new Map(input.watchlist.map((e) => [e.ticker, e]));
  const positionByTicker = new Map(input.positions.map((p) => [p.ticker, p]));
  // Tickers that already have a decision recorded from their proposal.
  const decided = new Set<string>();

  const common = (ticker: Ticker, currency: Currency, price: number | undefined) => {
    const snapshot = input.snapshots.get(ticker);
    return {
      date: input.date,
      ticker,
      currency,
      origin: "sistema" as const,
      source: "monday-briefing" as const,
      price,
      ...benchmarkFields(input.benchmarks[currency]),
      ...strengthFields(snapshot ? snapshotFromTechnicals(snapshot.technicals) : undefined),
      rules_version: input.rulesVersion,
      log_link: input.logLink,
    };
  };

  for (const proposal of input.proposals) {
    const { ticker } = proposal;
    const position = positionByTicker.get(ticker);
    if (!position) {
      warnings.push(`${ticker}: ${proposal.action} without an open position in portfolio.md, not recorded`);
      continue;
    }
    const { currency } = position;
    const entry = entryByTicker.get(ticker);
    const snapshot = input.snapshots.get(ticker);
    const price = snapshot?.price ?? position.currentPrice;
    const horizon = asHorizon(proposal.horizon ?? entry?.horizon) ?? "medium";
    const base = { ...common(ticker, currency, price), conviction: proposal.conviction, horizon };

    if (proposal.action === "SELL") {
      const ticket = buildSellTicket(proposal.amount ?? position.volume * price, price, currency);
      // A sale uses no cash: it is only checked against the position.
      const codes = validateTicket(ticket, { cash: 0, position }).errors.map((e) => e.code);
      tickets.push({ ticker, action: "SELL", ticket, codes });
      if (codes.length === 0) {
        decisions.push(buildDecision({ ...base, type: "sell", amount: ticket.amount }));
        decided.add(ticker);
      }
      continue;
    }

    // ADJUST_STOP: ATR trailing computed by the engine; it never goes down.
    const { ticket, reasons } = buildAdjustStopTicket({
      price,
      atr: snapshot?.technicals.atr14,
      currentStop: position.stopLoss,
      horizon,
      currency,
    });
    tickets.push({ ticker, action: "ADJUST_STOP", ticket, codes: reasons });
    if (ticket) {
      decisions.push(buildDecision({ ...base, type: "adjust_stop", stop: ticket.stop }));
      decided.add(ticker);
    }
  }

  // What was not proposed (or could not be carried out): hold each position.
  for (const position of input.positions) {
    if (decided.has(position.ticker)) continue;
    const price = input.snapshots.get(position.ticker)?.price ?? position.currentPrice;
    decisions.push(
      buildDecision({
        ...common(position.ticker, position.currency, price),
        type: "hold",
        horizon: asHorizon(entryByTicker.get(position.ticker)?.horizon),
      }),
    );
  }

  return { decisions, tickets, warnings };
}

/**
 * Engine tickets section finalize adds to the briefing log and email. Empty
 * string if there were no proposals.
 */
export function formatEngineTicketsSection(tickets: readonly BriefingTicket[], m: Messages = messages()): string {
  if (tickets.length === 0) return "";
  const b = m.briefing;
  const lines = [b.ticketsTitle, "", b.ticketsNote];
  for (const t of tickets) {
    const verdict = t.codes.length === 0 ? b.proposed : b.blocked(t.codes.join(", "));
    lines.push("", `### ${t.action} ${t.ticker} — ${verdict}`, "");
    if (t.ticket) {
      lines.push(...b.ticketHeader, ...describeTicket(t.ticket, m).map(([field, value]) => `| ${field} | ${value} |`));
    } else {
      lines.push(b.noTicket);
    }
  }
  return lines.join("\n");
}
