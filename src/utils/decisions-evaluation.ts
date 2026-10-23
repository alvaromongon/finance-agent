// Decision evaluation: what happened after each decision in the
// log (ADR-0006), closed trades in net R, the aggregates and the cutoff
// criterion table (ADR-0009 §4). No I/O: decisions-evaluate.ts supplies the
// log, portfolio.md and the series, and decisions-evaluation-render.ts the
// Markdown.
import { messages, type Messages } from "../i18n/index.js";
import { config } from "../config.js";
import type { Decision, DecisionOrigin, DecisionType } from "../decisions.js";
import type { HistoricalBar } from "../providers/types.js";
import { CONVICTIONS, CURRENCIES } from "../types.js";
import type { Currency, Lot, PortfolioSnapshot } from "../types.js";
import { suggestStop } from "./atr-stop.js";
import { splitRatio } from "./lots-check.js";
import { closeOnOrBefore, excessReturn, forwardReturn, type HorizonOutcome } from "./forward-returns.js";
import { siloPerformance, type SiloPerformance, type SiloWarning } from "./silo-performance.js";

/** Framework parameters the evaluation uses; `config.framework` and `config.reference` by default. */
export interface EvaluationFramework {
  reference: Readonly<Record<Currency, string>>;
  minRewardRisk: number;
  cutReviewTrades: number;
  cutDecisionTrades: number;
  drawdownPausePct: number;
}

/** The configured framework, with the reference ETFs that come from the environment. */
const configuredFramework = (): EvaluationFramework => ({ ...config.framework, reference: config.reference });

/** Measured horizons, in the security's own sessions. */
export const SESSION_HORIZONS = [20, 60] as const;

/** Sessions after the decision in which the plan's stop and target are looked for. */
export const PLAN_WINDOW_SESSIONS = 60;

/** Below this size, reports warn that the group does not allow a conclusion. */
export const MIN_SAMPLE = 30;

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** C v1 is rules "1.x" and later; while it is being built, "0.x" (ADR-0009 §5). */
export function isCv1(rulesVersion: string): boolean {
  const major = Number.parseInt(rulesVersion, 10);
  return Number.isFinite(major) && major >= 1;
}

/** Decisions with an asset and a price to follow over time; money flows have none. */
const TRACKED_TYPES: readonly DecisionType[] = [
  "screen_interesting",
  "screen_rejected",
  "buy_proposal",
  "buy_blocked",
  "hold",
  "sell",
  "adjust_stop",
  "entry",
  "exit",
];

/** Buys, made or not, measured against a plan in R. */
const BUY_PLAN_TYPES: readonly DecisionType[] = [
  "screen_interesting",
  "screen_rejected",
  "buy_proposal",
  "buy_blocked",
  "entry",
];

/** Also the `hold` of an eligible setup the reasoner did not buy (ADR-0013): it is a buy not made. */
function hasBuyPlan(d: Decision): boolean {
  return BUY_PLAN_TYPES.includes(d.type) || (d.type === "hold" && d.eligibility?.verdict === "eligible");
}

// ─── Plan in R ───────────────────────────────────────────────────────────────

export interface BuyPlan {
  entry: number;
  stop: number;
  target: number;
  /** The stop or the target are not a ticket's: they come from the recorded ATR or the minimum R:R. */
  inferred: boolean;
}

/**
 * Plan a buy is measured against. It uses the stop and target of the engine
 * ticket, of the decision itself or of the proposal it cites. If they are
 * missing (screening, blocks without a ticket, entries without a stop), the
 * stop at the horizon distance with the recorded ATR (ADR-0011) and the target
 * at the minimum R:R (ADR-0009 §3). `null` without a price or a way to set the stop.
 */
export function buyPlan(d: Decision, related: Decision | undefined, minRewardRisk: number): BuyPlan | null {
  const entry = d.price;
  if (entry == null) return null;
  const ticketStop = d.stop_initial ?? related?.stop_initial;
  const horizon = d.horizon ?? related?.horizon ?? "medium";
  const stop = ticketStop ?? (d.atr14 != null ? suggestStop(entry, d.atr14, horizon) : undefined);
  if (stop == null || !(stop < entry)) return null;
  const ticketTarget = d.target ?? related?.target;
  const anchored = ticketTarget != null && ticketTarget > entry;
  return {
    entry,
    stop,
    target: anchored ? ticketTarget : entry + minRewardRisk * (entry - stop),
    inferred: ticketStop == null || !anchored,
  };
}

export interface Excursion {
  /** Maximum rise and maximum fall in R from the plan entry. */
  mfeR: number;
  maeR: number;
  /** What the price touched first; `null` if neither in the observed sessions. */
  first: "stop" | "target" | null;
  /** It touched the stop and, later in the same window, the target. */
  targetAfterStop: boolean;
  /**
   * Plan R: the target's, −1 at the stop (the daily bar does not see gaps) or,
   * if neither was touched in the full window, the last close's. `null` while
   * the window is still open without touching either.
   */
  resultR: number | null;
  /** Observed sessions, up to PLAN_WINDOW_SESSIONS. */
  sessions: number;
}

/** Price path against the plan in the sessions after the decision. */
export function excursion(
  bars: readonly HistoricalBar[],
  date: string,
  plan: BuyPlan,
  sessions = PLAN_WINDOW_SESSIONS,
): Excursion | null {
  // Only later sessions: the decision day's bar mixes what happened before and after.
  const window = bars.filter((b) => b.date > date).slice(0, sessions);
  if (window.length === 0) return null;

  const toR = (price: number) => (price - plan.entry) / (plan.entry - plan.stop);
  let first: Excursion["first"] = null;
  let targetAfterStop = false;
  let high = -Infinity;
  let low = Infinity;
  for (const bar of window) {
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
    if (first == null) {
      // If one session touches both, the order is unknown: the stop counts.
      if (bar.low <= plan.stop) first = "stop";
      else if (bar.high >= plan.target) first = "target";
    } else if (first === "stop" && bar.high >= plan.target) {
      targetAfterStop = true;
    }
  }

  const complete = window.length >= sessions;
  const resultR =
    first === "target" ? toR(plan.target) : first === "stop" ? -1 : complete ? toR(window.at(-1)!.close) : null;
  return { mfeR: toR(high), maeR: toR(low), first, targetAfterStop, resultR, sessions: window.length };
}

// ─── Per decision ────────────────────────────────────────────────────────────

export interface DecisionEvaluation {
  decision: Decision & { ticker: string };
  /** Benchmark of the decision's silo. */
  reference: string;
  /** Last close ≤ decision date; null = no usable history. */
  base: HistoricalBar | null;
  horizons: Record<number, HorizonOutcome>;
  plan: BuyPlan | null;
  excursion: Excursion | null;
}

/**
 * Crosses each decision with the series of its asset and of its silo
 * benchmark. `barsBySymbol` must hold only complete closes (`loadClosedBars`).
 */
export function evaluateDecisions(
  decisions: readonly Decision[],
  barsBySymbol: ReadonlyMap<string, HistoricalBar[]>,
  framework: Pick<EvaluationFramework, "reference" | "minRewardRisk"> = configuredFramework(),
  horizons: readonly number[] = SESSION_HORIZONS,
): DecisionEvaluation[] {
  const byId = new Map(decisions.map((d) => [d.id, d] as const));
  return decisions
    .filter((d): d is Decision & { ticker: string } => d.ticker != null && TRACKED_TYPES.includes(d.type))
    .map((d) => {
      const bars = barsBySymbol.get(d.ticker) ?? [];
      const reference = framework.reference[d.currency];
      const referenceBars = barsBySymbol.get(reference);
      const outcomes: Record<number, HorizonOutcome> = {};
      for (const h of horizons) {
        const ret = forwardReturn(bars, d.date, h);
        outcomes[h] = { ret, excess: ret ? excessReturn(ret, referenceBars) : null };
      }
      const plan = hasBuyPlan(d)
        ? buyPlan(d, d.related_id ? byId.get(d.related_id) : undefined, framework.minRewardRisk)
        : null;
      return {
        decision: d,
        reference,
        base: closeOnOrBefore(bars, d.date),
        horizons: outcomes,
        plan,
        excursion: plan ? excursion(bars, d.date, plan) : null,
      };
    });
}

// ─── Closed trades ───────────────────────────────────────────────────────────

export interface ClosedTrade {
  ticker: string;
  currency: Currency;
  /** Date of the lot's entry and of the exit that consumed its last units. */
  entryDate: string;
  exitDate: string;
  /** Origin and rules version of the entry (ADR-0009 §8), and the rules it broke. */
  origin: DecisionOrigin;
  rulesVersion: string;
  ruleViolations: string[];
  /** Initial stop of the lot; null if it was not recorded. */
  stop: number | null;
  /** Realized R net of costs (ADR-0009 §2), Σ(unitsᵢ / entry units) × Rᵢ; null without an initial stop below the entry. */
  rNet: number | null;
  /** Counts for the cutoff: system entry under C v1 (ADR-0009 §4). */
  counts: boolean;
  /** The exits that consumed the lot, in log order. */
  exits: Decision[];
}

/**
 * Units an exit sold: its `units`, which `decision:record` writes on every exit. `amount / price` is
 * only the fallback for an exit without it (written by hand), whose units are not exact.
 */
const exitUnits = (exit: Decision): number => exit.units ?? exit.amount! / exit.price!;

/**
 * Slack, in units, in the units an exit sold. None to speak of when it carries its `units` (float
 * noise); without them its amount is rounded to the cent, so they are only known to a cent of price.
 */
const exitSlack = (exit: Decision): number => (exit.units != null ? 1e-8 : 0.01 / exit.price! + 1e-9);

/** Tolerance of the units of a snapshot when it is compared with another by a split ratio: float noise. */
const SPLIT_UNITS_TOLERANCE = 1e-8;

/** Key of the lot an exit consumed: its entry id (ADR-0015: every lot has a real one). */
const lotKey = (exit: Decision): string => `${exit.currency}|${exit.ticker}|${exit.related_id}`;

/**
 * Closed trades from the exits alone (ADR-0015). A trade is one lot, and counts once: its R is
 * Σ(unitsᵢ / entry units) × Rᵢ over the exits of the lot, and it is closed when its last exit left
 * 0 units in the lot (`lot_units_left`, #52); a lot with units left is open. An exit without a lot
 * snapshot is not a measurable trade: there is no legacy path through `related_id`. It is left out
 * here and reported by `measureTrades`, as is a lot whose exits do not add up. Trades come in the
 * order their lots close.
 */
export function closedTrades(decisions: readonly Decision[]): ClosedTrade[] {
  return measureTrades(decisions).trades;
}

/** What the measurement left out, so the report can say it instead of dropping it silently. */
export interface UnmeasuredLots {
  /** Exits without a lot snapshot (or without its `lot_units_left`): not a measurable trade. */
  exitsWithoutSnapshot: SkippedExit[];
  /** Lots whose sales add up to more than their entry units (plus the rounding slack). */
  oversold: OversoldLot[];
  /** Lots whose exits do not add up: units left that do not follow the sales, or snapshots that disagree. */
  inconsistent: InconsistentLot[];
}

/** An exit the measurement skipped, named so a mis-keyed one stays visible among the legacy exits. */
export interface SkippedExit {
  currency: Currency;
  /** Absent when the exit has none (a malformed line). */
  ticker?: string;
  date: string;
  /** The entry id the exit cites, if it cites one. */
  lotId?: string;
}

export interface OversoldLot {
  currency: Currency;
  ticker: string;
  lotId: string;
}

/** Why the exits of a lot do not add up. */
export type InconsistentLotReason = "units_left" | "snapshot";

export interface InconsistentLot {
  currency: Currency;
  ticker: string;
  lotId: string;
  reason: InconsistentLotReason;
}

export interface MeasuredTrades {
  trades: ClosedTrade[];
  unmeasured: UnmeasuredLots;
}

/** What `measureTrades` decides about the exits of one lot. */
type LotVerdict = "closed" | "open" | "oversold" | InconsistentLotReason;

/**
 * `closedTrades` plus what it left out, so the report can say it: the exits without a lot snapshot
 * (named), the oversold lots and the lots whose exits do not add up (named). Everything else is
 * measured or, while it has units left, open.
 */
export function measureTrades(decisions: readonly Decision[]): MeasuredTrades {
  const unmeasured: UnmeasuredLots = { exitsWithoutSnapshot: [], oversold: [], inconsistent: [] };
  const byLot = new Map<string, { exits: LotExit[]; last: number }>();
  decisions.forEach((d, index) => {
    if (d.type !== "exit") return;
    if (!hasLotSnapshot(d)) {
      unmeasured.exitsWithoutSnapshot.push({
        currency: d.currency,
        ...(d.ticker ? { ticker: d.ticker } : {}),
        date: d.date,
        ...(d.related_id ? { lotId: d.related_id } : {}),
      });
      return;
    }
    const lot = byLot.get(lotKey(d)) ?? { exits: [], last: index };
    lot.exits.push(d);
    lot.last = index;
    byLot.set(lotKey(d), lot);
  });

  // Each lot is judged once: closed (measured), open (not yet a trade) or not measured, with the reason.
  const closed: { exits: LotExit[]; last: number }[] = [];
  for (const lot of byLot.values()) {
    const verdict = judgeLot(lot.exits);
    const { currency, ticker, related_id: lotId } = lot.exits[0];
    if (verdict === "closed") closed.push({ exits: [...lot.exits].sort(byDate), last: lot.last });
    else if (verdict === "oversold") unmeasured.oversold.push({ currency, ticker, lotId });
    else if (verdict !== "open") unmeasured.inconsistent.push({ currency, ticker, lotId, reason: verdict });
  }

  const trades = closed
    .sort((a, b) => a.last - b.last)
    .map(({ exits }) => {
      const first = exits[0];
      return {
        ticker: first.ticker,
        currency: first.currency,
        entryDate: first.entry_date!,
        exitDate: exits[exits.length - 1].date,
        origin: first.entry_origin!,
        rulesVersion: first.entry_rules_version!,
        ruleViolations: first.rule_violations ?? [],
        stop: first.stop_initial ?? null,
        rNet: tradeR(exits),
        counts: first.entry_origin === "sistema" && isCv1(first.entry_rules_version!),
        exits,
      };
    });
  return { trades, unmeasured };
}

/** Stable: exits of the same day keep the order they came in. */
const byDate = (a: Decision, b: Decision): number => a.date.localeCompare(b.date);

/**
 * Judges the exits of one lot. `lot_units_left` is the lot's running balance, written in the order the
 * sales were recorded, which a backdated sale breaks from date order (and the decision history is in
 * date order). The balance only ever falls, so the exits are followed from the highest balance to the
 * lowest, which is the order they were written in whatever their dates. They must agree on the snapshot of the lot, must not
 * sell more than it had, and each must take `lot_units_left` down by the units it sold (within cent
 * rounding); then the lot is closed when its last exit left 0 and open otherwise.
 *
 * A split corrected in `Lots` between two exits scales the snapshot of the later ones: `entry_units` × r,
 * `entry_price` and `stop_initial` ÷ r, by one common ratio (the rule of `lots-check`). Exits whose
 * snapshot differs from the first only by such a ratio still agree; their units and `lot_units_left`
 * are rescaled by 1 / r to the scale of the first before the checks. Any other difference disagrees.
 */
function judgeLot(written: readonly LotExit[]): LotVerdict {
  const reference = written[0];
  const shape = (e: Decision) => ({ units: e.entry_units!, price: e.entry_price!, stop: e.stop_initial });
  const violations = (e: Decision) => [...(e.rule_violations ?? [])].sort().join(",");
  // The scale of each exit's units against the reference's: 1 for an identical snapshot, r for a split of it.
  const scaleOf = (e: LotExit): number | null =>
    e.entry_price === reference.entry_price &&
    e.entry_units === reference.entry_units &&
    e.stop_initial === reference.stop_initial
      ? 1
      : splitRatio(shape(e), shape(reference), SPLIT_UNITS_TOLERANCE);
  const agrees = (e: Decision) =>
    e.entry_date === reference.entry_date &&
    e.entry_origin === reference.entry_origin &&
    e.entry_rules_version === reference.entry_rules_version &&
    violations(e) === violations(reference);

  const scaled: { units: number; left: number; slack: number }[] = [];
  for (const e of written) {
    const r = scaleOf(e);
    if (r === null || !agrees(e)) return "snapshot";
    scaled.push({
      units: exitUnits(e) / r,
      left: e.lot_units_left === 0 ? 0 : e.lot_units_left / r,
      slack: exitSlack(e) / r,
    });
  }
  const exits = scaled.sort((a, b) => b.left - a.left);

  // Selling more than the lot is inconsistent data (a wrong entry_units, or exits of another lot):
  // not measured, not inflated, and reported.
  const sold = exits.reduce((sum, e) => sum + e.units, 0);
  const slack = exits.reduce((sum, e) => sum + e.slack, 0);
  if (sold > reference.entry_units! + slack) return "oversold";

  let before = reference.entry_units!;
  for (const e of exits) {
    if (Math.abs(before - e.left - e.units) > e.slack) return "units_left";
    before = e.left;
  }
  return before === 0 ? "closed" : "open";
}

/** An exit that names its lot (ticker and entry id), so it can be reported by name. */
type LotExit = Decision & { ticker: string; related_id: string; lot_units_left: number };

/** The exit carries what a measurement needs of its lot, including the units the lot has left. */
const hasLotSnapshot = (exit: Decision): exit is LotExit =>
  !!exit.ticker &&
  !!exit.related_id &&
  exit.entry_price != null &&
  exit.entry_units != null &&
  !!exit.entry_date &&
  exit.entry_origin != null &&
  !!exit.entry_rules_version &&
  exit.lot_units_left != null &&
  exit.price != null &&
  !!exit.amount;

/** R of a lot: its exits weighted by the units they sold; null if any of them has no R. */
function tradeR(exits: readonly Decision[]): number | null {
  let total = 0;
  for (const exit of exits) {
    const r = realizedR(exit);
    if (r == null) return null;
    total += (exitUnits(exit) / exit.entry_units!) * r;
  }
  return total;
}

/**
 * Net R of one exit, from the exit alone: (exit − entry − costs per unit) / (entry − initial stop).
 * Costs per unit are this exit's share of the lot's entry costs (`entry_costs`, pro rata to the
 * units sold) spread over the units it sold and, if any, the sale's own.
 */
export function realizedR(exit: Decision): number | null {
  const { entry_price: entryPrice, entry_units: entryUnits, stop_initial: stop, price: exitPrice } = exit;
  if (stop == null || entryPrice == null || !entryUnits || exitPrice == null || !exit.amount || !(stop < entryPrice)) {
    return null;
  }
  const costPerUnit = ((exit.entry_costs ?? 0) + (exit.costs ?? 0)) / exitUnits(exit);
  return (exitPrice - entryPrice - costPerUnit) / (entryPrice - stop);
}

// ─── Aggregates ──────────────────────────────────────────────────────────────

export interface TradeStats {
  total: number;
  /** With an initial stop: the only ones in the expectancy. */
  withR: number;
  expectancy: number | null;
  winners: number;
}

export function tradeStats(trades: readonly ClosedTrade[]): TradeStats {
  const rs = trades.map((t) => t.rNet).filter((r): r is number => r != null);
  return { total: trades.length, withR: rs.length, expectancy: mean(rs), winners: rs.filter((r) => r > 0).length };
}

export interface HorizonStats {
  /** Horizon completed: the only ones in the averages. */
  complete: number;
  meanReturn: number | null;
  meanExcess: number | null;
}

export interface GroupStats {
  total: number;
  horizons: Record<number, HorizonStats>;
  /** With plan R: they touched stop or target, or completed the window. */
  withResult: number;
  targetFirst: number;
  stopFirst: number;
  targetAfterStop: number;
  meanResultR: number | null;
}

/**
 * Aggregates a group of decisions. It only counts completed horizons:
 * averaging a +3% at 5 sessions with a +3% at 60 would mix horizons.
 */
export function groupStats(
  evals: readonly DecisionEvaluation[],
  horizons: readonly number[] = SESSION_HORIZONS,
): GroupStats {
  const byHorizon: Record<number, HorizonStats> = {};
  for (const h of horizons) {
    const complete = evals.map((e) => e.horizons[h]).filter((o) => o?.ret != null && !o.ret.partial);
    byHorizon[h] = {
      complete: complete.length,
      meanReturn: mean(complete.map((o) => o.ret!.pct)),
      meanExcess: mean(complete.map((o) => o.excess).filter((x): x is number => x != null)),
    };
  }
  const excursions = evals.map((e) => e.excursion).filter((x): x is Excursion => x != null);
  const results = excursions.map((x) => x.resultR).filter((r): r is number => r != null);
  return {
    total: evals.length,
    horizons: byHorizon,
    withResult: results.length,
    targetFirst: excursions.filter((x) => x.first === "target").length,
    stopFirst: excursions.filter((x) => x.first === "stop").length,
    targetAfterStop: excursions.filter((x) => x.targetAfterStop).length,
    meanResultR: mean(results),
  };
}

export interface Group<T> {
  label: string;
  items: T[];
}

export interface Grouping {
  title: string;
  /** What it groups and what question it answers. */
  note: string;
  groups: Group<DecisionEvaluation>[];
}

/** Origin and rule breaks of a decision or, in a closed trade, of its lot's entry. */
interface OriginAndRules {
  origin: DecisionOrigin;
  breaks: boolean;
}

const ofDecision = (d: Decision): OriginAndRules => ({
  origin: d.origin,
  breaks: (d.rule_violations?.length ?? 0) > 0,
});

const ofTrade = (t: ClosedTrade): OriginAndRules => ({ origin: t.origin, breaks: t.ruleViolations.length > 0 });

/** Origin (ADR-0009 §8) by whether it breaks a rule. */
function byOriginAndRules<T>(items: readonly T[], traitsOf: (item: T) => OriginAndRules, m: Messages): Group<T>[] {
  return (["sistema", "propietario"] as const).flatMap((origin) =>
    [false, true].map((broke) => ({
      label: m.evaluation.groupings.originRules(origin === "sistema", broke),
      items: items.filter((i) => traitsOf(i).origin === origin && traitsOf(i).breaks === broke),
    })),
  );
}

/** Buy blocks with (or without) `regime_adverse` among their reasons. */
function blockedByRegime(evals: readonly DecisionEvaluation[], byRegime: boolean): DecisionEvaluation[] {
  return evals.filter(
    (e) =>
      e.decision.type === "buy_blocked" &&
      (e.decision.eligibility?.reasons.includes("regime_adverse") ?? false) === byRegime,
  );
}

export function decisionGroupings(evals: readonly DecisionEvaluation[], m: Messages = messages()): Grouping[] {
  const t = m.evaluation.groupings;
  const ofType = (...types: DecisionType[]) => evals.filter((e) => types.includes(e.decision.type));
  const buys = ofType("buy_proposal", "buy_blocked");
  const planned = ofType("buy_proposal", "buy_blocked", "entry");
  const versions = [...new Set(planned.map((e) => e.decision.rules_version))].sort(compareVersions);

  return [
    {
      title: t.entriesTitle,
      note: t.entriesNote,
      groups: byOriginAndRules(ofType("entry"), (e) => ofDecision(e.decision), m),
    },
    {
      title: t.convictionTitle,
      note: t.convictionNote,
      groups: [
        ...CONVICTIONS.map((c) => ({
          label: c,
          items: buys.filter((e) => hasEngineConviction(e.decision) && e.decision.conviction === c),
        })),
        { label: t.noEngineConviction, items: buys.filter((e) => !hasEngineConviction(e.decision)) },
      ],
    },
    {
      title: t.eligibleTitle,
      note: t.eligibleNote,
      groups: [
        { label: t.proposals, items: ofType("buy_proposal") },
        {
          label: t.eligibleNotProposed,
          items: evals.filter((e) => e.decision.type === "hold" && e.decision.eligibility?.verdict === "eligible"),
        },
        // Disjoint on purpose: with regime blocks inside the total of blocks, the
        // control row would contain the one being measured and the two
        // medians would not be comparable.
        { label: t.blockedByRegime, items: blockedByRegime(evals, true) },
        { label: t.blockedOther, items: blockedByRegime(evals, false) },
      ],
    },
    {
      title: t.screeningTitle,
      note: t.screeningNote,
      groups: [
        { label: t.interesting, items: ofType("screen_interesting") },
        { label: t.rejected, items: ofType("screen_rejected") },
      ],
    },
    {
      title: t.screeningConvictionTitle,
      note: t.screeningConvictionNote,
      groups: CONVICTIONS.map((c) => ({
        label: c,
        items: ofType("screen_interesting").filter(
          (e) =>
            e.decision.conviction === c && compareVersions(e.decision.rules_version, CONVICTION_RUBRIC_VERSION) >= 0,
        ),
      })),
    },
    {
      title: t.rankingTitle,
      note: t.rankingNote,
      groups: [
        {
          label: t.ranking,
          items: ofType("screen_interesting", "screen_rejected").filter(
            (e) => e.decision.rank != null && !e.decision.exploration,
          ),
        },
        {
          label: t.exploration,
          items: ofType("screen_interesting", "screen_rejected").filter((e) => e.decision.exploration === true),
        },
      ],
    },
    {
      title: t.versionTitle,
      note: t.versionNote,
      groups: versions.map((v) => ({ label: v, items: planned.filter((e) => e.decision.rules_version === v) })),
    },
  ];
}

/** Closed trades: the cutoff counter and the origin by rules. */
export function tradeGroupings(trades: readonly ClosedTrade[], m: Messages = messages()): Group<ClosedTrade>[] {
  return [
    { label: m.evaluation.groupings.cutCounter, items: trades.filter((t) => t.counts) },
    ...byOriginAndRules(trades, ofTrade, m),
  ];
}

/** The engine computed the conviction if it carries the points behind it. */
const hasEngineConviction = (d: Decision) => d.conviction != null && d.conviction_points != null;

/** First rules version in which the engine computes the screening conviction. */
const CONVICTION_RUBRIC_VERSION = "0.8";

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ─── Cutoff criterion table ──────────────────────────────────────────────────

/**
 * One warning of the board, as data: the renderer puts it into words (in its language), and the
 * run prints the same words to the console. The silo reconstruction warnings are data too, held only here.
 */
export type BoardWarning =
  | { kind: "reconstruction"; warnings: SiloWarning[] }
  | { kind: "exitsWithoutSnapshot"; exits: SkippedExit[] }
  | { kind: "oversoldLots"; lots: OversoldLot[] }
  | { kind: "inconsistentLots"; lots: InconsistentLot[] };

/** A lot still held, the open half of a trade (ADR-0015): read from `Lots`, never from the log. */
export interface OpenTrade {
  currency: Currency;
  ticker: string;
  /** Id of the entry that opened the lot. */
  entryId: string;
  entryDate: string;
  /** Units still open. */
  units: number;
  origin: DecisionOrigin;
  rulesVersion: string;
  ruleViolations: string[];
}

/** Open trades of the silos' `Lots`: those that count for the cutoff (system, C v1). */
export function openTrades(portfolios: Record<Currency, PortfolioSnapshot>): OpenTrade[] {
  return CURRENCIES.flatMap((currency) =>
    portfolios[currency].lots
      .filter((lot) => countsForCutoff(lot.origin, lot.rulesVersion))
      .map((lot) => ({
        currency,
        ticker: lot.ticker,
        entryId: lot.entryId,
        entryDate: lot.date,
        units: lot.units,
        origin: lot.origin,
        rulesVersion: lot.rulesVersion,
        ruleViolations: lot.rulesViolations,
      })),
  );
}

/** A trade counts for the cutoff when it is a system one under C v1 (ADR-0009 §4). */
const countsForCutoff = (origin: DecisionOrigin, rulesVersion: string): boolean =>
  origin === "sistema" && isCv1(rulesVersion);

export interface CutBoard {
  /** Rules version in force (strategies/base.md). */
  rulesVersion: string;
  /** Date of the first entry under C v1; null while the counter has not started. */
  counterStart: string | null;
  /** Since when portfolios and drawdown are measured: the counter start or, in rehearsal, the log's. */
  measuredFrom: string | null;
  /** Closed trades that count for the cutoff. */
  trades: TradeStats;
  /** System trades under C v1 still open: one per lot in `Lots`, a lot sold in part included. */
  open: OpenTrade[];
  silos: SiloPerformance[];
  /** What the report flags, the only warnings channel: silo reconstruction and the unmeasured exits and lots. */
  warnings: BoardWarning[];
  /** The two real portfolios and the two shadows, in EUR at the day's rate. */
  totalEur: { real: number; shadow: number } | null;
  framework: EvaluationFramework;
}

/**
 * The counter starts with the first entry under C v1 (ADR-0009 §4). The entry line may be archived,
 * so the start is the earliest date among the entry lines still read, the `entry_date` of the
 * snapshots of the exits and the `Date` of the lots, all of a system entry under C v1.
 */
export function counterStart(decisions: readonly Decision[], lots: readonly Lot[] = []): string | null {
  const dates = [
    ...decisions.filter((d) => d.type === "entry" && countsForCutoff(d.origin, d.rules_version)).map((d) => d.date),
    ...decisions
      .filter(
        (d) =>
          d.type === "exit" &&
          d.entry_date != null &&
          d.entry_origin != null &&
          d.entry_rules_version != null &&
          countsForCutoff(d.entry_origin, d.entry_rules_version),
      )
      .map((d) => d.entry_date!),
    ...lots.filter((l) => countsForCutoff(l.origin, l.rulesVersion)).map((l) => l.date),
  ];
  return dates.sort()[0] ?? null;
}

export interface EvaluationInput {
  decisions: readonly Decision[];
  /** Today's state of each silo per portfolio.md. */
  portfolios: Record<Currency, PortfolioSnapshot>;
  bars: ReadonlyMap<string, HistoricalBar[]>;
  asOf: string;
  rulesVersion: string;
  /** Dollars per euro at the last close; null if there is no rate. */
  eurUsd: number | null;
  framework?: EvaluationFramework;
}

/**
 * While C v1 is being built, portfolios and drawdown are measured in
 * rehearsal from the first decision in the log: so the reconstruction is
 * tested before it counts, and does not start on counter day never seen before.
 */
export function buildCutBoard(
  input: EvaluationInput,
  measured: MeasuredTrades = measureTrades(input.decisions),
): CutBoard {
  const { trades, unmeasured } = measured;
  const framework = input.framework ?? configuredFramework();
  const start = counterStart(
    input.decisions,
    CURRENCIES.flatMap((c) => input.portfolios[c].lots),
  );
  const measuredFrom = start ?? input.decisions.map((d) => d.date).sort()[0] ?? null;
  const measurements =
    measuredFrom == null
      ? []
      : CURRENCIES.map((currency) =>
          siloPerformance({
            currency,
            portfolio: input.portfolios[currency],
            decisions: input.decisions,
            start: measuredFrom,
            asOf: input.asOf,
            bars: input.bars,
            reference: framework.reference[currency],
          }),
        );

  const silos = measurements.map((x) => x.performance);
  const eur = silos.find((s) => s.currency === "EUR");
  const usd = silos.find((s) => s.currency === "USD");
  const rate = input.eurUsd;
  const totalEur =
    eur?.shadow != null && usd?.shadow != null && rate != null && rate > 0
      ? { real: eur.real + usd.real / rate, shadow: eur.shadow + usd.shadow / rate }
      : null;

  const siloWarnings = measurements.flatMap((x) => x.warnings);
  const warnings: BoardWarning[] = [];
  if (siloWarnings.length > 0) warnings.push({ kind: "reconstruction", warnings: siloWarnings });
  if (unmeasured.exitsWithoutSnapshot.length > 0) {
    warnings.push({ kind: "exitsWithoutSnapshot", exits: unmeasured.exitsWithoutSnapshot });
  }
  if (unmeasured.oversold.length > 0) warnings.push({ kind: "oversoldLots", lots: unmeasured.oversold });
  if (unmeasured.inconsistent.length > 0) warnings.push({ kind: "inconsistentLots", lots: unmeasured.inconsistent });

  return {
    rulesVersion: input.rulesVersion,
    counterStart: start,
    measuredFrom,
    trades: tradeStats(trades.filter((t) => t.counts)),
    open: openTrades(input.portfolios),
    silos,
    warnings,
    totalEur,
    framework,
  };
}

export interface EvaluationReport {
  asOf: string;
  decisions: number;
  /** Dates of the first and the last decision. */
  span: [string, string] | null;
  board: CutBoard;
  evaluations: DecisionEvaluation[];
  trades: ClosedTrade[];
}

export function buildEvaluationReport(input: EvaluationInput): EvaluationReport {
  const measured = measureTrades(input.decisions);
  const dates = input.decisions.map((d) => d.date).sort();
  return {
    asOf: input.asOf,
    decisions: input.decisions.length,
    span: dates.length > 0 ? [dates[0], dates[dates.length - 1]] : null,
    board: buildCutBoard(input, measured),
    evaluations: evaluateDecisions(input.decisions, input.bars, input.framework ?? configuredFramework()),
    trades: measured.trades,
  };
}

/** Symbols to download: every asset in the log and in portfolio.md, and each silo's benchmark. */
export function evaluationSymbols(
  decisions: readonly Decision[],
  portfolios: Record<Currency, PortfolioSnapshot>,
  framework: Pick<EvaluationFramework, "reference"> = configuredFramework(),
): string[] {
  return [
    ...new Set([
      ...decisions.map((d) => d.ticker).filter((t): t is string => t != null),
      ...CURRENCIES.flatMap((c) => portfolios[c].positions.map((p) => p.ticker)),
      ...CURRENCIES.map((c) => framework.reference[c]),
    ]),
  ];
}
