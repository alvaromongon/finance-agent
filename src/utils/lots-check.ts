// Cross-check of the open lots of portfolio.md against the decision log (ADR-0015). Pure: the
// callers read both and decide what a mismatch means (the evaluation and `decision:record` refuse
// the file, the heartbeat warns and keeps watching the positions).
//
// Two levels, because the heartbeat must not read the decision log on its alerting path:
// `volumeMismatches` needs `portfolio.md` alone (each lot names its Ticker), `lotsMismatches` adds
// every check that needs the log.
import type { Decision } from "../decisions.js";
import type { Lot, PortfolioSnapshot } from "../types.js";

/** Units are fractions: below this the difference is float noise, not a mismatch. */
const UNITS_TOLERANCE = 1e-8;
/** Prices and stops are copied from the entry; below this the difference is formatting, not a mismatch. */
const PRICE_TOLERANCE = 1e-6;

const where = (portfolio: PortfolioSnapshot): string => `portfolio.md (${portfolio.currency})`;

/**
 * Problems of a silo's `Volume` against its lots, from `portfolio.md` alone: a ticker whose `Volume`
 * is not the sum of the `Units` of its lots (a position with no lots, or lots of a ticker with no
 * position row, count too). One message per problem, empty if it is consistent.
 */
export function volumeMismatches(portfolio: PortfolioSnapshot): string[] {
  const lotUnits = new Map<string, number>();
  for (const lot of portfolio.lots) lotUnits.set(lot.ticker, (lotUnits.get(lot.ticker) ?? 0) + lot.units);

  const volumes = new Map<string, number>();
  for (const p of portfolio.positions) volumes.set(p.ticker, (volumes.get(p.ticker) ?? 0) + p.volume);

  const problems: string[] = [];
  for (const ticker of new Set([...volumes.keys(), ...lotUnits.keys()])) {
    const volume = volumes.get(ticker) ?? 0;
    const units = lotUnits.get(ticker) ?? 0;
    if (Math.abs(volume - units) > UNITS_TOLERANCE) {
      problems.push(
        `${where(portfolio)}: ${ticker}: Volume ${volume} is not the sum of the Units of its lots (${units})`,
      );
    }
  }
  return problems;
}

/**
 * Problems of a silo's `Lots` against the decision log (the whole history, live and archived), one
 * message per problem, empty if it is consistent:
 *
 * - a lot with more `Units` than `Entry units`, or an `Entry id` on two rows;
 * - a lot whose entry id is not an `entry` of that silo in the log, whose `Ticker` is not its
 *   entry's, or whose snapshot of the entry (entry price, entry units, initial stop, date, origin,
 *   rules version, rules violations) differs from it;
 * - an entry that is still open in the log and has no lot, or a lot that an exit already used up
 *   (`lot_units_left` 0): a two-file write that stopped halfway after the log;
 * - a ticker whose `Volume` is not the sum of the units of its lots (`volumeMismatches`).
 *
 * An entry is open when no exit citing it has `lot_units_left` = 0. An entry cited by an exit that
 * carries no `lot_units_left` was closed before the lot contract (#52) and is out of the check:
 * entries carry no `units` of their own, so this is how the entries of the earlier format are told apart.
 */
export function lotsMismatches(portfolio: PortfolioSnapshot, decisions: readonly Decision[]): string[] {
  const at = where(portfolio);
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const lot of portfolio.lots) {
    const name = `${lot.ticker}: lot ${lot.entryId}`;
    if (seen.has(lot.entryId)) {
      problems.push(`${at}: Entry id ${lot.entryId} is on two rows of Lots`);
    }
    seen.add(lot.entryId);
    if (lot.units > lot.entryUnits + UNITS_TOLERANCE) {
      problems.push(`${at}: ${name} has Units ${lot.units}, more than its Entry units ${lot.entryUnits}`);
    }

    const decision = byId.get(lot.entryId);
    if (!decision) {
      problems.push(`${at}: lot ${lot.entryId} is not in the decision log (logs/decisions.jsonl)`);
    } else if (decision.type !== "entry" || decision.ticker == null) {
      problems.push(`${at}: lot ${lot.entryId} is a ${decision.type} in the decision log, not an entry`);
    } else if (decision.currency !== portfolio.currency) {
      problems.push(
        `${at}: lot ${lot.entryId} is an entry of ${decision.ticker} recorded in ${decision.currency}, not ${portfolio.currency}`,
      );
    } else if (decision.ticker !== lot.ticker) {
      problems.push(
        `${at}: lot ${lot.entryId} is on ${lot.ticker} but its entry in the decision log is ${decision.ticker}`,
      );
    } else {
      for (const difference of snapshotDifferences(lot, decision)) {
        problems.push(`${at}: ${name}: ${difference} (the entry in the decision log)`);
      }
    }
  }

  problems.push(...volumeMismatches(portfolio));
  problems.push(...entriesWithoutLot(portfolio, decisions));
  problems.push(...lotsAlreadyUsedUp(portfolio, decisions));
  return problems;
}

/** What the lot's snapshot of its entry says differently from the entry in the log. */
function snapshotDifferences(lot: Lot, entry: Decision): string[] {
  const differences: string[] = [];
  const num = (field: string, lotValue: number | null, logValue: number | null | undefined, tolerance: number) => {
    const a = lotValue ?? null;
    const b = logValue ?? null;
    if (a === null || b === null ? a !== b : Math.abs(a - b) > tolerance) {
      differences.push(`${field} ${a ?? "—"} differs from ${b ?? "—"}`);
    }
  };
  const text = (field: string, lotValue: string, logValue: string) => {
    if (lotValue !== logValue) differences.push(`${field} ${lotValue} differs from ${logValue}`);
  };

  num("Entry price", lot.entryPrice, entry.price, PRICE_TOLERANCE);
  // The entry's amount is rounded to the cent, so its units are only known to half a cent of price.
  const logUnits = entry.amount != null && entry.price ? entry.amount / entry.price : null;
  num("Entry units", lot.entryUnits, logUnits, entry.price ? 0.005 / entry.price + UNITS_TOLERANCE : 0);
  num("Initial stop", lot.initialStop, entry.stop_initial, PRICE_TOLERANCE);
  text("Date", lot.date, entry.date);
  text("Origin", lot.origin, entry.origin);
  text("Rules version", lot.rulesVersion, entry.rules_version);
  const sorted = (violations: readonly string[]) => [...violations].sort().join(", ") || "—";
  text("Rules violations", sorted(lot.rulesViolations), sorted(entry.rule_violations ?? []));
  return differences;
}

/** Entries of the silo that are still open in the log and have no row in `Lots`. */
function entriesWithoutLot(portfolio: PortfolioSnapshot, decisions: readonly Decision[]): string[] {
  const used = new Set<string>();
  const earlierFormat = new Set<string>();
  for (const d of decisions) {
    if (d.type !== "exit" || !d.related_id) continue;
    if (d.lot_units_left == null) earlierFormat.add(d.related_id);
    else if (d.lot_units_left === 0) used.add(d.related_id);
  }
  const lotted = new Set(portfolio.lots.map((l) => l.entryId));
  return decisions
    .filter(
      (d) =>
        d.type === "entry" &&
        d.ticker != null &&
        d.currency === portfolio.currency &&
        !used.has(d.id) &&
        !earlierFormat.has(d.id) &&
        !lotted.has(d.id),
    )
    .map((d) => `${where(portfolio)}: ${d.ticker}: entry ${d.id} is open in the decision log but has no lot in Lots`);
}

/** Lots still in `Lots` although an exit in the log used them up: the portfolio was not rewritten after it. */
function lotsAlreadyUsedUp(portfolio: PortfolioSnapshot, decisions: readonly Decision[]): string[] {
  const usedUp = new Set(
    decisions.filter((d) => d.type === "exit" && d.lot_units_left === 0 && d.related_id).map((d) => d.related_id),
  );
  return portfolio.lots
    .filter((lot) => usedUp.has(lot.entryId))
    .map(
      (lot) =>
        `${where(portfolio)}: ${lot.ticker}: lot ${lot.entryId} is still in Lots but an exit in the decision log used it up (lot_units_left 0)`,
    );
}

/** Throws one error with every problem of `lotsMismatches`, for the readers that refuse the file. */
export function assertLotsMatch(portfolio: PortfolioSnapshot, decisions: readonly Decision[]): void {
  const problems = lotsMismatches(portfolio, decisions);
  if (problems.length > 0) {
    throw new Error(
      `${problems.join("\n")}\nFix Lots by hand in portfolio.md so each Volume is the sum of its lots' units and each open entry has its lot (ADR-0015; see docs/input-format.md)`,
    );
  }
}
