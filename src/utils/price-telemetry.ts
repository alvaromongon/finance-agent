// The last prices (#133, spec #124): what the heartbeat and the Monday briefing see of the market, kept as telemetry,
// outside the engine's state. Pure: no I/O. The state holds what the owner told the engine (`portfolio.json`, written by
// `inbox:ingest` alone); a price is something the engine observed, so a heartbeat or a briefing writes it here and never
// there.
//
// - `PriceTelemetry`: per silo, per ticker, the last price seen and the position it was seen against (its `volume` and
//   `avgPrice`). A trade, a split or a sale changes those two, so a price seen before it no longer applies to the position
//   (a buy at 100 is not shown at yesterday's 98, and a split's old price is never shown over the adjusted position).
// - `observePrices`: the silo's observations after a refresh, or `null` when nothing changes (a run that sees the same
//   prices writes nothing).
// - `withObservedPrices`: the silo with the last prices over its positions; the P/L is derived, as the refresh derived it.
// - `encodeTelemetry` / `decodeTelemetry`: the JSON text of the file, plain decimals like the store's.
import type { Ticker } from "../ticker.js";
import { CURRENCIES, type Currency, type PortfolioSnapshot, type Position } from "../types.js";
import { plainDecimal, withPrices } from "./portfolio-json.js";

/** Version of the telemetry file's format; a file of another version is ignored, never read partially. */
export const TELEMETRY_VERSION = 1;

/** The last price seen of a position, and the position (`volume`, `avgPrice`) it was seen against. */
export interface PriceObservation {
  price: number;
  volume: number;
  avgPrice: number;
}

/** The observations of one silo, by ticker. */
export type SiloObservations = Readonly<Record<string, PriceObservation>>;

/** The last prices of every silo. */
export type PriceTelemetry = Readonly<Partial<Record<Currency, SiloObservations>>>;

/** Whether the observation was made against the position as it is now. */
const appliesTo = (position: Pick<Position, "volume" | "avgPrice">, seen: PriceObservation): boolean =>
  seen.volume === position.volume && seen.avgPrice === position.avgPrice;

const sameObservation = (a: PriceObservation, b: PriceObservation): boolean =>
  a.price === b.price && a.volume === b.volume && a.avgPrice === b.avgPrice;

/**
 * The silo's observations once `prices` are seen: the price of each position that has a finite one, and, for a position
 * without one, the observation it already had if that still applies to it. A ticker that is no longer a position is
 * dropped, so the file is as long as the portfolio. `null` if the result is what `previous` already was.
 */
export function observePrices(
  silo: PortfolioSnapshot,
  prices: ReadonlyMap<Ticker, number>,
  previous: SiloObservations = {},
): SiloObservations | null {
  const next: Record<string, PriceObservation> = {};
  for (const position of silo.positions) {
    const price = prices.get(position.ticker);
    const kept = previous[position.ticker];
    if (price !== undefined && Number.isFinite(price)) {
      next[position.ticker] = { price, volume: position.volume, avgPrice: position.avgPrice };
    } else if (kept !== undefined && appliesTo(position, kept)) {
      next[position.ticker] = kept;
    }
  }
  const tickers = Object.keys(next);
  const unchanged =
    tickers.length === Object.keys(previous).length &&
    tickers.every((ticker) => previous[ticker] !== undefined && sameObservation(previous[ticker], next[ticker]));
  return unchanged ? null : next;
}

/**
 * The silo with the last price (and the P/L it gives, `(price - Avg price) × Volume`) over each position the price was seen
 * against. A position the observation does not apply to keeps what the state says. The same silo, untouched, when nothing applies.
 */
export function withObservedPrices<C extends Currency>(
  silo: PortfolioSnapshot<C>,
  seen: SiloObservations | undefined,
): PortfolioSnapshot<C> {
  if (seen === undefined) return silo;
  const prices = new Map<Ticker, number>();
  for (const position of silo.positions) {
    const observation = seen[position.ticker];
    if (observation !== undefined && appliesTo(position, observation)) prices.set(position.ticker, observation.price);
  }
  return withPrices(silo, prices) ?? silo;
}

// ─── The file ─────────────────────────────────────────────────────────────────

/** The text of the telemetry file: tickers in order, so the same prices are the same bytes. */
export function encodeTelemetry(telemetry: PriceTelemetry): string {
  const silos = Object.fromEntries(
    CURRENCIES.flatMap((currency) => {
      const seen = telemetry[currency];
      if (seen === undefined) return [];
      const entries = Object.keys(seen)
        .sort()
        .map((ticker) => [
          ticker,
          {
            price: plainDecimal(seen[ticker].price),
            volume: plainDecimal(seen[ticker].volume),
            avg_price: plainDecimal(seen[ticker].avgPrice),
          },
        ]);
      return [[currency, Object.fromEntries(entries)]];
    }),
  );
  return `${JSON.stringify({ schema_version: TELEMETRY_VERSION, silos }, null, 2)}\n`;
}

/** Reads the text of the telemetry file; an error names `where` and what is wrong, and nothing is guessed. */
export function decodeTelemetry(text: string, where: string): PriceTelemetry {
  const fail = (path: string, problem: string): never => {
    throw new Error(`${where}: ${path}: ${problem}`);
  };
  const object = (value: unknown, path: string): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : fail(path, "must be an object");
  const decimal = (value: unknown, path: string): number => {
    if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value)) return fail(path, "must be a plain decimal text");
    return Number(value);
  };
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    return fail("file", `is not valid JSON (${(err as Error).message})`);
  }
  const document = object(root, "file");
  if (document.schema_version !== TELEMETRY_VERSION) {
    fail("schema_version", `must be ${TELEMETRY_VERSION}; got: ${JSON.stringify(document.schema_version)}`);
  }
  const silos = object(document.silos, "silos");
  const telemetry: Partial<Record<Currency, SiloObservations>> = {};
  for (const [currency, value] of Object.entries(silos)) {
    if (!CURRENCIES.includes(currency as Currency)) fail(`silos.${currency}`, "is not a silo of the engine");
    const observations: Record<string, PriceObservation> = {};
    for (const [ticker, raw] of Object.entries(object(value, `silos.${currency}`))) {
      const at = `silos.${currency}.${ticker}`;
      const entry = object(raw, at);
      observations[ticker] = {
        price: decimal(entry.price, `${at}.price`),
        volume: decimal(entry.volume, `${at}.volume`),
        avgPrice: decimal(entry.avg_price, `${at}.avg_price`),
      };
    }
    telemetry[currency as Currency] = observations;
  }
  return telemetry;
}
