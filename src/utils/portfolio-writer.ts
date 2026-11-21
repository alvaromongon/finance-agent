// The writer of `portfolio.md`: the model's prices as text (ADR-0015). Pure: no I/O. Part of the storage layer,
// behind the portfolio store (`portfolio-store.ts`): the flows hand over prices, never text. With the store, the
// lots are the inbox's (#152) and this text is written only for the file the store has not replaced yet.
//
// - `applyPrices`: the new text with the `Current price` and `P/L` of the priced positions.
import type { Currency } from "../types.js";
import { mapTableRows, parsePortfolio, readTable, serializePortfolio } from "./portfolio-codec.js";
import { isPositionPlaceholder, positionColumns } from "./vault-parser.js";
import { checkTicker, type Ticker } from "../ticker.js";
import { parseMarkdownNumber } from "./parse.js";

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
