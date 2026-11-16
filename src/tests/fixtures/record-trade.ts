// A buy or a sale written the way `decision:record` wrote it until #152 took the trade part out, for the tests of the
// evaluation (measurable-exits). They need trades whose origin is `sistema` and a Lots table of the old `portfolio.md`
// to match, and the inbox, which is the only way a trade is told to the engine now, writes the origin `propietario`.
// Test-only: it makes the log lines and the lot of a trade, nothing the engine does any more. Imported after
// VAULT_PROJECT_DIR is set, like the engine.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../../config.js";
import { benchmarkFields, buildDecision, type Decision, type DecisionOrigin } from "../../decisions.js";
import { exactAmount, money } from "../../money.js";
import { readPortfolio, requireReadable } from "../../portfolio-store.js";
import { parseTicker } from "../../ticker.js";
import type { Currency, Lot } from "../../types.js";
import { benchmarkOnDate, type PriceSource } from "../../utils/benchmark.js";
import { entryCostsTaken, planSale } from "../../utils/portfolio-lots.js";
import { numberFormat } from "../../utils/portfolio-writer.js";
import { parsePortfolio, serializePortfolio, setTableRows } from "../../utils/portfolio-codec.js";
import { missingLotsSection, portfolioWhere } from "../../utils/portfolio-where.js";
import { UNITS_TOLERANCE } from "../../utils/units.js";
import {
  isPositionPlaceholder,
  lotColumns,
  LotsTableError,
  parseLotRows,
  positionColumns,
  type LotColumn,
} from "../../utils/vault-parser.js";
import { namesTicker, type Ticker } from "../../ticker.js";
import { appendDecisions, readDecisionHistory, readRulesVersion } from "../../vault-io.js";

export interface TradeInput {
  type: "entry" | "exit";
  ticker: string;
  currency: Currency;
  price: number;
  units?: number;
  amount?: number;
  /** An entry's initial stop. */
  stop?: number;
  costs?: number;
  date?: string;
  origin?: DecisionOrigin;
}

const portfolioPath = (): string => join(config.paths.vaultProjectDir, "portfolio.md");

/** The decisions a trade wrote: one entry, or one exit per lot a sale consumed (first in, first out). */
export async function recordTrade(raw: TradeInput, provider: PriceSource, today: string): Promise<Decision[]> {
  const ticker = parseTicker(raw.ticker);
  const date = raw.date ?? today;
  const history = await readDecisionHistory();
  const portfolio = requireReadable(await readPortfolio(raw.currency));
  const common = {
    date,
    currency: raw.currency,
    source: "portfolio-sync" as const,
    origin: raw.origin ?? ("propietario" as const),
    ...benchmarkFields(await benchmarkOnDate(provider, raw.currency, date, today)),
    rules_version: await readRulesVersion(),
  };
  const costs = raw.costs === undefined ? undefined : money(raw.costs, raw.currency);

  if (raw.type === "entry") {
    const units = raw.units ?? raw.amount! / raw.price;
    const entry = buildDecision({
      ...common,
      type: "entry",
      ticker,
      price: raw.price,
      amount: raw.amount ?? exactAmount(units * raw.price),
      units,
      costs,
      stop_initial: raw.stop,
      rule_violations: raw.stop === undefined ? ["no_stop"] : [],
    });
    const lot: Lot = {
      ticker,
      entryId: entry.id,
      date,
      units,
      entryUnits: units,
      entryPrice: raw.price,
      initialStop: raw.stop ?? null,
      entryCosts: costs ?? null,
      origin: entry.origin,
      rulesVersion: entry.rules_version,
      rulesViolations: entry.rule_violations ?? [],
    };
    await appendDecisions([entry]);
    await writeLots(raw.currency, [...portfolio.lots, lot], ticker, raw.stop ?? null, raw.price);
    return [entry];
  }

  const amount = raw.amount ?? exactAmount(raw.units! * raw.price);
  const shares = planSale(
    portfolio.lots,
    {
      ticker,
      currency: raw.currency,
      units: raw.units ?? amount / raw.price,
      unitsFromAmount: raw.units == null,
      price: raw.price,
      amount,
      costs,
    },
    entryCostsTaken(history),
  );
  const exits = shares.map((share) =>
    buildDecision({
      ...common,
      type: "exit",
      ticker,
      price: raw.price,
      amount: share.amount,
      units: share.unitsSold,
      costs: share.costs,
      pnl: share.pnl,
      related_id: share.lot.entryId,
      entry_price: share.lot.entryPrice,
      entry_units: share.lot.entryUnits,
      entry_costs: share.entryCosts,
      entry_date: share.lot.date,
      entry_origin: share.lot.origin,
      entry_rules_version: share.lot.rulesVersion,
      stop_initial: share.lot.initialStop ?? undefined,
      rule_violations: share.lot.rulesViolations,
      lot_units_left: share.unitsLeft,
    }),
  );
  const left = new Map(shares.map((share) => [share.lot.entryId, share.unitsLeft]));
  const remaining = portfolio.lots
    .map((lot) => ({ ...lot, units: left.get(lot.entryId) ?? lot.units }))
    .filter((lot) => lot.units > 0);
  await appendDecisions(exits);
  await writeLots(raw.currency, remaining, ticker, undefined, undefined);
  return exits;
}

/** `portfolio.md` with `lots` as the silo's Lots and the position of `ticker` as they say. */
async function writeLots(
  currency: Currency,
  lots: readonly Lot[],
  ticker: Lot["ticker"],
  newStopLoss: number | null | undefined,
  currentPrice: number | undefined,
): Promise<void> {
  const own = lots.filter((lot) => lot.ticker === ticker);
  const volume = own.reduce((sum, lot) => sum + lot.units, 0);
  const avgPrice = volume > 0 ? own.reduce((sum, lot) => sum + lot.units * lot.entryPrice, 0) / volume : undefined;
  const text = applyLotChange(await readFile(portfolioPath(), "utf8"), currency, lots, {
    ticker,
    volume,
    avgPrice,
    ...(newStopLoss !== undefined ? { newStopLoss } : {}),
    ...(currentPrice !== undefined ? { currentPrice } : {}),
  });
  await writeFile(portfolioPath(), text, "utf8");
}

// ─── The edit of `portfolio.md` that `decision:record` made for a lot change (removed from the engine in #152) ───

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
function applyLotChange(md: string, currency: Currency, lots: readonly Lot[], change: PositionChange): string {
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
