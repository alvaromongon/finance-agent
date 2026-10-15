// Entry eligibility filter (ADR-0010).
//
// A setup (ADR-0013) says WHEN to enter; this filter says when NOT to, with the
// day's asset and market state. It applies to every setup before escalating
// it to the reasoner.
//
// Deterministic and not delegated to the LLM, for the same reason as
// computeAssetClassWeights: a check with real money must not depend on the
// model redoing the arithmetic right on the raw tables.
//
// The cases behind the asset rules are in ADR-0010:
//   - an entry several ATR below a falling SMA50, in an active correction;
//   - a proposal with a bearish bias (price < SMA50 < SMA200).
// With a mixed bias the trend rule alone does not stop the first case, and the
// momentum rule does not stop the second. They cover different gaps and apply
// together.
//
// The regime rule looks at the silo, not the asset: with an
// `adverso` market regime (see market-regime.ts) no new entry is eligible.
import { regimeBlockReasons } from "./market-regime.js";
import type { Technicals } from "./technicals.js";
import type { MarketRegime } from "../types.js";

export type EntryBlockReason = "trend_bearish" | "momentum_below_sma50" | "regime_adverse";

export interface EntryEligibility {
  verdict: "eligible" | "blocked";
  reasons: EntryBlockReason[];
  /** (price - SMA50) / ATR14. Negative = below the average. */
  sma50DistanceAtr: number | null;
}

/**
 * Momentum limit: below -1.5 ATR from the SMA50 the price is not pulling back
 * to the average, it is in an active correction. The threshold is in ATR and
 * not in percent on purpose: -5% is daily noise for a security with a 4.8%
 * ATR and a serious drop for one with 2.2%.
 */
export const MOMENTUM_ATR_LIMIT = -1.5;

/**
 * Evaluates whether the asset is buyable TODAY. `regime` is the entry silo's;
 * without it, the regime rule does not block.
 */
export function evaluateEntryEligibility(technicals: Technicals, regime?: MarketRegime): EntryEligibility {
  const { currentPrice, sma50, atr14, bias } = technicals;
  const sma50DistanceAtr = sma50 != null && atr14 != null && atr14 > 0 ? (currentPrice - sma50) / atr14 : null;

  const reasons: EntryBlockReason[] = [];
  if (bias === "BAJISTA") reasons.push("trend_bearish");
  if (sma50DistanceAtr != null && sma50DistanceAtr < MOMENTUM_ATR_LIMIT) {
    reasons.push("momentum_below_sma50");
  }
  reasons.push(...regimeBlockReasons(regime));

  return { verdict: reasons.length > 0 ? "blocked" : "eligible", reasons, sma50DistanceAtr };
}
