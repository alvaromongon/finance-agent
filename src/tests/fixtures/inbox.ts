// Builders for the inbox tests (#131): a state of both silos for the pure handlers, and a portfolio.md for the
// flow tests. No engine config: this file is imported before VAULT_PROJECT_DIR is set.
import type { Currency, Lot, PortfolioSnapshot, Position, WatchlistEntry } from "../../types.js";
import { money } from "../../money.js";
import { parseTicker } from "../../ticker.js";
import type { EntryContext, Silos } from "../../utils/inbox-handlers.js";
import { lotsSection, mdTable, type HeldLot } from "./lots.js";

export const lot = <C extends Currency>(
  _currency: C,
  over: Omit<Partial<Lot<C>>, "ticker"> & { ticker: string; units: number },
): Lot<C> => ({
  entryId: `lot-${over.ticker.toLowerCase()}`,
  date: "2026-06-15",
  entryUnits: over.units,
  entryPrice: 100,
  initialStop: null,
  entryCosts: null,
  origin: "propietario",
  rulesVersion: "1.0",
  rulesViolations: [],
  ...over,
  ticker: parseTicker(over.ticker),
});

/** One position per ticker: the sum of its lots' units at their average entry price. */
const positionsOf = <C extends Currency>(currency: C, lots: Lot<C>[]): Position<C>[] =>
  [...new Set(lots.map((l) => l.ticker))].map((ticker) => {
    const own = lots.filter((l) => l.ticker === ticker);
    const volume = own.reduce((sum, l) => sum + l.units, 0);
    const avgPrice = own.reduce((sum, l) => sum + l.units * l.entryPrice, 0) / volume;
    return {
      ticker,
      currency,
      volume,
      avgPrice,
      currentPrice: avgPrice,
      pl: money(0, currency),
      stopLoss: own[0].initialStop,
    };
  });

const silo = <C extends Currency>(currency: C, cash: number, lots: Lot<C>[]): PortfolioSnapshot<C> => ({
  currency,
  cash: money(cash, currency),
  positions: positionsOf(currency, lots),
  lots,
  syncedAt: "2026-10-01T00:00:00Z",
});

/** The tickers `stateOf` has on the watchlist of both silos: the ones the tests buy, so that no entry is flagged `not_in_watchlist`. */
const WATCHED = ["SAP.DE", "TCK", "AAA", "BBB", "ADBE"];

/** An entry of the watchlist, the one a `watch` would make. */
export const watched = (ticker: string, currency: Currency): WatchlistEntry => ({
  ticker: parseTicker(ticker),
  currency,
  horizon: "medium",
  thesis: "test",
});

/**
 * Both silos: EUR with `eurCash` and the given lots, USD with `usdCash` and the given lots, and the watchlist of the
 * tickers the tests buy (in both silos); `watchlist` replaces it.
 */
export function stateOf(
  { eurCash = 1000, usdCash = 500 } = {},
  lots: { EUR?: Lot<"EUR">[]; USD?: Lot<"USD">[] } = {},
  watchlist: readonly WatchlistEntry[] = WATCHED.flatMap((t) => [watched(t, "EUR"), watched(t, "USD")]),
): Required<Silos> & { watchlist: readonly WatchlistEntry[] } {
  return { EUR: silo("EUR", eurCash, lots.EUR ?? []), USD: silo("USD", usdCash, lots.USD ?? []), watchlist };
}

const POSITIONS_HEADER = ["Ticker", "Volume", "Avg price", "Current price", "P/L", "Stop loss"];

/** A portfolio.md for the flow tests: EUR holds `eur`, USD holds `usd`, each with its cash. */
export function portfolioMd({
  eurCash = "1000.00",
  usdCash = "500.00",
  eur = [],
  usd = [],
}: { eurCash?: string; usdCash?: string; eur?: HeldLot[]; usd?: HeldLot[] } = {}): string {
  const rows = (held: HeldLot[]) =>
    held.map((l) => `| ${l.ticker} | ${l.units} | ${l.price} | ${l.price} | 0 | ${l.stop ?? "—"} |`);
  return `---
schema_version: 2
last_manual_sync: 2099-01-01T00:00:00Z
---

## EUR — Cash

| Item | Value |
|---|---|
| Available cash | ${eurCash} |

## EUR — Positions

${mdTable(POSITIONS_HEADER, rows(eur))}

${lotsSection("EUR", eur)}
## USD — Cash

| Item | Value |
|---|---|
| Available cash | ${usdCash} |

## USD — Positions

${mdTable(POSITIONS_HEADER, rows(usd))}

${lotsSection("USD", usd)}`;
}

/** A state whose USD silo is the EUR one: the type cannot tell, only a check of the currency at run time can (#145). */
export const crossedState = (state: Required<Silos>): Required<Silos> =>
  ({ ...state, USD: state.EUR }) as unknown as Required<Silos>;

/**
 * What the rules of an entry read (`EntryContext`) with nothing to flag: they follow no proposal and no ATR is known.
 * `over` changes any of it. (The watchlist is in the state: see `stateOf`.)
 */
export function entryContext(over: Partial<EntryContext> = {}): EntryContext {
  return {
    history: [],
    cited: new Set(),
    atr: new Map(),
    minStopAtr: 2,
    ...over,
  };
}

/** A watchlist.md with the given entries (ticker and silo), the file `inbox:ingest` reads for the rules of an entry. */
export const watchlistMd = (entries: readonly (readonly [string, Currency])[]): string =>
  [
    "---",
    "schema_version: 1",
    "---",
    "",
    "# Watchlist",
    "",
    "```yaml",
    "watchlist:",
    ...entries.flatMap(([ticker, currency]) => [
      `  - ticker: ${ticker}`,
      `    name: ${ticker}`,
      "    market: TEST",
      `    currency: ${currency}`,
      "    horizon: medium",
      '    thesis: "test"',
    ]),
    "```",
    "",
  ].join("\n");
