// Re-analysis cooldown: decides whether a ticker with a signal should be
// skipped because it was recently analyzed for the same trigger and the price
// did not move enough. Pure functions, no I/O, so they can be unit-tested.
import { extractFrontmatter } from "./vault-parser.js";
import type { TriggerKind } from "../types.js";

export interface LastLog {
  price: number;
  triggers: TriggerKind[];
}

/**
 * Extracts `price` and `triggers` from a Markdown decision log's frontmatter. The body
 * is localized output: the engine does not read it back.
 */
export function parseLastLog(content: string): LastLog | null {
  const fm = extractFrontmatter(content);
  const price = typeof fm?.price === "number" ? fm.price : null;
  // price <= 0 is not a real market price (e.g. HOLD logs without a ticket)
  // and would divide by zero in shouldSkipReanalysis; it is treated as "no
  // usable price" so getLastLogForTicker keeps looking in earlier logs.
  if (price == null || price <= 0) return null;

  const triggers = Array.isArray(fm?.triggers) ? (fm.triggers.map(String) as TriggerKind[]) : [];

  return { price, triggers };
}

/**
 * `true` if the re-analysis must be skipped: there is a previous log with at
 * least one trigger in common and the price has not moved ≥
 * reanalysisPriceDeltaPct. Triggers from old logs that no longer exist
 * (`buy_zone`, `support_break`, removed) match none of the current ones.
 */
export function shouldSkipReanalysis(input: {
  currentTriggers: TriggerKind[];
  currentPrice: number;
  lastLog: LastLog | null;
  reanalysisPriceDeltaPct: number;
}): boolean {
  const { currentTriggers, currentPrice, lastLog, reanalysisPriceDeltaPct } = input;
  if (!lastLog) return false;

  const sameTrigger = currentTriggers.some((t) => lastLog.triggers.includes(t));
  if (!sameTrigger) return false;

  const deltaPct = (Math.abs(currentPrice - lastLog.price) / lastLog.price) * 100;
  return deltaPct < reanalysisPriceDeltaPct;
}
