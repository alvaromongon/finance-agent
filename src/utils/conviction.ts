// Engine conviction (ADR-0012 §7): a points rubric computed by the engine, not
// the reasoner. Used by the screening, with the `prepare` day's data,
// and by the heartbeat setups, with the setup day's.
import { messages, type Messages } from "../i18n/index.js";
import { config } from "../config.js";
import type { Decision } from "../decisions.js";
import type { Conviction, ConvictionPoint, EngineConviction, MarketRegime } from "../types.js";
import type { Ticker } from "../ticker.js";

/** What the rubric scores: three engine data points and one from the reasoner. */
export interface ConvictionRubric {
  /** Place in its silo's top fraction (ADR-0012). */
  topQuintile: boolean;
  /** Silo regime on the date. */
  regime?: MarketRegime;
  /** Net R:R of the engine ticket; absent without a setup (ADR-0013). */
  rewardRisk?: number;
  /** Concrete, dated catalyst from the screening reasoner; null if unknown. */
  nextCatalyst: string | null;
}

type ConvictionRules = typeof config.framework.screening.conviction;

/**
 * Conviction with the points behind it: one point per condition, high with
 * `rules.high` points or more, medium with `rules.medium` and low otherwise.
 */
export function scoreConviction(
  rubric: ConvictionRubric,
  rules: ConvictionRules = config.framework.screening.conviction,
): EngineConviction {
  const points: ConvictionPoint[] = [
    rubric.topQuintile ? ("top_quintile" as const) : null,
    rubric.regime === "favorable" ? ("regime_favorable" as const) : null,
    rubric.rewardRisk != null && rubric.rewardRisk >= rules.minRewardRisk ? ("reward_risk" as const) : null,
    rubric.nextCatalyst ? ("dated_catalyst" as const) : null,
  ].filter((p) => p != null);
  return { conviction: level(points.length, rules), points };
}

function level(points: number, rules: ConvictionRules): Conviction {
  return points >= rules.high ? "high" : points >= rules.medium ? "medium" : "low";
}

/** Label of a point for emails and logs. */
export function convictionPointLabel(
  point: ConvictionPoint,
  m: Messages = messages(),
  rules: ConvictionRules = config.framework.screening.conviction,
): string {
  return m.conviction.points(rules.minRewardRisk)[point];
}

/** "medium (top quintile, R:R ≥ 3)": the conviction and its points. */
export function describeConviction(c: EngineConviction, m: Messages = messages()): string {
  return c.points.length > 0
    ? `${c.conviction} (${c.points.map((p) => convictionPointLabel(p, m)).join(", ")})`
    : c.conviction;
}

/** The ticker's last `screen_interesting` up to `date`: the one that put (or kept) it in the watchlist. */
export function latestScreening(history: readonly Decision[], ticker: Ticker, date: string): Decision | undefined {
  return history
    .filter((d) => d.type === "screen_interesting" && d.ticker === ticker && d.date <= date)
    .reduce<Decision | undefined>((last, d) => (last && last.date > d.date ? last : d), undefined);
}

/** Points only the screening knows: the silo ranking and the reasoner's catalyst. */
const FROM_SCREENING: readonly ConvictionPoint[] = ["top_quintile", "dated_catalyst"];

/**
 * Conviction of a heartbeat setup: the same rubric as the screening,
 * with the setup day's regime and R:R. The quintile and the catalyst are
 * inherited from the last screening that found it interesting; without one
 * with engine points (added by hand, or older ones) they do not score.
 */
export function setupConviction(input: {
  screening?: Decision;
  regime?: MarketRegime;
  rewardRisk?: number;
}): EngineConviction {
  const inherited = (input.screening?.conviction_points ?? []).filter((p) => FROM_SCREENING.includes(p));
  return scoreConviction({
    topQuintile: inherited.includes("top_quintile"),
    regime: input.regime,
    rewardRisk: input.rewardRisk,
    nextCatalyst: inherited.includes("dated_catalyst") ? "screening" : null,
  });
}
