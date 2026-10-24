// Cross-check of the open lots of portfolio.md against the decision log (ADR-0015). Pure: the
// callers read both and decide what a mismatch means (the evaluation and `decision:record` refuse
// the file, the heartbeat warns and keeps watching the positions).
//
// Two levels, because the heartbeat must not read the decision log on its alerting path:
// `volumeMismatches` needs `portfolio.md` alone (each lot names its Ticker), `lotsMismatches` adds
// every check that needs the log.
import type { Decision } from "../decisions.js";
import type { Lot, PortfolioSnapshot } from "../types.js";
import { UNITS_TOLERANCE } from "./units.js";
import { portfolioWhere } from "./vault-parser.js";

/** Prices and stops are copied from the entry; below this the difference is formatting, not a mismatch. */
const PRICE_TOLERANCE = 1e-6;

const where = (portfolio: PortfolioSnapshot): string => portfolioWhere(portfolio.currency);

/**
 * Problems of a silo's `Volume` against its lots, from `portfolio.md` alone: a row of `Lots` the reader
 * skipped (it names the row and the reason), then a ticker whose `Volume` is not the sum of the `Units`
 * of its lots (a position with no lots, or lots of a ticker with no position row, count too). A ticker
 * that `Positions` and `Lots` write differing only in case is one problem, not two `Volume` mismatches.
 * One message per problem, empty if it is consistent. `caseReported` holds the lot tickers whose case
 * the caller already reported (against the decision log).
 */
export function volumeMismatches(
  portfolio: PortfolioSnapshot,
  caseReported: ReadonlySet<string> = new Set(),
): string[] {
  const at = where(portfolio);
  const lotUnits = new Map<string, number>();
  for (const lot of portfolio.lots) lotUnits.set(lot.ticker, (lotUnits.get(lot.ticker) ?? 0) + lot.units);

  const volumes = new Map<string, number>();
  const rows = new Map<string, number[]>();
  for (const p of portfolio.positions) {
    volumes.set(p.ticker, (volumes.get(p.ticker) ?? 0) + p.volume);
    rows.set(p.ticker, [...(rows.get(p.ticker) ?? []), p.volume]);
  }

  const problems = (portfolio.skippedLotRows ?? []).map((row) => `${at}: ${row}`);
  // The tickers of the rows that do not read: their Volume is reported once those rows are fixed.
  const unreadable = new Set((portfolio.unreadableLots?.tickers ?? []).map((t) => t.toLowerCase()));
  for (const [ticker, volumesOfRows] of rows) {
    if (volumesOfRows.length > 1) {
      problems.push(
        `${at}: ${ticker} is on ${volumesOfRows.length} rows of "## ${portfolio.currency} — Positions" (Volume ${volumesOfRows.join(", ")}): merge them into one row`,
      );
    }
  }
  const inCase = new Map<string, string>();
  for (const ticker of volumes.keys()) inCase.set(ticker.toLowerCase(), ticker);
  const apart = new Set<string>();
  for (const ticker of lotUnits.keys()) {
    if (unreadable.has(ticker.toLowerCase())) continue;
    const position = inCase.get(ticker.toLowerCase());
    if (position === undefined || position === ticker || volumes.has(ticker)) continue;
    apart.add(position);
    apart.add(ticker);
    if (!caseReported.has(ticker)) {
      problems.push(
        `${at}: ${ticker} in Lots and ${position} in Positions differ only in case; write the ticker the same in both`,
      );
    }
  }
  for (const ticker of new Set([...volumes.keys(), ...lotUnits.keys()])) {
    if (apart.has(ticker) || unreadable.has(ticker.toLowerCase())) continue;
    const volume = volumes.get(ticker) ?? 0;
    const units = lotUnits.get(ticker) ?? 0;
    if (Math.abs(volume - units) > UNITS_TOLERANCE) {
      problems.push(`${at}: ${ticker}: Volume ${volume} is not the sum of the Units of its lots (${units})`);
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
 * An entry is open when no exit citing it has `lot_units_left` = 0. Entries whose log line carries no
 * `units` predate the lot contract (#52) and are out of that check (`entriesWithoutLot`).
 */
export function lotsMismatches(portfolio: PortfolioSnapshot, decisions: readonly Decision[]): string[] {
  const at = where(portfolio);
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const problems: string[] = [];
  const seen = new Set<string>();
  const caseReported = new Set<string>();

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
    } else if (decision.type !== "entry") {
      problems.push(
        `${at}: lot ${lot.entryId} is a decision of type ${decision.type} in the decision log, not an entry`,
      );
    } else if (decision.ticker == null) {
      problems.push(`${at}: lot ${lot.entryId} is an entry in the decision log that has no ticker`);
    } else if (decision.currency !== portfolio.currency) {
      problems.push(
        `${at}: lot ${lot.entryId} is an entry of ${decision.ticker} recorded in ${decision.currency}, not ${portfolio.currency}`,
      );
    } else if (decision.ticker !== lot.ticker) {
      const caseOnly = decision.ticker.toLowerCase() === lot.ticker.toLowerCase();
      if (caseOnly) caseReported.add(lot.ticker);
      problems.push(
        `${at}: lot ${lot.entryId} is on ${lot.ticker} but its entry in the decision log is ${decision.ticker}${
          caseOnly ? " (they differ only in case)" : ""
        }`,
      );
    } else {
      for (const difference of snapshotDifferences(lot, decision)) {
        problems.push(`${at}: ${name}: ${difference} (the entry in the decision log)`);
      }
    }
  }

  const usedUp = usedUpEntries(decisions);
  problems.push(...volumeMismatches(portfolio, caseReported));
  problems.push(...entriesWithoutLot(portfolio, decisions, usedUp));
  problems.push(...lotsAlreadyUsedUp(portfolio, usedUp));
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

  // An entry recorded under the lot contract carries its units; an older one (a lot written by hand for
  // it) only its amount, rounded to the cent, so its units are known to half a cent of price.
  const logUnits = entry.units ?? (entry.amount != null && entry.price ? entry.amount / entry.price : null);
  const unitsTolerance =
    entry.units != null ? UNITS_TOLERANCE : entry.price ? 0.005 / entry.price + UNITS_TOLERANCE : 0;
  if (!isSplitOf(lot, entry, logUnits, unitsTolerance)) {
    num("Entry price", lot.entryPrice, entry.price, PRICE_TOLERANCE);
    num("Entry units", lot.entryUnits, logUnits, unitsTolerance);
    num("Initial stop", lot.initialStop, entry.stop_initial, PRICE_TOLERANCE);
  }
  // Costs are money, to the cent; no costs and costs of 0 are the same fact. A split leaves them as they were.
  const costs = (value: number | null | undefined) => (value == null || value === 0 ? null : value);
  num("Entry costs", costs(lot.entryCosts), costs(entry.costs), 0.005);
  text("Date", lot.date, entry.date);
  text("Origin", lot.origin, entry.origin);
  text("Rules version", lot.rulesVersion, entry.rules_version);
  const sorted = (violations: readonly string[]) => [...violations].sort().join(", ") || "—";
  text("Rules violations", sorted(lot.rulesViolations), sorted(entry.rule_violations ?? []));
  return differences;
}

/** Ids of the entries that an exit in the log used up (`lot_units_left` 0): built once per check. */
function usedUpEntries(decisions: readonly Decision[]): ReadonlySet<string | undefined> {
  return new Set(
    decisions.filter((d) => d.type === "exit" && d.lot_units_left === 0 && d.related_id).map((d) => d.related_id),
  );
}

/**
 * Entries of the silo that are still open in the log and have no row in `Lots`. Only entries under the
 * lot contract are checked: their log line carries `units`, which `decision:record` writes on every
 * entry from #42 on. An entry without it predates the lots and is out of the check, cited by an exit or
 * not (a v1 position still open, an exit that cited only the latest entry of a scale-in, an exit with
 * no `related_id`).
 */
function entriesWithoutLot(
  portfolio: PortfolioSnapshot,
  decisions: readonly Decision[],
  used: ReadonlySet<string | undefined>,
): string[] {
  const lotted = new Set([...portfolio.lots.map((l) => l.entryId), ...(portfolio.unreadableLots?.entryIds ?? [])]);
  const unreadable = new Set((portfolio.unreadableLots?.tickers ?? []).map((t) => t.toLowerCase()));
  return decisions
    .filter(
      (d) =>
        d.type === "entry" &&
        d.units != null &&
        d.ticker != null &&
        d.currency === portfolio.currency &&
        !used.has(d.id) &&
        !lotted.has(d.id) &&
        !unreadable.has(d.ticker.toLowerCase()),
    )
    .map((d) => `${where(portfolio)}: ${d.ticker}: entry ${d.id} is open in the decision log but has no lot in Lots`);
}

/** Lots still in `Lots` although an exit in the log used them up: the portfolio was not rewritten after it. */
function lotsAlreadyUsedUp(portfolio: PortfolioSnapshot, usedUp: ReadonlySet<string | undefined>): string[] {
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

/** The three columns of a lot (or of an exit's snapshot of it) that a stock split scales. */
export interface SplitShape {
  units: number;
  price: number;
  stop: number | null | undefined;
}

/**
 * A stock split corrects a lot by hand: `Entry units` × r, `Entry price` ÷ r and `Initial stop` ÷ r, for
 * one ratio r > 0 (B2 of PR #56). Returns r when `scaled` differs from `original` by one such common r
 * (within the tolerances) and is not simply equal to it; null for anything else, a wrong ratio, only
 * the units or only the price scaled. r comes from the units; the price and stop must follow it.
 * `unitsTolerance` is the imprecision of the units of `original`: an entry known only by its amount
 * has imprecise units, so its price tolerance grows by that relative error.
 */
export function splitRatio(scaled: SplitShape, original: SplitShape, unitsTolerance: number): number | null {
  if (!(original.units > 0) || !(scaled.units > 0)) return null;
  if (Math.abs(scaled.units - original.units) <= unitsTolerance) return null;
  const r = scaled.units / original.units;
  const relative = unitsTolerance / original.units;
  const follows = (scaledValue: number | null | undefined, originalValue: number | null | undefined): boolean => {
    if (scaledValue == null || originalValue == null) return scaledValue == null && originalValue == null;
    const expected = originalValue / r;
    return Math.abs(scaledValue - expected) <= PRICE_TOLERANCE + expected * relative;
  };
  return follows(scaled.price, original.price) && follows(scaled.stop, original.stop) ? r : null;
}

function isSplitOf(lot: Lot, entry: Decision, logUnits: number | null, unitsTolerance: number): boolean {
  if (logUnits === null || entry.price == null) return false;
  const lotShape = { units: lot.entryUnits, price: lot.entryPrice, stop: lot.initialStop };
  return (
    splitRatio(lotShape, { units: logUnits, price: entry.price, stop: entry.stop_initial }, unitsTolerance) !== null
  );
}
