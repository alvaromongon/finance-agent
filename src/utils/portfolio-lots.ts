// Lot keeping for `decision:record` (ADR-0015, #42). Pure: no I/O, no config. The recorder reads the
// portfolio and the log, plans with these functions, then writes the log and the portfolio.
//
// - `lotOfEntry`: the lot an entry opens.
// - `planSale`: which lots a sale consumes (first in, first out) and what each exit carries.
// - `applyLotChange`: the new `portfolio.md` text, with the silo's `Lots` and its `Positions` row edited.
import type { Decision } from "../decisions.js";
import type { Currency, Lot } from "../types.js";
import { UNITS_TOLERANCE } from "./units.js";
import { round2 } from "./round.js";
import { parsePortfolio, serializePortfolio, setTableRows } from "./portfolio-codec.js";
import {
  isPositionPlaceholder,
  lotColumns,
  parseLotRows,
  portfolioWhere,
  positionColumns,
  missingLotsSection,
  missingSection,
  LotsTableError,
  type LotColumn,
} from "./vault-parser.js";

/** Decimals of an exit's amount: its exact share of the sale amount, with the float noise cleared. */
const AMOUNT_DECIMALS = 8;

/** The lot an entry opens: all the units it bought, with the entry's own data as its snapshot. */
export function lotOfEntry(entry: Decision, units: number): Lot {
  return {
    ticker: entry.ticker!,
    entryId: entry.id,
    date: entry.date,
    units,
    entryUnits: units,
    entryPrice: entry.price!,
    initialStop: entry.stop_initial ?? null,
    entryCosts: entry.costs ?? null,
    origin: entry.origin,
    rulesVersion: entry.rules_version,
    rulesViolations: entry.rule_violations ?? [],
  };
}

/**
 * Shares `total` over `weights` in whole units of the last of `decimals` decimals (cents for 2), by the
 * largest-remainder method: each share is its exact part rounded down, and the units left over go one
 * each to the largest remainders (the later on a tie, as the remainder used to go to the last). So no share is ever negative (all are <= 0 for
 * a negative total) and the shares add up exactly to `total` rounded to that unit. Rounding every share
 * and giving the last `total - sum` can leave the last negative.
 */
export function allocateByWeight(total: number, weights: readonly number[], decimals: number): number[] {
  const unit = 10 ** decimals;
  const sign = total < 0 ? -1 : 1;
  const cents = Math.round(Math.abs(total) * unit);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (cents * w) / weightSum);
  const shares = exact.map(Math.floor);
  const byRemainder = exact
    .map((x, i) => ({ i, remainder: x - shares[i] }))
    .sort((a, b) => b.remainder - a.remainder || b.i - a.i);
  let left = cents - shares.reduce((a, b) => a + b, 0);
  // Float noise can leave one unit too many (never more): take it back from the smallest remainders.
  for (let k = 0; left !== 0 && k < 2 * byRemainder.length; k++) {
    const { i } =
      left > 0 ? byRemainder[k % byRemainder.length] : byRemainder[byRemainder.length - 1 - (k % byRemainder.length)];
    if (left > 0) {
      shares[i]++;
      left--;
    } else if (shares[i] > 0) {
      shares[i]--;
      left++;
    }
  }
  return shares.map((n) => (n === 0 ? 0 : (sign * n) / unit));
}

// ─── Sale: first in, first out ────────────────────────────────────────────────

export interface SalePlanInput {
  ticker: string;
  /** Units sold. */
  units: number;
  /**
   * The units were derived from `amount / price` (the owner gave only the amount), so they are known
   * to half a cent of price: a lot that the sale leaves with less than that is used up. Absent when the
   * owner gave the units: they are exact and nothing is snapped.
   */
  unitsFromAmount?: boolean;
  price: number;
  /** Amount of the whole sale, in the silo currency. */
  amount: number;
  /** Costs of the whole sale; absent if none were given. */
  costs?: number;
  /** Realized result of the whole sale if the owner gave it; otherwise each lot's own is computed. */
  pnl?: number;
}

/** What one lot gives to a sale: one `exit` line. */
export interface SaleShare {
  lot: Lot;
  unitsSold: number;
  /** The lot's `Units` after the sale; exactly 0 when it is used up. */
  unitsLeft: number;
  /** This exit's share of the sale amount; the shares add up to it. */
  amount: number;
  costs: number | undefined;
  pnl: number;
  /** This exit's share of the lot's entry costs; absent if the lot has none. */
  entryCosts: number | undefined;
}

/**
 * Consumes the ticker's lots first in, first out (oldest entry date first, ties in the order of the
 * table) until `sale.units` are sold. The amount, the costs and the result of the sale are shared
 * across the lots pro rata to the units, so the exits add up to the sale (`allocateByWeight`: never a negative share).
 * The amount is shared exactly (not to the cent: a lot of a few units of a low-priced asset would get
 * 0.00); the costs and the result, which are settled money, go to the cent.
 * A lot's entry costs go pro rata too, and the exit that uses the lot up takes what is left of them
 * (`priorEntryCosts`: what earlier exits of each lot already took), so the exits of one lot add up
 * to its `Entry costs`. Throws if the ticker has no lots or fewer units than the sale.
 */
export function planSale(
  lots: readonly Lot[],
  sale: SalePlanInput,
  priorEntryCosts: ReadonlyMap<string, number>,
): SaleShare[] {
  const ordered = lots
    .map((lot, index) => ({ lot, index }))
    .filter(({ lot }) => lot.ticker === sale.ticker && lot.units > 0)
    .sort((a, b) => a.lot.date.localeCompare(b.lot.date) || a.index - b.index)
    .map(({ lot }) => lot);
  if (ordered.length === 0)
    throw new Error(`Cannot sell ${sale.ticker}: no open lots for ${sale.ticker} in portfolio.md`);
  const open = ordered.reduce((sum, l) => sum + l.units, 0);
  // A sale narrated by amount has its units known to half a cent of price: that much over is the lot,
  // and that much under leaves nothing worth keeping: the lot is used up (a position of dust is not one).
  // Units the owner gave are exact: on a low-priced asset half a cent of price is several units.
  const tolerance = (sale.unitsFromAmount ? 0.005 / sale.price : 0) + UNITS_TOLERANCE;
  if (sale.units > open + tolerance) {
    throw new Error(`Cannot sell ${sale.units} units of ${sale.ticker}: only ${open} are open in Lots`);
  }

  const taken: { lot: Lot; unitsSold: number; unitsLeft: number }[] = [];
  let remaining = sale.units;
  for (const lot of ordered) {
    if (remaining < UNITS_TOLERANCE || (taken.length > 0 && remaining <= tolerance)) break;
    const left = lot.units - Math.min(lot.units, remaining);
    const usedUp = left <= tolerance;
    const unitsSold = usedUp ? lot.units : lot.units - left;
    taken.push({ lot, unitsSold, unitsLeft: usedUp ? 0 : left });
    remaining -= unitsSold;
  }

  // `decimals` is the precision of each share: the cent for money that is settled (costs, result), 8 for
  // the amount, which is the exact share of the sale amount so that a lot of a few units of a low-priced
  // asset does not get 0.00 (the 8 decimals only clear float noise, as the file's number format does).
  const weights = taken.map((t) => t.unitsSold);
  const split = (total: number | undefined, decimals = 2): (number | undefined)[] =>
    total === undefined ? taken.map(() => undefined) : allocateByWeight(total, weights, decimals);
  const amounts = split(sale.amount, AMOUNT_DECIMALS);
  const costs = split(sale.costs);
  const owned = split(sale.pnl);

  return taken.map((t, i) => ({
    ...t,
    amount: amounts[i]!,
    costs: costs[i],
    pnl: owned[i] ?? round2((sale.price - t.lot.entryPrice) * t.unitsSold),
    entryCosts: entryCostsShare(t, priorEntryCosts.get(t.lot.entryId) ?? 0),
  }));
}

function entryCostsShare(t: { lot: Lot; unitsSold: number; unitsLeft: number }, taken: number): number | undefined {
  const total = t.lot.entryCosts;
  if (total == null) return undefined;
  const left = Math.max(0, total - taken);
  if (t.unitsLeft === 0) return round2(left);
  return Math.min(round2((total * t.unitsSold) / t.lot.entryUnits), round2(left));
}

// ─── portfolio.md ─────────────────────────────────────────────────────────────

/** What a lot change does to the ticker's row in `Positions`. */
export interface PositionChange {
  ticker: string;
  /** New `Volume`, the sum of the ticker's lots' units; 0 or less deletes the row. */
  volume: number;
  /** New `Avg price`; the row keeps its own if absent. */
  avgPrice?: number;
  /** `Stop loss` of a row created by this change (the first lot's initial stop); `null` for none. */
  newStopLoss?: number | null;
  /** `Current price` of a row created by this change; the average price if absent. */
  currentPrice?: number;
}

const LOT_HEADER: Record<LotColumn, string> = {
  ticker: "Ticker",
  entryId: "Entry id",
  date: "Date",
  units: "Units",
  entryUnits: "Entry units",
  entryPrice: "Entry price",
  initialStop: "Initial stop",
  entryCosts: "Entry costs",
  origin: "Origin",
  rulesVersion: "Rules version",
  rulesViolations: "Rules violations",
};
const POSITION_HEADER = ["Ticker", "Volume", "Avg price", "Current price", "P/L", "Stop loss"];
const NONE = "—";

/**
 * `md` with the silo's `Lots` table holding exactly `lots` and the `Positions` row of `change.ticker`
 * updated, created or deleted. The cells keep the file's column order; the rest of the file, line ends
 * included, is the codec's to keep. Refuses (nothing is rewritten) a `Lots` table with a row that does not
 * read as a lot, or a ticker on several `Positions` rows: neither is the recorder's to guess.
 */
export function applyLotChange(md: string, currency: Currency, lots: readonly Lot[], change: PositionChange): string {
  const num = numberFormat(currency);
  const { skipped } = parseLotRows(md, currency);
  if (skipped.length > 0) {
    throw new Error(
      `${portfolioWhere(currency)}: ${skipped.join("; ")} - the Lots table is not rewritten while a row does not read (nothing was recorded)`,
    );
  }

  const withLots = setTableRows(parsePortfolio(md), currency, "Lots", Object.values(LOT_HEADER), (header) => {
    const col = lotColumns(header, currency);
    return lots.map((lot) => {
      const cells = header.map(() => NONE);
      const set = (key: LotColumn, value: string) => (cells[col[key]] = value);
      set("ticker", lot.ticker);
      set("entryId", lot.entryId);
      set("date", lot.date);
      set("units", num(lot.units, 0));
      set("entryUnits", num(lot.entryUnits, 0));
      set("entryPrice", num(lot.entryPrice, 2));
      set("initialStop", lot.initialStop == null ? NONE : num(lot.initialStop, 2));
      set("entryCosts", lot.entryCosts == null ? NONE : num(lot.entryCosts, 2));
      set("origin", lot.origin);
      set("rulesVersion", lot.rulesVersion);
      set("rulesViolations", lot.rulesViolations.length > 0 ? lot.rulesViolations.join(", ") : NONE);
      return cells;
    });
  });
  if (!withLots) throw new LotsTableError(missingLotsSection(currency));

  const withPositions = setTableRows(withLots, currency, "Positions", POSITION_HEADER, (header, rows) => {
    const col = positionColumns(header, currency);
    const kept = rows.filter((cells) => !isPositionPlaceholder((cells[col.ticker] ?? "").trim()));
    const at = kept.flatMap((cells, i) => ((cells[col.ticker] ?? "").trim() === change.ticker ? [i] : []));
    if (at.length > 1) {
      throw new Error(
        `${portfolioWhere(currency)}: ${change.ticker} is on ${at.length} rows of "## ${currency} — Positions": merge them into one row (nothing was recorded)`,
      );
    }
    if (change.volume <= UNITS_TOLERANCE) return at.length === 0 ? kept : kept.filter((_, i) => i !== at[0]);
    if (at.length === 1) {
      kept[at[0]][col.volume] = num(change.volume, 0);
      if (change.avgPrice != null) kept[at[0]][col.avgPrice] = num(change.avgPrice, 2);
      return kept;
    }
    const cells = header.map(() => NONE);
    cells[col.ticker] = change.ticker;
    cells[col.volume] = num(change.volume, 0);
    cells[col.avgPrice] = num(change.avgPrice ?? 0, 2);
    cells[col.currentPrice] = num(change.currentPrice ?? change.avgPrice ?? 0, 2);
    cells[col.pl] = num(0, 2);
    cells[col.stopLoss] = change.newStopLoss == null ? NONE : num(change.newStopLoss, 2);
    return [...kept, cells];
  });
  if (!withPositions) {
    throw new Error(missingSection(currency, "Positions"));
  }
  return serializePortfolio(withPositions);
}

/**
 * Number as the file's silo writes it (decimal comma in EUR, point in USD, no thousands separator,
 * which would be ambiguous), at least `minDecimals` and at most 8 decimals so a low price keeps its
 * precision and float noise does not show.
 */
function numberFormat(currency: Currency): (n: number, minDecimals: number) => string {
  const separator = currency === "EUR" ? "," : ".";
  return (n, minDecimals) => {
    const [integer, fraction = ""] = n.toFixed(8).split(".");
    const trimmed = fraction.replace(/0+$/, "").padEnd(minDecimals, "0");
    return trimmed ? `${integer}${separator}${trimmed}` : integer;
  };
}
