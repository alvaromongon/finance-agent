// Entry setups (ADR-0013): the only way the system proposes a buy.
//
// The detectors try every pattern on each candidate, so nobody has to classify
// the entry type beforehand. Each setup comes out with its level and its
// target; the engine adds stop and size and runs it through eligibility
// (ADR-0010 and regime). Pure functions: the caller supplies the network.
import { messages, type Messages } from "../../i18n/index.js";
import { config } from "../../config.js";
import { validateTicket } from "../../risk.js";
import { evaluateEntryEligibility, type EntryEligibility } from "../entry-eligibility.js";
import { round2 } from "../round.js";
import { buildBuyTicket, fmtUnits } from "../sizing.js";
import { computeTechnicals, type Technicals } from "../technicals.js";
import { detectBreakout, type BreakoutParams } from "./breakout.js";
import { detectPullback, type PullbackParams } from "./pullback.js";
import type { HistoricalBar } from "../../providers/types.js";
import type { BuyTicket, Currency, MarketRegime, Setup, WatchlistEntry } from "../../types.js";

export interface SetupParams {
  pullback: PullbackParams;
  breakout: BreakoutParams;
}

/** Setups current on the last session of `bars`. */
export function detectSetups(bars: readonly HistoricalBar[], params: SetupParams = config.framework.setups): Setup[] {
  return [detectPullback(bars, params.pullback), detectBreakout(bars, params.breakout)].filter(
    (s): s is Setup => s != null,
  );
}

/**
 * Setups appearing on the last session: those current today that were not
 * yesterday with the same pattern and state. It is what the heartbeat reports
 * and records, so a confirmed pullback or an armed base is not repeated daily.
 */
export function detectNewSetups(
  bars: readonly HistoricalBar[],
  params: SetupParams = config.framework.setups,
): Setup[] {
  const before = detectSetups(bars.slice(0, -1), params);
  return detectSetups(bars, params).filter((s) => !before.some((b) => b.pattern === s.pattern && b.state === s.state));
}

export interface SetupContext {
  entry: WatchlistEntry;
  bars: readonly HistoricalBar[];
  regime?: MarketRegime;
  cash: number;
  siloValue: number;
}

export interface SetupEvaluation {
  ticker: string;
  currency: Currency;
  setup: Setup;
  /** Technicals at the last session's close. */
  technicals: Technicals;
  eligibility: EntryEligibility;
  /** Engine ticket with the entry at the setup level and the target at the pattern's. */
  ticket: BuyTicket | null;
  /** Eligibility, framework rules and arithmetic; empty if it can be bought. */
  reasons: string[];
}

/**
 * Runs a setup through eligibility and the engine ticket. The entry is the
 * setup level (the confirmation close or the Buy Stop's) and the target is the
 * pattern's, which is also the only level anchoring it.
 */
export function evaluateSetup(setup: Setup, ctx: SetupContext): SetupEvaluation {
  const { entry, bars } = ctx;
  const technicals = computeTechnicals(bars as HistoricalBar[], bars[bars.length - 1].close);
  const eligibility = evaluateEntryEligibility(technicals, ctx.regime);
  const built = buildBuyTicket({
    ticker: entry.ticker,
    currency: entry.currency,
    entry: setup.level,
    atr: technicals.atr14,
    horizon: entry.horizon,
    cash: ctx.cash,
    siloValue: ctx.siloValue,
    assetClass: entry.asset_class,
    target: setup.target,
    levels: [setup.target],
  });
  const arithmetic = built.ticket ? validateTicket(built.ticket, { cash: ctx.cash }).errors.map((e) => e.code) : [];
  return {
    ticker: entry.ticker,
    currency: entry.currency,
    setup,
    technicals,
    eligibility,
    ticket: built.ticket,
    reasons: [...new Set([...eligibility.reasons, ...built.reasons, ...arithmetic])],
  };
}

/** One line per setup for emails and prompts. */
export function describeSetup(ev: SetupEvaluation, m: Messages = messages()): string {
  const { setup, ticket, currency: cur } = ev;
  const t = m.setup;
  const head = (setup.state === "armed" ? t.armed : t.confirmed)(
    ev.ticker,
    t.patterns[setup.pattern],
    setup.level,
    cur,
    setup.target,
  );
  const sizing = ticket
    ? t.sizing(ticket.stop, fmtUnits(ticket.units), ticket.amount.toFixed(2), cur, ticket.rrNet.toFixed(2))
    : "";
  const dist = ev.eligibility.sma50DistanceAtr;
  const metrics = dist != null ? t.sma50Distance(round2(dist)) : "";
  const verdict = ev.reasons.length === 0 ? t.eligible : t.blocked(ev.reasons.join(", "));
  return `${head}${sizing}${metrics} — ${verdict}`;
}
