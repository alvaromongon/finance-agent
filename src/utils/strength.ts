// Capture of technical strength at decision time (ADR-0006).
// It lives apart from index.ts so it can be tested with a fake provider:
// index.ts runs main() on import.
import { computeTechnicals, targetLevels, type Technicals } from "./technicals.js";
import type { HistoricalBar } from "../providers/types.js";
import type { Signal, StrengthSnapshot } from "../types.js";

/**
 * Strength snapshot from the already computed technicals. Shared by the
 * heartbeat, the screening and the Monday Briefing so all three record the
 * same. `undefined` if the yearly range is degenerate (52w High == Low):
 * better not to record it than to write "NaN" in a log.
 */
export function snapshotFromTechnicals(t: Technicals): StrengthSnapshot | undefined {
  if (!Number.isFinite(t.rangePosition)) return undefined;
  return {
    // Clamped to [0,1]: the price is today's and the yearly high/low comes from
    // bars that may lag a day, so a new high gives 1.02. What matters is "it
    // is at the top of its range".
    rangePosition: Math.min(1, Math.max(0, t.rangePosition)),
    bias: t.bias,
    // ATR14 to size the stop in multiples of ATR.
    ...(t.atr14 != null && t.atr14 > 0 ? { atr14: t.atr14 } : {}),
    // Levels to anchor a BUY target to.
    levels: targetLevels(t),
  };
}

export interface HistoricalSource {
  getHistorical?(ticker: string, range?: string): Promise<HistoricalBar[]>;
}

/**
 * Annotates `strength` on each signal so it is recorded in the Markdown decision log
 * and in the decision log (ADR-0006), where the outcome is crossed
 * with the trend state at entry.
 *
 * History is only downloaded for tickers that have **already** escalated
 * (usually 0-2 per run), so it does not break the heartbeat's "cheap layer"
 * principle.
 *
 * Best-effort by design: if the provider does not expose getHistorical, fails,
 * or returns data from which no usable range position can be computed, the
 * signal goes on without `strength`. Losing the instrumentation must never
 * cost a risk alert.
 */
export async function attachStrength(
  signals: Signal[],
  provider: HistoricalSource,
  log: (msg: string) => void = console.warn,
): Promise<void> {
  if (!provider.getHistorical) return;

  for (const signal of signals) {
    // Setup signals already arrive with the snapshot from the setups step.
    if (signal.strength) continue;
    try {
      const bars = await provider.getHistorical(signal.ticker, "1y");
      if (bars.length === 0) {
        log(`[finance-agent] ${signal.ticker}: no history, strength not recorded`);
        continue;
      }

      const strength = snapshotFromTechnicals(computeTechnicals(bars, signal.price));
      if (!strength) {
        log(`[finance-agent] ${signal.ticker}: degenerate yearly range, strength not recorded`);
        continue;
      }
      signal.strength = strength;
    } catch (err) {
      log(
        `[finance-agent] ${signal.ticker}: no technical strength (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
}
