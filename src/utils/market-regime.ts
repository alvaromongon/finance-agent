// Market regime per silo (ADR-0010).
//
// A macro shock can fire several stops the same day, something no individual
// thesis could foresee. With a weak market there
// are fewer good entries and holding cash is right, so the regime is one more
// eligibility rule: in `adverso` every new entry is blocked with
// `regime_adverse`. Exits and stops do not change.
//
// Only with the silo benchmark (ADR-0009 §1), no universe breadth or VIX: the
// regime is evaluated daily and breadth depended on the weekly ranking. It
// travels inside `Benchmark`, which already reaches the briefing, the
// screening and the heartbeat; without benchmark history there is no regime
// and nothing is blocked.
import { messages, type Messages } from "../i18n/index.js";
import { config } from "../config.js";
import { sma } from "./technicals.js";
import { CURRENCIES } from "../types.js";
import type { Benchmark, Currency, MarketRegime } from "../types.js";

/**
 * - `favorable`: benchmark > SMA200 and SMA50 rising (higher than
 *   `slopeSessions` sessions ago).
 * - `adverso` (adverse): benchmark < SMA200.
 * - `neutral`: the rest.
 *
 * `null` if the history does not reach the SMA200 or the SMA50 slope.
 */
export function classifyRegime(
  closes: readonly number[],
  price: number,
  slopeSessions: number = config.framework.regime.sma50SlopeSessions,
): MarketRegime | null {
  // A non-positive `slopeSessions` would leave the slope without a window and
  // the regime without data, which here means "does not block": a rule
  // silently disabled by a wrong parameter. Better loud: the caller is
  // best-effort and logs it as "no regime for <ticker>".
  if (!Number.isInteger(slopeSessions) || slopeSessions <= 0) {
    throw new Error(`framework.regime.sma50SlopeSessions must be an integer > 0; got: ${slopeSessions}`);
  }
  const values = [...closes];
  const sma200 = sma(values, 200);
  const sma50 = sma(values, 50);
  const sma50Before = sma(values.slice(0, -slopeSessions), 50);
  if (sma200 == null || sma50 == null || sma50Before == null) return null;
  if (price < sma200) return "adverso";
  if (price > sma200 && sma50 > sma50Before) return "favorable";
  return "neutral";
}

/**
 * Regime block reason. It lives here, with the rule, because entries that do
 * not go through the zone apply it too (the heartbeat BUY, via
 * `utils/sizing.ts`), not only `utils/entry-eligibility.ts`.
 */
export function regimeBlockReasons(regime: MarketRegime | undefined): "regime_adverse"[] {
  return regime === "adverso" ? ["regime_adverse"] : [];
}

/** Regime of a benchmark with its effect; "no data" if it could not be computed. */
export function describeRegime(benchmark: Benchmark | undefined, m: Messages = messages()): string {
  return benchmark?.regime ? m.regime.effects[benchmark.regime] : m.regime.noData;
}

/** One line per silo for the briefing context and the screening email. */
export function formatRegimeLines(
  benchmarks: Partial<Record<Currency, Benchmark>>,
  m: Messages = messages(),
): string[] {
  return CURRENCIES.map((currency) => {
    const b = benchmarks[currency];
    const ref = b ? ` (${b.ticker})` : "";
    return m.regime.line(currency, ref, describeRegime(b, m));
  });
}
