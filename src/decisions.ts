// Single decision log (ADR-0006).
//
// One JSON line per decision in `logs/decisions.jsonl`, append-only and always
// written by the engine: the system's (screening, heartbeat, Monday Briefing)
// and the ones the owner narrates (`decision:record`). It includes decisions
// not to act —rejections, blocks and `hold`—, the cheapest data to learn from.
//
// This module is the single source of the schema: types, validation and the
// pure rules the writers use. I/O lives in vault-io.ts, like the rest of the
// brain. The schema is minimal on purpose: each later issue adds its optional
// fields once it has a consumer.
import { messages, type Messages } from "./i18n/index.js";
import { randomUUID } from "node:crypto";
import { checkTicker, parseTicker, tickerIdPart, type Ticker } from "./ticker.js";
import {
  CONVICTION_POINTS,
  CONVICTIONS,
  CURRENCIES,
  HORIZONS,
  MARKET_REGIMES,
  SETUP_PATTERNS,
  SETUP_STATES,
  TREND_BIASES,
} from "./types.js";
import { money, withinACent, type Money } from "./money.js";
import { round } from "./utils/round.js";
import type {
  Benchmark,
  Conviction,
  ConvictionPoint,
  Currency,
  EngineTicket,
  Horizon,
  MarketRegime,
  Recommendation,
  Setup,
  Signal,
  StrengthSnapshot,
  TrendBias,
  WatchlistEntry,
} from "./types.js";

// Spanish values ("system", "owner"): they are part of the stored format.
export const DECISION_ORIGINS = ["sistema", "propietario"] as const;
export const DECISION_SOURCES = ["screening", "heartbeat", "monday-briefing", "portfolio-sync"] as const;
export const DECISION_TYPES = [
  "screen_interesting",
  "screen_rejected",
  "buy_proposal",
  "buy_blocked",
  "setup_armed",
  "hold",
  "sell",
  "adjust_stop",
  "entry",
  "exit",
  "deposit",
  "withdrawal",
  "fx_conversion",
] as const;

export type DecisionOrigin = (typeof DECISION_ORIGINS)[number];
export type DecisionSource = (typeof DECISION_SOURCES)[number];
export type DecisionType = (typeof DECISION_TYPES)[number];

/** Silo money flows: they carry no ticker. */
export const FLOW_TYPES: readonly DecisionType[] = ["deposit", "withdrawal", "fx_conversion"];

/** What the owner narrates and records with `decision:record`. */
export const OWNER_TYPES = ["entry", "exit", "adjust_stop", "deposit", "withdrawal", "fx_conversion"] as const;
export type OwnerDecisionType = (typeof OWNER_TYPES)[number];

export interface Decision {
  id: string;
  /** Date of the event, YYYY-MM-DD. */
  date: string;
  /** `null` in money flows (deposit, withdrawal, fx_conversion). */
  ticker: Ticker | null;
  /** Silo. In `fx_conversion`, the one the money comes from. */
  currency: Currency;
  origin: DecisionOrigin;
  source: DecisionSource;
  type: DecisionType;
  /** Asset price on the date. */
  price?: number;
  /** Silo benchmark (ADR-0009) on the same date. Best-effort. */
  benchmark?: { ticker: Ticker; price: number };
  /** Silo market regime on the date (ADR-0010). Absent without benchmark history. */
  regime?: MarketRegime;
  /** Amount in the silo currency: buy, sale, deposit or converted amount. */
  amount?: number;
  /** `fx_conversion`: target currency per unit of source, before fee. */
  fx_rate?: number;
  /** Costs in the silo currency (FX fee, transaction tax). */
  costs?: Money;
  /** `exit`: realized result, negative on a loss. Used by the two-month rule. */
  pnl?: Money;
  /** Stop at entry: the base of R. In an `exit`, the one of its lot (part of the lot snapshot). */
  stop_initial?: number;
  /** `adjust_stop`: stop level after the adjustment. */
  stop?: number;
  target?: number;
  horizon?: Horizon;
  conviction?: Conviction;
  /**
   * Engine rubric points that add up to `conviction` (ADR-0012 §7). Their
   * presence tells the engine's conviction apart from the reasoner's old one.
   */
  conviction_points?: ConvictionPoint[];
  /** Entry verdict. `blocked` always carries at least one reason. */
  eligibility?: { verdict: "eligible" | "blocked"; reasons: string[] };
  strength?: { range_position: number; bias: TrendBias };
  atr14?: number;
  /** Screening: place in the silo ranking (1 = best, ADR-0012). Absent if drawn at random. */
  rank?: number;
  /** Screening: ranking score, in [0, 1]. */
  score?: number;
  /** Screening: picked at random among the eligible, to measure whether the ranking beats chance. */
  exploration?: boolean;
  /**
   * Setup behind the decision (ADR-0013): the pattern, its state and its
   * level (the confirmation close or the Buy Stop's). The target goes in `target`.
   */
  setup?: Pick<Setup, "pattern" | "state" | "level">;
  /** 1-3 falsifiable assumptions. Only in buy proposals. */
  assumptions?: string[];
  /** `version` of strategies/base.md in force when deciding. */
  rules_version: string;
  /** Rules an owner trade breaks. In an `exit`, the ones its lot's entry broke (part of the lot snapshot). */
  rule_violations?: string[];
  /**
   * Lot snapshot of an `exit` (ADR-0015): what the evaluation needs of the entry whose lot the exit
   * consumes, so realized R is computed from the exit alone, with no join that archiving can break.
   * With `stop_initial` and `rule_violations` above, all optional (ADR-0006): an exit without it
   * parses, and the evaluation skips it. Snapshot: entry price.
   */
  entry_price?: number;
  /**
   * `entry`: the units bought, written by `decision:record` since the lot contract (#52); the lot's
   * `Entry units` is this number. An entry whose line carries none predates the lots and is out of the
   * lots check.
   * `exit`: the units this exit sold from its lot, written by `decision:record` (B1 of PR #56). The
   * evaluation measures from it (weights, the check of `lot_units_left`, closure) so the cent rounding
   * of a sale split across lots cannot make a lot look inconsistent; an exit without it (written by
   * hand) falls back to `amount / price`. The exits of one sale add up to the units sold.
   */
  units?: number;
  /** Snapshot: units of the whole lot at entry (`amount / price` of the entry). */
  entry_units?: number;
  /**
   * Snapshot: this exit's share of the lot's entry costs, in the silo currency: pro rata to the units
   * it sold, the remainder on the last exit of the lot, so the exits add up to the lot's costs.
   */
  entry_costs?: Money;
  /** Snapshot: date of the entry, YYYY-MM-DD. */
  entry_date?: string;
  /**
   * Units the lot has left after this exit, 0 when the exit used it up (#52): a lot is closed when its
   * last exit has 0. Part of the snapshot; an exit with the snapshot but without it is not measured.
   */
  lot_units_left?: number;
  /** Snapshot: origin of the entry (ADR-0009 §8). */
  entry_origin?: DecisionOrigin;
  /** Snapshot: `rules_version` in force at the entry; the one a trade counts under. */
  entry_rules_version?: string;
  /** Related decision (e.g. the proposal behind an entry; in an `exit`, the entry of its lot). */
  related_id?: string;
  /** Linked Markdown log, relative to the data directory (VAULT_PROJECT_DIR). */
  log_link?: string;
}

/** How a candidate entered the screening (ADR-0012); carried by the candidate, the result and the decision. */
export type ScreeningSelection = Pick<Decision, "rank" | "score" | "exploration">;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const KNOWN_FIELDS = new Set<string>([
  "id",
  "date",
  "ticker",
  "currency",
  "origin",
  "source",
  "type",
  "price",
  "benchmark",
  "regime",
  "amount",
  "fx_rate",
  "costs",
  "pnl",
  "stop_initial",
  "stop",
  "target",
  "horizon",
  "conviction",
  "conviction_points",
  "eligibility",
  "strength",
  "atr14",
  "rank",
  "score",
  "exploration",
  "setup",
  "assumptions",
  "rules_version",
  "rule_violations",
  "units",
  "entry_price",
  "entry_units",
  "entry_costs",
  "entry_date",
  "entry_origin",
  "entry_rules_version",
  "lot_units_left",
  "related_id",
  "log_link",
]);

/** The lot snapshot of an `exit` that the evaluation cannot do without. */
const REQUIRED_SNAPSHOT = ["entry_price", "entry_units", "entry_date", "entry_origin", "entry_rules_version"] as const;
const SNAPSHOT_FIELDS = [...REQUIRED_SNAPSHOT, "entry_costs"] as const;
/** What a snapshot needs on top, but which an exit may carry without one: `related_id` is the lot's entry id. */
const SNAPSHOT_LOT_ID = "related_id";

/** Required numeric fields per type; the rest are optional. */
const REQUIRED_NUMBERS: Partial<Record<DecisionType, readonly (keyof Decision)[]>> = {
  screen_interesting: ["price"],
  screen_rejected: ["price"],
  buy_proposal: ["price"],
  setup_armed: ["price", "target"],
  adjust_stop: ["stop"],
  entry: ["price", "amount"],
  exit: ["price", "amount"],
  deposit: ["amount"],
  withdrawal: ["amount"],
  fx_conversion: ["amount", "fx_rate", "costs"],
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim() !== "");

/**
 * 1-3 non-empty falsifiable assumptions: the contract of every buy proposal,
 * whether from the reasoner, the briefing PROPOSALS line or the log.
 */
export const isAssumptionList = (v: unknown): v is string[] => isStringList(v) && v.length >= 1 && v.length <= 3;

/**
 * Units an `entry` or `exit` moved: its own `units` (`decision:record` writes them on every trade) and,
 * only for a line without them (written by hand), `amount / price`, whose units are not exact. The one
 * rule, for every consumer of a line's units. The caller has checked `price` and `amount` are there.
 */
export const tradeUnits = (d: Decision): number => d.units ?? d.amount! / d.price!;

/**
 * The one rule "a lot cannot be sold before it was bought" (the same day is a round trip), for the
 * validation of a recorded exit and for the refusal of a sale before it is recorded.
 */
export const entryAfterExit = (entryDate: string, exitDate: string): boolean => entryDate > exitDate;

/**
 * What is wrong with the lot snapshot (`entry_*` and `related_id`) of a decision, if it has one: an empty
 * list is a complete and coherent snapshot of an `exit`. The one definition of "a snapshot a measurement
 * can use": `validateDecision` reports these problems and the evaluation's guard (`hasLotSnapshot`)
 * leaves out an exit that has any. This covers the snapshot's presence, its dates, origin, rules version and
 * lot id; the numeric fields (entry price and units, initial stop, `lot_units_left`) are checked by
 * `validateDecision` and, on a line that was never validated, only for being present by the guard, so on those
 * the two can disagree.
 */
export function lotSnapshotProblems(raw: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (raw.type !== "exit") errors.push("the lot snapshot (entry_*) only goes in exit");
  else {
    // All or nothing: half a snapshot would be measured as a different trade.
    for (const field of [...REQUIRED_SNAPSHOT, SNAPSHOT_LOT_ID] as const) {
      if (raw[field] == null) errors.push(`${field} is required with the lot snapshot`);
      // The lot's entry id names the lot: an empty one would merge lots under one key.
      else if (field === SNAPSHOT_LOT_ID && (typeof raw[field] !== "string" || raw[field].trim() === ""))
        errors.push(`${field} must be a non-empty string`);
    }
  }
  if (raw.entry_date != null && (typeof raw.entry_date !== "string" || !DATE_RE.test(raw.entry_date))) {
    errors.push(`entry_date must be YYYY-MM-DD; got: ${JSON.stringify(raw.entry_date)}`);
  }
  if (
    raw.type === "exit" &&
    typeof raw.entry_date === "string" &&
    DATE_RE.test(raw.entry_date) &&
    typeof raw.date === "string" &&
    DATE_RE.test(raw.date) &&
    entryAfterExit(raw.entry_date, raw.date)
  ) {
    errors.push(`entry_date ${raw.entry_date} is after the exit's date ${raw.date}`);
  }
  if (raw.entry_origin != null && !DECISION_ORIGINS.includes(raw.entry_origin as DecisionOrigin)) {
    errors.push(
      `entry_origin must be one of [${DECISION_ORIGINS.join(", ")}]; got: ${JSON.stringify(raw.entry_origin)}`,
    );
  }
  if (
    raw.entry_rules_version != null &&
    (typeof raw.entry_rules_version !== "string" || raw.entry_rules_version.trim() === "")
  ) {
    errors.push("entry_rules_version must be a non-empty string");
  }
  return errors;
}

/**
 * Validates a decision against the schema. It collects every problem and throws
 * a single error, like `validateRecommendation`: a malformed line must not
 * reach the log, because everything measured later will read it as is.
 */
export function validateDecision(raw: unknown): Decision {
  if (!isObj(raw)) throw new Error("The decision is not a JSON object.");
  const errors: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) errors.push(`unknown field: ${key}`);
  }

  const nonEmpty = (field: string) => {
    if (typeof raw[field] !== "string" || raw[field].trim() === "") {
      errors.push(`${field} must be a non-empty string`);
    }
  };
  const oneOf = (field: string, allowed: readonly string[]) => {
    if (typeof raw[field] !== "string" || !allowed.includes(raw[field])) {
      errors.push(`${field} must be one of [${allowed.join(", ")}]; got: ${JSON.stringify(raw[field])}`);
    }
  };

  nonEmpty("id");
  nonEmpty("rules_version");
  if (typeof raw.date !== "string" || !DATE_RE.test(raw.date)) {
    errors.push(`date must be YYYY-MM-DD; got: ${JSON.stringify(raw.date)}`);
  }
  oneOf("currency", CURRENCIES);
  oneOf("origin", DECISION_ORIGINS);
  oneOf("source", DECISION_SOURCES);
  oneOf("type", DECISION_TYPES);

  const type = raw.type as DecisionType;
  if (FLOW_TYPES.includes(type)) {
    if (raw.ticker != null) errors.push(`ticker must be null in ${type}`);
  } else {
    const checked = checkTicker(raw.ticker);
    if ("problem" in checked) errors.push(`ticker: ${checked.problem}`);
  }

  for (const field of [
    "price",
    "amount",
    "fx_rate",
    "stop_initial",
    "stop",
    "target",
    "atr14",
    "entry_price",
    "entry_units",
    "units",
  ] as const) {
    const v = raw[field];
    if (v != null && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
      errors.push(`${field} must be a number > 0; got: ${JSON.stringify(v)}`);
    }
  }
  for (const field of ["costs", "entry_costs", "lot_units_left"] as const) {
    const v = raw[field];
    if (v != null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      errors.push(`${field} must be a number >= 0; got: ${JSON.stringify(v)}`);
    }
  }
  if (raw.units != null && type !== "entry" && type !== "exit") errors.push("units only goes in entry or exit");
  if (raw.pnl != null) {
    if (typeof raw.pnl !== "number" || !Number.isFinite(raw.pnl))
      errors.push(`pnl must be a number; got: ${JSON.stringify(raw.pnl)}`);
    else if (type !== "exit") errors.push("pnl only goes in exit");
  }
  for (const field of REQUIRED_NUMBERS[type] ?? []) {
    if (raw[field] == null) errors.push(`${field} is required in ${type}`);
  }

  if (SNAPSHOT_FIELDS.some((f) => raw[f] != null)) errors.push(...lotSnapshotProblems(raw));

  if (raw.lot_units_left != null && !(type === "exit" && SNAPSHOT_FIELDS.some((f) => raw[f] != null))) {
    errors.push("lot_units_left only goes with the lot snapshot of an exit");
  }

  if (raw.horizon != null) oneOf("horizon", HORIZONS);
  if (raw.regime != null) oneOf("regime", MARKET_REGIMES);
  if (raw.conviction != null) oneOf("conviction", CONVICTIONS);
  if (raw.conviction_points != null) {
    const points = raw.conviction_points;
    if (!Array.isArray(points) || !points.every((p) => CONVICTION_POINTS.includes(p as ConvictionPoint))) {
      errors.push(
        `conviction_points must be a list of [${CONVICTION_POINTS.join(", ")}]; got: ${JSON.stringify(points)}`,
      );
    }
    if (raw.conviction == null) errors.push("conviction_points only goes with conviction");
  }

  if (raw.benchmark != null) {
    const b = raw.benchmark;
    if (!isObj(b) || typeof b.price !== "number" || !(b.price > 0)) {
      errors.push(`benchmark must be { ticker, price > 0 }; got: ${JSON.stringify(b)}`);
    }
  }

  if (raw.eligibility != null) {
    const e = raw.eligibility;
    if (
      !isObj(e) ||
      (e.verdict !== "eligible" && e.verdict !== "blocked") ||
      !Array.isArray(e.reasons) ||
      !e.reasons.every((r) => typeof r === "string")
    ) {
      errors.push(`eligibility must be { verdict: eligible|blocked, reasons: string[] }; got: ${JSON.stringify(e)}`);
    } else if (e.verdict === "blocked" && e.reasons.length === 0) {
      errors.push("blocked eligibility without reasons");
    }
  }
  if (type === "buy_blocked") {
    const e = raw.eligibility;
    if (!isObj(e) || e.verdict !== "blocked") errors.push("buy_blocked requires eligibility with verdict blocked");
  }

  if (raw.strength != null) {
    const s = raw.strength;
    if (
      !isObj(s) ||
      typeof s.range_position !== "number" ||
      !Number.isFinite(s.range_position) ||
      !TREND_BIASES.includes(s.bias as TrendBias)
    ) {
      errors.push(`strength must be { range_position, bias }; got: ${JSON.stringify(s)}`);
    }
  }

  const isScreening = type === "screen_interesting" || type === "screen_rejected";
  if (raw.rank != null && (!Number.isInteger(raw.rank) || (raw.rank as number) < 1)) {
    errors.push(`rank must be an integer >= 1; got: ${JSON.stringify(raw.rank)}`);
  }
  if (raw.score != null && (typeof raw.score !== "number" || !(raw.score >= 0 && raw.score <= 1))) {
    errors.push(`score must be a number in [0, 1]; got: ${JSON.stringify(raw.score)}`);
  }
  if (raw.exploration != null && typeof raw.exploration !== "boolean") {
    errors.push(`exploration must be a boolean; got: ${JSON.stringify(raw.exploration)}`);
  }
  if (!isScreening && (raw.rank != null || raw.score != null || raw.exploration != null)) {
    errors.push("rank, score and exploration only go in screening decisions");
  }

  if (raw.setup != null) {
    const st = raw.setup;
    if (
      !isObj(st) ||
      !SETUP_PATTERNS.includes(st.pattern as Setup["pattern"]) ||
      !SETUP_STATES.includes(st.state as Setup["state"]) ||
      typeof st.level !== "number" ||
      !Number.isFinite(st.level) ||
      !(st.level > 0)
    ) {
      errors.push(
        `setup must be { pattern: pullback|breakout, state: triggered|armed, level > 0 }; got: ${JSON.stringify(st)}`,
      );
    }
  }
  if (type === "setup_armed") {
    if (!isObj(raw.setup) || raw.setup.state !== "armed") errors.push("setup_armed requires setup with state armed");
    if (!isObj(raw.eligibility)) errors.push("setup_armed requires eligibility");
  }

  if (raw.assumptions != null) {
    if (type !== "buy_proposal" && type !== "buy_blocked") {
      errors.push("assumptions only goes in buy proposals");
    } else if (!isAssumptionList(raw.assumptions)) {
      errors.push("assumptions must have 1-3 non-empty strings");
    }
  }
  if (type === "buy_proposal" && raw.assumptions == null) {
    errors.push("assumptions is required in buy_proposal");
  }

  if (raw.rule_violations != null && !isStringList(raw.rule_violations)) {
    errors.push("rule_violations must be a list of strings");
  }
  for (const field of ["related_id", "log_link"] as const) {
    if (raw[field] != null) nonEmpty(field);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid decision:\n- ${errors.join("\n- ")}`);
  }
  // Canonical tickers: a decision written in another case reads as its upper-case value.
  const decision = raw as unknown as Decision;
  const { benchmark, ...rest } = decision;
  // A benchmark whose ticker does not parse is dropped, not the whole line (it is a side measurement, and
  // the line was accepted before the ticker became a parsed value): the decision keeps its other fields.
  const benchmarkTicker = benchmark ? checkTicker(benchmark.ticker) : undefined;
  if (benchmarkTicker && "problem" in benchmarkTicker) {
    console.warn(`[decisions] WARNING: decision ${decision.id}: benchmark dropped: ${benchmarkTicker.problem}`);
  }
  return {
    ...rest,
    ...(decision.ticker != null ? { ticker: parseTicker(decision.ticker) } : {}),
    // Settled money is whole cents from here on, whatever the line or the owner wrote.
    ...(decision.costs != null ? { costs: money(decision.costs) } : {}),
    ...(decision.pnl != null ? { pnl: money(decision.pnl) } : {}),
    ...(decision.entry_costs != null ? { entry_costs: money(decision.entry_costs) } : {}),
    ...(benchmark && benchmarkTicker && "ticker" in benchmarkTicker
      ? { benchmark: { ...benchmark, ticker: benchmarkTicker.ticker } }
      : {}),
  };
}

/** Readable unique id: date, asset (or silo) and type, plus a random suffix. */
export function newDecisionId(date: string, subject: string, type: DecisionType): string {
  const slug = tickerIdPart(subject);
  return `${date.replace(/-/g, "")}-${slug}-${type}-${randomUUID().slice(0, 8)}`;
}

/**
 * Builds and validates a decision. It drops `undefined` fields so the JSON
 * line only carries what is known: a missing field means "not recorded",
 * never a default value.
 */
export function buildDecision(fields: Omit<Decision, "id"> & { id?: string }): Decision {
  const withId = {
    ...fields,
    id: fields.id ?? newDecisionId(fields.date, fields.ticker ?? fields.currency, fields.type),
  };
  const clean = Object.fromEntries(Object.entries(withId).filter(([, v]) => v !== undefined));
  return validateDecision(clean);
}

/** The watchlist.md horizon arrives untyped: outside short|medium it is not recorded. */
export function asHorizon(h: unknown): Horizon | undefined {
  return HORIZONS.includes(h as Horizon) ? (h as Horizon) : undefined;
}

/**
 * System decision from a reasoner recommendation (heartbeat via API or
 * pending:resolve) and the ticket the engine computed. A blocked
 * BUY is recorded as `buy_blocked` with its reasons: not acting is a decision
 * too. A SELL or ADJUST_STOP the engine cannot carry out leaves the position
 * as it was, so it is a `hold`, as in the Monday Briefing. Without an open
 * position there is nothing to hold: it is a reasoner error and only stays in
 * the Markdown log.
 */
export function decisionFromRecommendation(
  rec: Recommendation,
  signal: Signal,
  ctx: {
    date: string;
    rulesVersion: string;
    source: DecisionSource;
    logLink?: string;
    blocked: boolean;
    /** Block codes (framework rules and arithmetic); empty if not blocked. */
    reasons: string[];
    ticket: EngineTicket | null;
  },
): Decision | null {
  const common = {
    date: ctx.date,
    ticker: rec.ticker,
    currency: signal.currency,
    origin: "sistema" as const,
    source: ctx.source,
    price: signal.price,
    ...benchmarkFields(signal.benchmark),
    // The engine's, which only a setup signal carries.
    conviction: signal.conviction?.conviction,
    conviction_points: signal.conviction?.points,
    horizon: asHorizon(signal.entry?.horizon),
    ...strengthFields(signal.strength),
    ...setupFields(signal.setup),
    rules_version: ctx.rulesVersion,
    log_link: ctx.logLink,
  };
  const positive = (n: number | undefined) => (n != null && n > 0 ? n : undefined);
  const t = ctx.ticket;

  switch (rec.action) {
    case "HOLD":
      // A setup only escalates if the engine deemed it eligible: not buying it is
      // a buy not made, which the evaluation compares with the proposals.
      return buildDecision({
        ...common,
        type: "hold",
        ...(signal.setup ? { eligibility: { verdict: "eligible" as const, reasons: [] } } : {}),
      });
    case "BUY": {
      const buy = t?.kind === "BUY" ? t : undefined;
      return buildDecision({
        ...common,
        type: ctx.blocked ? "buy_blocked" : "buy_proposal",
        amount: positive(buy?.amount),
        costs: buy?.costs == null ? undefined : money(buy.costs),
        stop_initial: buy?.stop,
        target: positive(rec.ticket.target),
        assumptions: rec.assumptions,
        ...(ctx.blocked ? { eligibility: { verdict: "blocked" as const, reasons: ctx.reasons } } : {}),
      });
    }
    case "SELL":
    case "ADJUST_STOP":
      if (!signal.position) return null;
      if (!ctx.blocked && t?.kind === "SELL")
        return buildDecision({ ...common, type: "sell", amount: positive(t.amount) });
      if (!ctx.blocked && t?.kind === "ADJUST_STOP")
        return buildDecision({ ...common, type: "adjust_stop", stop: t.stop });
      return buildDecision({ ...common, type: "hold" });
  }
}

/**
 * Two-month rule warning (art. 33.5.f LIRPF, ADR-0009 §9): with real money,
 * buying back a security sold at a loss in the previous two months defers that
 * loss. Only with `account_env: real`; `null` if it does not apply.
 */
export function twoMonthRuleWarning(
  history: readonly Decision[],
  ticker: Ticker,
  date: string,
  accountEnv: string | undefined,
  m: Messages = messages(),
): string | null {
  if (accountEnv !== "real") return null;
  const loss = history
    .filter(
      (d) =>
        d.type === "exit" &&
        d.ticker === ticker &&
        d.pnl != null &&
        d.pnl < 0 &&
        d.date <= date &&
        addMonths(d.date, 2) > date,
    )
    .at(-1);
  if (!loss) return null;
  return m.twoMonthRule(ticker, loss.pnl!, loss.currency, loss.date, addMonths(loss.date, 2));
}

function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Splits the benchmark (price) from its regime, a field of its own in the log. */
export function benchmarkFields(b: Benchmark | undefined): Pick<Decision, "benchmark" | "regime"> {
  if (!b) return {};
  return { benchmark: { ticker: b.ticker, price: b.price }, regime: b.regime };
}

/** The setup as it goes to the log: the target goes in `target`, the date is the decision's. */
export function setupFields(s: Setup | undefined): Pick<Decision, "setup"> {
  return s ? { setup: { pattern: s.pattern, state: s.state, level: s.level } } : {};
}

/** Maps the engine's technical snapshot (ADR-0011, ADR-0006) to the log fields. */
export function strengthFields(s: StrengthSnapshot | undefined): Pick<Decision, "strength" | "atr14"> {
  if (!s) return {};
  return {
    strength: { range_position: Math.round(s.rangePosition * 1000) / 1000, bias: s.bias },
    ...(s.atr14 != null ? { atr14: Math.round(s.atr14 * 10_000) / 10_000 } : {}),
  };
}

// ─── Trades narrated by the owner (`decision:record`) ────────────────────────

/** What `decision:record` receives on stdin. The engine fills in the rest. */
export interface OwnerDecisionInput {
  type: OwnerDecisionType;
  /** YYYY-MM-DD; today by default. */
  date?: string;
  ticker?: Ticker;
  currency: Currency;
  price?: number;
  /** Amount; in entry/exit `units` can be given instead. */
  amount?: number;
  units?: number;
  /** entry: initial stop; adjust_stop: new stop. */
  stop?: number;
  /** fx_conversion: market rate; or `received`, what reached the other silo. */
  fx_rate?: number;
  received?: number;
  costs?: Money;
  /** exit: realized result; if missing, computed with the average price in portfolio.md. */
  pnl?: Money;
  /** To force the origin when the engine cannot infer it. */
  origin?: DecisionOrigin;
  related_id?: string;
}

/** Validates the `decision:record` input before touching the log. */
export function validateOwnerInput(raw: unknown): OwnerDecisionInput {
  if (!isObj(raw)) throw new Error("The decision:record input is not a JSON object.");
  const errors: string[] = [];
  const type = raw.type as OwnerDecisionType;

  if (!OWNER_TYPES.includes(type)) {
    errors.push(`type must be one of [${OWNER_TYPES.join(", ")}]; got: ${JSON.stringify(raw.type)}`);
  }
  if (!CURRENCIES.includes(raw.currency as Currency)) {
    errors.push(`currency must be one of [${CURRENCIES.join(", ")}]; got: ${JSON.stringify(raw.currency)}`);
  }
  if (raw.date != null && (typeof raw.date !== "string" || !DATE_RE.test(raw.date))) {
    errors.push(`date must be YYYY-MM-DD; got: ${JSON.stringify(raw.date)}`);
  }
  for (const field of ["price", "amount", "units", "stop", "fx_rate", "received"] as const) {
    const v = raw[field];
    if (v != null && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
      errors.push(`${field} must be a number > 0; got: ${JSON.stringify(v)}`);
    }
  }
  if (raw.costs != null && (typeof raw.costs !== "number" || !Number.isFinite(raw.costs) || raw.costs < 0)) {
    errors.push(`costs must be a number >= 0; got: ${JSON.stringify(raw.costs)}`);
  }
  if (raw.pnl != null && (typeof raw.pnl !== "number" || !Number.isFinite(raw.pnl) || type !== "exit")) {
    errors.push(`pnl must be a number and only applies to exit; got: ${JSON.stringify(raw.pnl)}`);
  }
  if (raw.origin != null && !DECISION_ORIGINS.includes(raw.origin as DecisionOrigin)) {
    errors.push(`origin must be one of [${DECISION_ORIGINS.join(", ")}]; got: ${JSON.stringify(raw.origin)}`);
  }

  const has = (f: string) => raw[f] != null;
  if (["entry", "exit", "adjust_stop"].includes(type)) {
    if (raw.ticker == null) errors.push(`ticker is required in ${type}`);
    else {
      const checked = checkTicker(raw.ticker);
      if ("problem" in checked) errors.push(`ticker: ${checked.problem}`);
    }
  }
  if (FLOW_TYPES.includes(type) && has("ticker")) errors.push(`ticker does not apply in ${type}`);
  if ((type === "entry" || type === "exit") && !has("price")) errors.push(`price is required in ${type}`);
  if ((type === "entry" || type === "exit") && !has("amount") && !has("units")) {
    errors.push(`${type} needs amount or units`);
  }
  if ((type === "entry" || type === "exit") && has("units") && has("amount")) {
    // Units, amount and price are one fact told twice: the lot, the log line and the evaluation (which
    // measures units as amount / price) must read the same units, so a contradiction is refused.
    const { units, amount, price } = raw as { units: number; amount: number; price: number };
    if (Number.isFinite(units) && Number.isFinite(amount) && Number.isFinite(price) && price > 0) {
      if (!withinACent(amount, units * price)) {
        errors.push(
          `units ${units} × price ${price} = ${round(units * price, 2)}, not the amount ${amount} (give units or amount, or make them agree to the cent)`,
        );
      }
    }
  }
  if (type === "adjust_stop" && !has("stop")) errors.push("stop is required in adjust_stop");
  if ((type === "deposit" || type === "withdrawal" || type === "fx_conversion") && !has("amount")) {
    errors.push(`amount is required in ${type}`);
  }
  if (type === "fx_conversion" && !has("fx_rate") && !has("received")) {
    errors.push("fx_conversion needs fx_rate or received");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid decision:record input:\n- ${errors.join("\n- ")}`);
  }
  const input = raw as unknown as OwnerDecisionInput;
  return {
    ...input,
    ...(has("ticker") ? { ticker: parseTicker(input.ticker) } : {}),
    ...(input.costs != null ? { costs: money(input.costs) } : {}),
    ...(input.pnl != null ? { pnl: money(input.pnl) } : {}),
  };
}

/**
 * Fee and rate of a conversion. If the owner gives what was received, the rate
 * is inferred; if they give the rate, what was received. The fee, if not
 * given, is the ADR-0009 §7 one (proportional, no minimum).
 */
export function resolveFxConversion(
  input: Pick<OwnerDecisionInput, "amount" | "fx_rate" | "received" | "costs">,
  commissionPct: number,
): { costs: Money; fx_rate: number } {
  const amount = input.amount!;
  const costs = input.costs ?? money((amount * commissionPct) / 100);
  const fx_rate = input.fx_rate ?? round(input.received! / (amount - costs), 6);
  return { costs, fx_rate };
}

/**
 * Rules an owner entry breaks: buying something outside the watchlist, or
 * without a system setup before it (ADR-0013: setups are the only way in).
 * `atr` is best-effort: without it the stop distance is not checked.
 */
export function entryRuleViolations(input: {
  price: number;
  stop?: number;
  entry?: WatchlistEntry;
  /** System decision the entry comes from, if any. */
  proposal?: Decision;
  atr?: number | null;
  minStopAtr: number;
}): string[] {
  const violations: string[] = [];
  if (!input.entry) violations.push("not_in_watchlist");
  else if (!input.proposal?.setup) violations.push("entry_without_setup");
  if (input.stop == null) {
    violations.push("no_stop");
  } else if (input.atr != null && input.atr > 0 && (input.price - input.stop) / input.atr < input.minStopAtr) {
    violations.push("stop_below_min_atr");
  }
  return violations;
}

/** Calendar days between two YYYY-MM-DD dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** Window in which an owner trade is attributed to a system proposal. */
export const PROPOSAL_WINDOW_DAYS = 10;

/**
 * System decision preceding an owner trade: the latest one of the same ticker
 * and of one of the requested types, within the window and not yet cited by a
 * trade.
 */
export function findRelatedProposal(
  decisions: readonly Decision[],
  query: { ticker: Ticker; date: string; types: readonly DecisionType[] },
): Decision | undefined {
  const used = new Set(decisions.map((d) => d.related_id).filter(Boolean));
  return decisions
    .filter(
      (d) =>
        d.origin === "sistema" &&
        query.types.includes(d.type) &&
        d.ticker === query.ticker &&
        !used.has(d.id) &&
        daysBetween(d.date, query.date) >= 0 &&
        daysBetween(d.date, query.date) <= PROPOSAL_WINDOW_DAYS,
    )
    .at(-1);
}

/**
 * Origin of a narrated trade from the decision preceding it (ADR-0009 §8):
 * `sistema` (system) if it follows one of its proposals or an eligible armed
 * breakout (the Buy Stop order that fills); `propietario` (owner) if it is
 * discretionary or skips an engine block.
 */
export function originOf(related: Decision | undefined): DecisionOrigin {
  const blocked = related?.type === "buy_blocked" || related?.eligibility?.verdict === "blocked";
  return related?.origin === "sistema" && !blocked ? "sistema" : "propietario";
}
