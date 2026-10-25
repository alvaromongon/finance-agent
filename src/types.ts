// Shared types of the Finance Agent.
import type { DecisionOrigin } from "./decisions.js";
import type { Ticker } from "./ticker.js";

export type Currency = "EUR" | "USD";
export type Horizon = "short" | "medium";
// ADJUST_STOP: move the stop-loss of an already open position
// without a new BUY/SELL ticket (trailing stop). It is copied by hand into the
// Stop loss column of portfolio.md after the owner confirms, like any other
// ticket — the engine never executes it.
export type Action = "BUY" | "SELL" | "HOLD" | "ADJUST_STOP";
export type Conviction = "high" | "medium" | "low";
export type AssetClass = "equity" | "commodity" | "etf";

// Single sources for validating untyped input (reasoner JSON, vault
// frontmatter, CLI stdin).
export const CURRENCIES: readonly Currency[] = ["EUR", "USD"];
export const HORIZONS: readonly Horizon[] = ["short", "medium"];
export const ACTIONS: readonly Action[] = ["BUY", "SELL", "HOLD", "ADJUST_STOP"];
export const CONVICTIONS: readonly Conviction[] = ["high", "medium", "low"];

/** Points of the engine's conviction rubric (ADR-0012 §7): one stable code per condition. */
export type ConvictionPoint = "top_quintile" | "regime_favorable" | "reward_risk" | "dated_catalyst";
export const CONVICTION_POINTS: readonly ConvictionPoint[] = [
  "top_quintile",
  "regime_favorable",
  "reward_risk",
  "dated_catalyst",
];

/** Conviction computed by the engine, with the points behind it. */
export interface EngineConviction {
  conviction: Conviction;
  points: ConvictionPoint[];
}

/** Watchlist entry (parsed from the YAML block of watchlist.md). */
export interface WatchlistEntry {
  ticker: Ticker;
  name: string;
  market: string;
  currency: Currency;
  horizon: Horizon;
  thesis: string;
  thesis_link?: string;
  // Optional for compatibility with existing entries without this field;
  // consumers (weight breakdown, screening) use `?? "equity"`.
  asset_class?: AssetClass;
}

/** Open position synced by hand from the broker. */
export interface Position {
  ticker: Ticker;
  currency: Currency;
  volume: number;
  avgPrice: number;
  currentPrice: number;
  pl: number;
  stopLoss: number | null;
}

/**
 * The open units of one entry (ADR-0015), one row of the `Lots` table of portfolio.md. The row names
 * its ticker, so `Volume` can be checked against it without reading the decision log (#52).
 */
export interface Lot {
  /** Ticker of the position the lot belongs to; it must be the one of its entry in the log. */
  ticker: Ticker;
  /** Id of the `entry` decision that opened the lot. */
  entryId: string;
  /** Entry date, YYYY-MM-DD. */
  date: string;
  /** Units still open. */
  units: number;
  /** Units the entry bought. */
  entryUnits: number;
  entryPrice: number;
  /** Stop at entry, the base of R; `null` if the entry had none. */
  initialStop: number | null;
  /** Entry costs in the silo currency; `null` if none were recorded. */
  entryCosts: number | null;
  origin: DecisionOrigin;
  rulesVersion: string;
  /** Rules the entry broke; empty for none. */
  rulesViolations: string[];
}

/** Portfolio snapshot per currency. */
export interface PortfolioSnapshot {
  currency: Currency;
  /** "Available cash": capital free to trade. */
  cash: number;
  /**
   * "Total cash", including what pending orders hold: the cash that counts
   * towards the silo value (ADR-0009 §3). Absent if portfolio.md does not tell
   * it apart from the available balance.
   */
  totalCash?: number;
  positions: Position[];
  /** Open lots of the silo; `Volume` of each position is the sum of its lots' units. */
  lots: Lot[];
  /** One message per row of `Lots` the reader skipped because it does not read as a lot; absent if none. */
  skippedLotRows?: string[];
  syncedAt: string; // ISO timestamp
}

/**
 * Heartbeat triggers. All escalate to the reasoner and count for the cooldown:
 * `setup` is a candidate with a triggered entry setup (ADR-0013);
 * `approaching_stop` and `big_move` monitor the risk of held and watched assets.
 */
export type TriggerKind = "setup" | "approaching_stop" | "big_move";
export const TRIGGER_KINDS: readonly TriggerKind[] = ["setup", "approaching_stop", "big_move"];

/** Entry pattern the heartbeat tests on each candidate (ADR-0013). */
export type SetupPattern = "pullback" | "breakout";
export const SETUP_PATTERNS: readonly SetupPattern[] = ["pullback", "breakout"];

/**
 * `triggered`: the pattern confirmed at the session close; buy at the signal
 * price. `armed`: a breakout level not crossed yet; the level is that of the Buy Stop
 * order the owner can leave in place at their broker.
 */
export type SetupState = "triggered" | "armed";
export const SETUP_STATES: readonly SetupState[] = ["triggered", "armed"];

/** A setup found by the deterministic detectors in `utils/setups/`. */
export interface Setup {
  pattern: SetupPattern;
  state: SetupState;
  /** Session it was detected in, YYYY-MM-DD. */
  date: string;
  /** `triggered`: confirmation close. `armed`: top of the base, the Buy Stop level. */
  level: number;
  /** Pattern target: it anchors the ticket target. */
  target: number;
}

export type TrendBias = "ALCISTA" | "BAJISTA" | "MIXTO" | "INSUFICIENTE";

// Single source for validating a bias read from the vault (frontmatter of a
// pending file or table of a Markdown decision log), where it arrives as an untyped
// string. The Spanish values are part of the vault format.
export const TREND_BIASES: readonly TrendBias[] = ["ALCISTA", "BAJISTA", "MIXTO", "INSUFICIENTE"];

/**
 * Snapshot of the asset's technical strength **at decision time** (ADR-0006).
 * It is recorded in the Markdown decision log and in `logs/decisions.jsonl` to cross
 * the real outcome with the trend state at entry: without it, the question
 * "do strong stocks or fallen ones work better?" cannot be answered later,
 * because today's technicals are no longer those of the entry date.
 *
 * Best-effort: the heartbeat is the cheap layer and only downloads history
 * when there is a signal, so it may be missing if the provider has no history.
 */
export interface StrengthSnapshot {
  rangePosition: number; // 0–1: position in the 52-week range
  bias: TrendBias;
  /**
   * ATR14 in price units. It travels with the signal because it is
   * the unit the ticket stop is sized in: without it only a percentage could be
   * proposed, which is exactly what the `portfolio-policy.md` rule rules out.
   * Optional: it may be missing for the same reason as the rest of the
   * snapshot (no history) or in older signals.
   */
  atr14?: number;
  /**
   * Levels above the price (resistances and 52-week high) the reasoner must
   * anchor a BUY target to. Empty if the asset trades at highs:
   * then there is no target to anchor.
   */
  levels?: number[];
}

export interface Signal {
  ticker: Ticker;
  currency: Currency;
  triggers: TriggerKind[];
  price: number;
  // Absent when the signal comes from a position in portfolio.md without an
  // entry in watchlist.md — risk monitoring no longer depends on
  // a watchlist entry existing.
  entry?: WatchlistEntry;
  position?: Position;
  cash: number;
  // Silo value (cash + positions at market): the base of the per-trade risk
  // and of the per-position cap (ADR-0009 §3).
  siloValue: number;
  // Absent if it could not be computed (no history available); it never
  // blocks the run — see StrengthSnapshot.
  strength?: StrengthSnapshot;
  // Price of the silo benchmark on the detection date (ADR-0009), for the
  // decision log. Best-effort, like `strength`.
  benchmark?: Benchmark;
  // Setup that fired the signal (`setup` trigger, ADR-0013); absent in risk signals.
  setup?: Setup;
  // Engine conviction on the setup day; absent in risk signals.
  conviction?: EngineConviction;
}

/**
 * Buy ticket computed by the engine (ADR-0009 §3): ATR stop, units
 * by risk with caps, R:R net of costs and estimated costs.
 */
export interface BuyTicket {
  kind: "BUY";
  currency: Currency;
  /** Entry price: the signal's or the briefing's, never one from the reasoner. */
  entry: number;
  stop: number;
  /** Stop distance in ATR (the horizon's). */
  stopAtr: number;
  units: number;
  amount: number;
  /** Estimated transaction tax, in the asset currency. */
  costs: number;
  taxPct: number;
  /** Loss down to the stop: units × (entry − stop). */
  risk: number;
  /** Silo per-trade risk (ADR-0009): the most that is risked. */
  riskBudget: number;
  /** What capped the units: risk, the per-position cap or cash. */
  cappedBy: "risk" | "position" | "cash";
  target: number;
  rrGross: number;
  rrNet: number;
}

export interface SellTicket {
  kind: "SELL";
  currency: Currency;
  price: number;
  amount: number;
  units: number;
}

/** Trailing stop computed by the engine: it rises in ATR, never falls. */
export interface AdjustStopTicket {
  kind: "ADJUST_STOP";
  currency: Currency;
  price: number;
  stop: number;
  previousStop: number | null;
  stopAtr: number;
}

export type EngineTicket = BuyTicket | SellTicket | AdjustStopTicket;

/** Market regime of a silo, computed from its benchmark (ADR-0010). Values are part of the stored format. */
export type MarketRegime = "favorable" | "neutral" | "adverso";
export const MARKET_REGIMES: readonly MarketRegime[] = ["favorable", "neutral", "adverso"];

/** Price of a silo benchmark (ADR-0009) on a date, with its regime if there was history. */
export interface Benchmark {
  ticker: Ticker;
  price: number;
  regime?: MarketRegime;
}

/** Structured recommendation returned by Claude (the reasoner). */
export interface Recommendation {
  ticker: Ticker;
  action: Action;
  // No conviction: a setup's is computed by the engine
  // (Signal.conviction) and a decision on a position carries none.
  // The reasoner proposes neither stop nor buy amount: the
  // engine computes them (EngineTicket). It only adds what is not arithmetic.
  ticket: {
    direction: Action;
    currency: Currency;
    /** BUY: target anchored to a technical level from the context (resistance or 52-week high). */
    target?: number;
    /** SELL: amount to sell, in the asset currency. */
    amount?: number;
  };
  thesis_summary: string;
  triggers: TriggerKind[];
  /**
   * 1-3 falsifiable assumptions of a buy, macro ones included
   * ("crude > $90"). Required on BUY: without them there is no telling later
   * whether the trade failed because of the thesis or the market.
   */
  assumptions?: string[];
}
