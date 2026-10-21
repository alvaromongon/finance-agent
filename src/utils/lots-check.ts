// Cross-check of the open lots of portfolio.md against the decision log (ADR-0015). Pure: the
// callers read both and decide what a mismatch means (the evaluation and `decision:record` refuse
// the file, the heartbeat warns and keeps watching the positions).
import type { Decision } from "../decisions.js";
import type { PortfolioSnapshot } from "../types.js";

/** Units are fractions: below this the difference is float noise, not a mismatch. */
const UNITS_TOLERANCE = 1e-8;

/**
 * Problems of a silo's `Lots`, one message per problem, empty if it is consistent:
 *
 * - a lot whose entry id is not an `entry` of that silo in the log, so its ticker is unknown;
 * - a ticker whose `Volume` is not the sum of the units of its lots. The table has no ticker
 *   column: the lot's entry says which position it belongs to.
 */
export function lotsMismatches(portfolio: PortfolioSnapshot, decisions: readonly Decision[]): string[] {
  const where = `portfolio.md (${portfolio.currency})`;
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const problems: string[] = [];
  const lotUnits = new Map<string, number>();

  for (const lot of portfolio.lots) {
    const decision = byId.get(lot.entryId);
    if (!decision) {
      problems.push(`${where}: lot ${lot.entryId} is not in the decision log (logs/decisions.jsonl)`);
    } else if (decision.type !== "entry" || decision.ticker == null) {
      problems.push(`${where}: lot ${lot.entryId} is a ${decision.type} in the decision log, not an entry`);
    } else if (decision.currency !== portfolio.currency) {
      problems.push(
        `${where}: lot ${lot.entryId} is an entry of ${decision.ticker} recorded in ${decision.currency}, not ${portfolio.currency}`,
      );
    } else {
      lotUnits.set(decision.ticker, (lotUnits.get(decision.ticker) ?? 0) + lot.units);
    }
  }

  const volumes = new Map<string, number>();
  for (const p of portfolio.positions) volumes.set(p.ticker, (volumes.get(p.ticker) ?? 0) + p.volume);
  for (const ticker of new Set([...volumes.keys(), ...lotUnits.keys()])) {
    const volume = volumes.get(ticker) ?? 0;
    const units = lotUnits.get(ticker) ?? 0;
    if (Math.abs(volume - units) > UNITS_TOLERANCE) {
      problems.push(`${where}: ${ticker}: Volume ${volume} is not the sum of the Units of its lots (${units})`);
    }
  }
  return problems;
}

/** Throws one error with every problem of `lotsMismatches`, for the readers that refuse the file. */
export function assertLotsMatch(portfolio: PortfolioSnapshot, decisions: readonly Decision[]): void {
  const problems = lotsMismatches(portfolio, decisions);
  if (problems.length > 0) {
    throw new Error(
      `${problems.join("\n")}\nFix Lots by hand in portfolio.md so each Volume is the sum of its lots' units (ADR-0015; see docs/input-format.md)`,
    );
  }
}
