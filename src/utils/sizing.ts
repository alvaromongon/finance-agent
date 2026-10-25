// Engine ticket (ADR-0009 §3 and §7): stop, size by risk, R:R net
// of costs and estimated costs.
//
// The reasoner no longer proposes an amount or a stop: it proposes a target
// anchored to a technical level, and the engine does the money arithmetic
// (deterministic where money is involved, ADR-0009). So there is no tight stop left to reject
// (ADR-0011), each trade risks the same percentage of the silo and R values
// are comparable.
//
// What falls short of the framework rules is not hidden: the ticket is
// computed anyway and comes out with its block reasons, recorded as `buy_blocked`.
import { en } from "../i18n/en.js";
import { messages, type Messages } from "../i18n/index.js";
import { config } from "../config.js";
import { asHorizon } from "../decisions.js";
import { validateTicket, type OrderRules, type TicketError } from "../risk.js";
import { STOP_ATR_BY_HORIZON, suggestStop, trailingStop } from "./atr-stop.js";
import { regimeBlockReasons } from "./market-regime.js";
import { round2 } from "./round.js";
import type {
  AdjustStopTicket,
  AssetClass,
  BuyTicket,
  Currency,
  EngineTicket,
  Horizon,
  PortfolioSnapshot,
  Recommendation,
  SellTicket,
  Signal,
} from "../types.js";
import type { Ticker } from "../ticker.js";

/** Framework parameters plus what the broker accepts as an order (fractional and minimum). */
export type Framework = typeof config.framework & OrderRules;

const DEFAULT_FRAMEWORK: Framework = {
  ...config.framework,
  fractionalShares: config.broker.fractionalShares,
  minOrderValue: config.broker.minOrderValue,
};

/** Maximum distance, in ATR, between the target and the technical level anchoring it. */
export const TARGET_TOLERANCE_ATR = 0.5;

/** Decimals of fractional units. Always rounded down: the risk is never exceeded. */
export const UNIT_DECIMALS = 4;

export type BuyBlockReason = "no_atr" | "target_not_anchored" | "rr_below_min";
export type AdjustStopBlockReason = "no_atr" | "stop_not_raised";

/**
 * Silo value: total cash (including what pending orders hold) + positions at
 * market, with `prices` if given and otherwise the portfolio.md price. The
 * ticket's available-cash cap uses the available balance.
 */
export function siloValue(portfolio: PortfolioSnapshot, prices?: ReadonlyMap<string, number>): number {
  const invested = portfolio.positions.reduce(
    (sum, p) => sum + p.volume * (prices?.get(p.ticker) ?? p.currentPrice),
    0,
  );
  return round2((portfolio.totalCash ?? portfolio.cash) + invested);
}

/**
 * Transaction tax on the buy, in %, by Yahoo suffix (ADR-0009 §7). It only
 * applies to stocks: an ETF or ETC pays none. Conservative case: it is charged
 * without checking market cap, and a ticker without a class is treated as a
 * stock.
 */
export function purchaseTaxPct(
  ticker: Ticker,
  assetClass?: AssetClass,
  framework: Framework = DEFAULT_FRAMEWORK,
): number {
  if (assetClass === "etf" || assetClass === "commodity") return 0;
  const table: Record<string, number> = framework.costs.purchaseTaxPctBySuffix;
  const suffix = Object.keys(table).find((s) => ticker.endsWith(s));
  return suffix ? table[suffix] : 0;
}

export interface SizingInput {
  ticker: Ticker;
  currency: Currency;
  /** Entry price: the signal's or the briefing's. */
  entry: number;
  atr: number | null | undefined;
  horizon: Horizon;
  cash: number;
  siloValue: number;
  assetClass?: AssetClass;
}

export type BuySizing = Omit<BuyTicket, "target" | "rrGross" | "rrNet">;

/**
 * Stop and units of a buy, without a target. `null` without ATR: without the
 * volatility unit there is no stop to compute, and without a stop no size.
 */
export function sizeBuy(input: SizingInput, framework: Framework = DEFAULT_FRAMEWORK): BuySizing | null {
  const { entry, atr, horizon } = input;
  if (atr == null || !(atr > 0) || !(entry > 0)) return null;

  const stopAtr = STOP_ATR_BY_HORIZON[horizon];
  const stop = suggestStop(entry, atr, horizon);
  const perUnitRisk = entry - stop;
  if (!(perUnitRisk > 0)) return null;

  const taxPct = purchaseTaxPct(input.ticker, input.assetClass, framework);
  const riskBudget = (input.siloValue * framework.riskPerTradePct) / 100;
  const caps = {
    risk: riskBudget / perUnitRisk,
    position: (input.siloValue * framework.maxPositionPct) / 100 / entry,
    cash: Math.max(0, input.cash) / (entry * (1 + taxPct / 100)),
  };
  // On a tie risk wins: it is the rule, the caps are the exception.
  const cappedBy = (["risk", "position", "cash"] as const).reduce((a, b) => (caps[b] < caps[a] ? b : a));
  const units = floorUnits(Math.max(0, caps[cappedBy]), framework.fractionalShares);
  const amount = round2(units * entry);

  return {
    kind: "BUY",
    currency: input.currency,
    entry,
    stop,
    stopAtr,
    units,
    amount,
    costs: round2((amount * taxPct) / 100),
    taxPct,
    risk: round2(units * perUnitRisk),
    riskBudget: round2(riskBudget),
    cappedBy,
  };
}

/** R:R up to `target`, gross and net of the buy tax (ADR-0009 §2). Unrounded. */
export function rewardRisk(
  entry: number,
  stop: number,
  target: number,
  taxPct: number,
): { gross: number; net: number } {
  const perUnit = entry - stop;
  return {
    gross: (target - entry) / perUnit,
    net: (target - entry - (entry * taxPct) / 100) / perUnit,
  };
}

/** The target is above the entry and within TARGET_TOLERANCE_ATR of some level. */
export function isTargetAnchored(target: number, entry: number, levels: readonly number[], atr: number): boolean {
  return target > entry && levels.some((l) => Math.abs(target - l) <= TARGET_TOLERANCE_ATR * atr);
}

export interface BuyInput extends SizingInput {
  target: number;
  levels: readonly number[];
}

/** Full buy ticket and its block reasons (empty if it meets the framework). */
export function buildBuyTicket(
  input: BuyInput,
  framework: Framework = DEFAULT_FRAMEWORK,
): { ticket: BuyTicket | null; reasons: BuyBlockReason[] } {
  const sizing = sizeBuy(input, framework);
  if (!sizing) return { ticket: null, reasons: ["no_atr"] };

  const rr = rewardRisk(input.entry, sizing.stop, input.target, sizing.taxPct);
  const reasons: BuyBlockReason[] = [];
  if (!isTargetAnchored(input.target, input.entry, input.levels, input.atr!)) reasons.push("target_not_anchored");
  if (!(rr.net >= framework.minRewardRisk)) reasons.push("rr_below_min");

  return {
    ticket: { ...sizing, target: input.target, rrGross: round2(rr.gross), rrNet: round2(rr.net) },
    reasons,
  };
}

export function buildSellTicket(amount: number, price: number, currency: Currency): SellTicket {
  return {
    kind: "SELL",
    currency,
    price,
    amount: round2(amount),
    units: price > 0 ? floorUnits(amount / price, true) : 0,
  };
}

export function buildAdjustStopTicket(input: {
  price: number;
  atr: number | null | undefined;
  currentStop: number | null;
  horizon: Horizon;
  currency: Currency;
}): { ticket: AdjustStopTicket | null; reasons: AdjustStopBlockReason[] } {
  if (input.atr == null || !(input.atr > 0)) return { ticket: null, reasons: ["no_atr"] };
  const stop = trailingStop(input.price, input.atr, input.currentStop, input.horizon);
  if (stop == null) return { ticket: null, reasons: ["stop_not_raised"] };
  return {
    ticket: {
      kind: "ADJUST_STOP",
      currency: input.currency,
      price: input.price,
      stop,
      previousStop: input.currentStop,
      stopAtr: STOP_ATR_BY_HORIZON[input.horizon],
    },
    reasons: [],
  };
}

/** Result of turning a recommendation into an engine ticket. */
export interface TicketEvaluation {
  ticket: EngineTicket | null;
  /** Calibratable framework rules that block (ADR-0009). */
  reasons: string[];
  /** risk.ts arithmetic checks. */
  errors: TicketError[];
  blocked: boolean;
}

/**
 * Engine ticket for a reasoner recommendation: the BUY with stop, size and
 * R:R; the SELL with the proposed amount; the ADJUST_STOP with the ATR
 * trailing. The price is always the signal's.
 */
export function evaluateRecommendation(
  rec: Recommendation,
  signal: Signal,
  framework: Framework = DEFAULT_FRAMEWORK,
): TicketEvaluation {
  const horizon = asHorizon(signal.entry?.horizon) ?? "medium";
  const atr = signal.strength?.atr14;
  let ticket: EngineTicket | null = null;
  let reasons: string[] = [];

  switch (rec.action) {
    case "HOLD":
      return { ticket: null, reasons: [], errors: [], blocked: false };
    case "BUY": {
      const built = buildBuyTicket(
        {
          ticker: rec.ticker,
          currency: signal.currency,
          entry: signal.price,
          atr,
          horizon,
          cash: signal.cash,
          siloValue: signal.siloValue,
          assetClass: signal.entry?.asset_class,
          target: rec.ticket.target ?? NaN,
          levels: signal.strength?.levels ?? [],
        },
        framework,
      );
      ticket = built.ticket;
      // A single way in (ADR-0013): a BUY without a setup (e.g. after a
      // candidate's big_move) is not proposed. And adverse silo regime
      // (ADR-0010): no new entries.
      reasons = [
        ...(signal.setup ? [] : ["no_setup"]),
        ...regimeBlockReasons(signal.benchmark?.regime),
        ...built.reasons,
      ];
      break;
    }
    case "SELL":
      ticket = buildSellTicket(rec.ticket.amount ?? 0, signal.position?.currentPrice ?? signal.price, signal.currency);
      break;
    case "ADJUST_STOP": {
      const built = buildAdjustStopTicket({
        price: signal.price,
        atr,
        currentStop: signal.position?.stopLoss ?? null,
        horizon,
        currency: signal.currency,
      });
      ticket = built.ticket;
      reasons = built.reasons;
      break;
    }
  }

  const errors: TicketError[] = ticket ? validateTicket(ticket, signal, framework).errors : [];
  if (rec.action === "ADJUST_STOP" && !ticket && !signal.position) {
    errors.push({
      code: "no_position",
      message: "ADJUST_STOP recommended without an open position recorded in portfolio.md",
    });
  }
  return {
    ticket,
    reasons,
    errors,
    blocked: reasons.length > 0 || errors.length > 0,
  };
}

/** Block reasons as codes, for the Markdown log and the decision log. */
export function blockCodes(ev: Pick<TicketEvaluation, "reasons" | "errors">): string[] {
  return [...new Set([...ev.reasons, ...ev.errors.map((e) => e.code)])];
}

// ─── Presentation ────────────────────────────────────────────────────────────

/** Units with up to UNIT_DECIMALS decimals, without trailing zeros. */
export function fmtUnits(units: number): string {
  return String(Number(units.toFixed(UNIT_DECIMALS)));
}

/** Ticket rows for the log, the email and the briefing. */
export function describeTicket(ticket: EngineTicket, m: Messages = messages()): [string, string][] {
  const cur = ticket.currency;
  const t = m.ticket;
  switch (ticket.kind) {
    case "BUY":
      return [
        [t.units, fmtUnits(ticket.units)],
        [t.amount, `${ticket.amount.toFixed(2)} ${cur}`],
        [t.referencePrice, `${ticket.entry} ${cur}`],
        [t.stopLoss, `${ticket.stop} ${cur} (${ticket.stopAtr} ATR)`],
        [t.target, `${ticket.target} ${cur}`],
        [
          t.risk,
          t.riskValue(`${ticket.risk.toFixed(2)} ${cur}`, ticket.riskBudget.toFixed(2), t.cappedBy[ticket.cappedBy]),
        ],
        [t.rewardRisk, t.rewardRiskValue(ticket.rrGross.toFixed(2), ticket.rrNet.toFixed(2))],
        [
          t.estimatedCosts,
          ticket.taxPct > 0
            ? t.taxedCosts(`${ticket.costs.toFixed(2)} ${cur}`, ticket.taxPct)
            : t.untaxedCosts(`0.00 ${cur}`),
        ],
      ];
    case "SELL":
      return [
        [t.amount, `${ticket.amount.toFixed(2)} ${cur}`],
        [t.approxUnits, fmtUnits(ticket.units)],
        [t.referencePrice, `${ticket.price} ${cur}`],
      ];
    case "ADJUST_STOP":
      return [
        [t.newStop, t.newStopValue(`${ticket.stop} ${cur}`, ticket.stopAtr)],
        [t.previousStop, ticket.previousStop != null ? `${ticket.previousStop} ${cur}` : t.noStop],
        [t.referencePrice, `${ticket.price} ${cur}`],
      ];
  }
}

/**
 * Prompt lines: the ticket the engine would compute if the reasoner proposes
 * a BUY, and the net R:R of each level the target can be anchored to.
 */
export function describeBuyPreview(
  input: SizingInput & { levels: readonly number[] },
  framework: Framework = DEFAULT_FRAMEWORK,
): string[] {
  const sizing = sizeBuy(input, framework);
  const cur = input.currency;
  if (!sizing) {
    return ["Engine ticket: without ATR14 there is no stop or size, so a BUY will be blocked (no_atr)."];
  }
  const min = framework.minRewardRisk;
  const lines = [
    `Engine ticket if you propose BUY: entry ${sizing.entry}, stop ${sizing.stop} (${sizing.stopAtr} ATR),` +
      ` ${fmtUnits(sizing.units)} units ≈ ${sizing.amount.toFixed(2)} ${cur},` +
      ` risk ${sizing.risk.toFixed(2)} ${cur} (${en.ticket.cappedBy[sizing.cappedBy]})` +
      (sizing.taxPct > 0 ? `, tax ${sizing.taxPct}%` : "") +
      ".",
  ];
  if (input.levels.length === 0) {
    lines.push(
      "Target levels: none above the price (trading at highs). There is no target to anchor to: a BUY will be blocked (target_not_anchored).",
    );
  } else {
    const levels = input.levels.map((l) => {
      const net = rewardRisk(sizing.entry, sizing.stop, l, sizing.taxPct).net;
      return `${l} → net R:R ${net.toFixed(2)}${net >= min ? " ✓" : ""}`;
    });
    lines.push(
      `Target levels (the target must be one of them, ±${TARGET_TOLERANCE_ATR} ATR; minimum ${min}:1 net): ${levels.join(" · ")}.`,
    );
  }
  return lines;
}

/** Prompt line: the trailing stop the engine would compute for a position. */
export function describeAdjustStopPreview(input: {
  price: number;
  atr: number | null | undefined;
  currentStop: number | null;
  horizon: Horizon;
  currency: Currency;
}): string {
  const { ticket, reasons } = buildAdjustStopTicket(input);
  if (reasons.includes("no_atr")) return "Engine stop: without ATR14 an ADJUST_STOP cannot be computed (no_atr).";
  if (!ticket) {
    return `Engine stop: does not rise — the current stop (${input.currentStop}) is already ${STOP_ATR_BY_HORIZON[input.horizon]} ATR or closer to the price; an ADJUST_STOP will be blocked (stop_not_raised).`;
  }
  return `Engine stop if you propose ADJUST_STOP: ${ticket.stop} ${input.currency} (${ticket.stopAtr} ATR below the price; today ${input.currentStop ?? "no stop"}).`;
}

function floorUnits(units: number, fractional: boolean): number {
  if (!fractional) return Math.floor(units);
  const f = 10 ** UNIT_DECIMALS;
  return Math.floor(units * f + 1e-9) / f;
}
