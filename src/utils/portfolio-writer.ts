// The writer of `portfolio.md`: the model's lots and prices as text (ADR-0015). Pure: no I/O. Part of the
// storage layer, behind the portfolio store (`portfolio-store.ts`): the flows hand over lots, a position
// change or prices, never text.
//
// - `applyLotChange`: the new text with the silo's `Lots` and its `Positions` row edited.
// - `applyPrices`: the new text with the `Current price` and `P/L` of the priced positions.
import type { Currency, Lot } from "../types.js";
import { UNITS_TOLERANCE } from "./units.js";
import { mapTableRows, parsePortfolio, readTable, serializePortfolio, setTableRows } from "./portfolio-codec.js";
import {
  isPositionPlaceholder,
  lotColumns,
  parseLotRows,
  positionColumns,
  LotsTableError,
  type LotColumn,
} from "./vault-parser.js";
import { missingLotsSection, portfolioWhere } from "./portfolio-where.js";
import { checkTicker, namesTicker, type Ticker } from "../ticker.js";
import { parseMarkdownNumber } from "./parse.js";

/** What a lot change does to the ticker's row in `Positions`. */
export interface PositionChange {
  ticker: Ticker;
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
 * read as a lot: that is not the recorder's to guess. A ticker on several `Positions` rows is refused by the
 * lots check before the recorder plans anything (`volumeMismatches`), so here it is a broken invariant.
 */
export function applyLotChange(md: string, currency: Currency, lots: readonly Lot[], change: PositionChange): string {
  const num = numberFormat(currency);
  const { skipped } = parseLotRows(md, currency);
  if (skipped.length > 0) {
    throw new Error(
      `${portfolioWhere(currency)}: ${skipped.map((row) => row.message).join("; ")} - the Lots table is not rewritten while a row does not read (nothing was recorded)`,
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
    // The row names the ticker in any case; the one the engine writes carries the canonical value.
    const at = kept.flatMap((cells, i) => {
      return namesTicker(cells[col.ticker], change.ticker) ? [i] : [];
    });
    if (at.length > 1) {
      throw new Error(
        `${portfolioWhere(currency)}: internal error: ${change.ticker} is on ${at.length} rows of Positions; the lots check should have refused it (nothing was recorded)`,
      );
    }
    if (change.volume <= UNITS_TOLERANCE) return at.length === 0 ? kept : kept.filter((_, i) => i !== at[0]);
    if (at.length === 1) {
      kept[at[0]][col.ticker] = change.ticker;
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
    throw new Error(
      `${portfolioWhere(currency)}: missing section "## ${currency} — Positions" (see docs/input-format.md)`,
    );
  }
  return serializePortfolio(withPositions);
}

/**
 * Number as the file's silo writes it (decimal comma in EUR, point in USD, no thousands separator,
 * which would be ambiguous), at least `minDecimals` and at most 8 decimals so a low price keeps its
 * precision and float noise does not show.
 */
export function numberFormat(currency: Currency): (n: number, minDecimals: number) => string {
  const separator = currency === "EUR" ? "," : ".";
  return (n, minDecimals) => {
    const [integer, fraction = ""] = n.toFixed(8).split(".");
    const trimmed = fraction.replace(/0+$/, "").padEnd(minDecimals, "0");
    return trimmed ? `${integer}${separator}${trimmed}` : integer;
  };
}

// ─── Prices ───────────────────────────────────────────────────────────────────

/**
 * `md` with the `Current price` and `P/L` of every `Positions` row whose ticker has a price (`P/L` is
 * `(price - Avg price) × Volume`, formatted as it is: never refused, see below), or `null` if nothing changed
 * (no row to price, or the same values). It does not touch `last_manual_sync` or any other field.
 * Columns are read by their header; every row of a ticker is priced, the way the Volume check reads
 * them (it sums all of them). A row whose ticker does not parse, a ticker without a price and a row
 * with no numeric `Avg price` or `Volume` are left alone.
 */
export function applyPrices(md: string, currency: Currency, prices: ReadonlyMap<Ticker, number>): string | null {
  const model = parsePortfolio(md);
  const table = readTable(model, currency, "Positions");
  if (!table?.header) return null;
  const col = positionColumns(table.header, currency);
  const updated = mapTableRows(model, currency, "Positions", (cells) => {
    if (isPositionPlaceholder(cells[col.ticker] ?? "")) return null;
    // The map is keyed by the parsed ticker, so the cell is parsed to look it up. A priced row carries the
    // canonical (upper-case) ticker.
    const checked = checkTicker(cells[col.ticker]);
    if (!("ticker" in checked)) return null;
    const current = prices.get(checked.ticker);
    if (current == null) return null;

    const avgPrice = parseMarkdownNumber(cells[col.avgPrice]);
    const volume = parseMarkdownNumber(cells[col.volume]);
    if (avgPrice == null || volume == null) return null;

    const next = [...cells];
    next[col.ticker] = checked.ticker;
    // Plain numbers, not `Money`: a cell too large to count in cents or a provider price that is not finite
    // is written as it formats, never refused, or one typo would stop the run before its stop alerts (ADR-0015).
    next[col.currentPrice] = fmtEU(current);
    next[col.pl] = fmtEU((current - avgPrice) * volume);
    return next;
  });
  return !updated || updated === model ? null : serializePortfolio(updated);
}

/**
 * Formats a number European-style with 2 decimals (46,80 / 1.234,56), in either silo: the price cells keep
 * their one format. It only formats: a value too large to count in cents or not finite is written as it
 * comes, never refused (ADR-0015).
 */
function fmtEU(n: number): string {
  return n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
