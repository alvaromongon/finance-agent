// The engine's own store of the portfolio (#132, spec #124, ADR-0018): the state of both silos as JSON that only
// the engine writes, and `portfolio.md` as a read-only view generated from it. Pure: no I/O. Part of the storage
// layer, behind the portfolio store (`portfolio-store.ts`): the flows see `PortfolioSnapshot`, never this text.
//
// - `encodeStore` / `decodeStore`: the JSON text and the strict reader of it. Numbers are plain decimal text
//   (never an exponent, so nothing reads `1e-8` differently); every amount of money carries its currency.
// - `renderView`: the Markdown view, in the tables the old reader reads, so the two stay one format.
// - `withLotChange` / `withPrices`: the edits `decision:record` and the price refresh make to a silo of the store.
import { canCountInCents, money, type Money } from "../money.js";
import { checkTicker, type Ticker } from "../ticker.js";
import { CURRENCIES, type Currency, type Lot, type PortfolioSnapshot, type Position } from "../types.js";
import { DECISION_ORIGINS, type DecisionOrigin } from "../decisions.js";
import { numberFormat, type PositionChange } from "./portfolio-writer.js";
import { UNITS_TOLERANCE } from "./units.js";

/** Version of the store's format; a store of another version is refused, never read partially. */
export const STORE_VERSION = 1;

/**
 * A batch of the inbox that was applied and whose file is not moved to `applied/` yet: its name and the hash of its
 * text. It is written with the state, so a run that finds the file still in `inbox/` moves it and does not apply it twice.
 */
export interface AppliedBatch {
  file: string;
  sha256: string;
  /** ISO timestamp of when it was applied. */
  at: string;
}

/** The whole store: each silo the portfolio has, the account kind and the batches applied. */
export interface PortfolioStore {
  silos: { readonly [C in Currency]?: PortfolioSnapshot<C> };
  /** `demo` | `real` when the portfolio says; kept from the old file and written to the view's frontmatter. */
  accountEnv?: string;
  /** The batches applied whose files are still in `inbox/`: a file seen again with the same hash was applied already. */
  unmoved: AppliedBatch[];
  /**
   * The decision-log lines of the trades applied that are not in the log yet, as the log writes them. They are
   * written with the state, so the state and the lines it needs are committed together: a run that finds some left
   * appends the ones the log does not hold (by id) and clears them.
   */
  pendingDecisions: string[];
}

// ─── Plain decimal ────────────────────────────────────────────────────────────

/** A finite number as plain decimal text: digits and a point, no exponent; it reads back as the very same number. */
export function plainDecimal(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`the store holds finite numbers only; got: ${n}`);
  const text = String(n);
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (match === null) return text === "-0" ? "0" : text;
  const [, sign, first, rest = "", exponent] = match;
  const digits = first + rest;
  const shift = Number(exponent) + 1; // where the point goes, counted from the start of `digits`
  if (shift <= 0) return `${sign}0.${"0".repeat(-shift)}${digits}`;
  if (shift >= digits.length) return `${sign}${digits}${"0".repeat(shift - digits.length)}`;
  return `${sign}${digits.slice(0, shift)}.${digits.slice(shift)}`;
}

const decimalOrNull = (n: number | null): string | null => (n === null ? null : plainDecimal(n));

const amountText = (amount: number, currency: Currency): string => `${amount.toFixed(2)} ${currency}`;

// ─── Encoding ─────────────────────────────────────────────────────────────────

const encodeLot = (lot: Lot, currency: Currency) => ({
  entry_id: lot.entryId,
  ticker: lot.ticker,
  date: lot.date,
  units: plainDecimal(lot.units),
  entry_units: plainDecimal(lot.entryUnits),
  entry_price: plainDecimal(lot.entryPrice),
  initial_stop: decimalOrNull(lot.initialStop),
  entry_costs: lot.entryCosts === null ? null : amountText(lot.entryCosts, currency),
  origin: lot.origin,
  rules_version: lot.rulesVersion,
  rules_violations: lot.rulesViolations,
});

const encodePosition = (p: Position, currency: Currency) => ({
  ticker: p.ticker,
  volume: plainDecimal(p.volume),
  avg_price: plainDecimal(p.avgPrice),
  current_price: plainDecimal(p.currentPrice),
  pl: amountText(p.pl, currency),
  stop_loss: decimalOrNull(p.stopLoss),
});

const encodeSilo = (silo: PortfolioSnapshot) => ({
  synced_at: silo.syncedAt,
  cash: amountText(silo.cash, silo.currency),
  ...(silo.totalCash !== undefined ? { total_cash: amountText(silo.totalCash, silo.currency) } : {}),
  positions: silo.positions.map((p) => encodePosition(p, silo.currency)),
  lots: silo.lots.map((l) => encodeLot(l, silo.currency)),
});

/** The text of the store file. */
export function encodeStore(store: PortfolioStore): string {
  const silos = Object.fromEntries(
    CURRENCIES.flatMap((currency) => {
      const silo = store.silos[currency];
      return silo === undefined ? [] : [[currency, encodeSilo(silo)]];
    }),
  );
  const document = {
    schema_version: STORE_VERSION,
    ...(store.accountEnv !== undefined ? { account_env: store.accountEnv } : {}),
    unmoved_batches: store.unmoved,
    pending_decisions: store.pendingDecisions,
    silos,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ─── Decoding ─────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

/** Reads the text of the store file; an error names `where` and what is wrong, and nothing is guessed. */
export function decodeStore(text: string, where: string): PortfolioStore {
  const fail = (path: string, problem: string): never => {
    throw new Error(`${where}: ${path}: ${problem}`);
  };
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    return fail("file", `is not valid JSON (${(err as Error).message})`);
  }
  const object = (value: unknown, path: string): Json =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Json)
      : fail(path, "must be an object");
  const array = (value: unknown, path: string): unknown[] =>
    Array.isArray(value) ? value : fail(path, "must be a list");
  const string = (value: unknown, path: string): string =>
    typeof value === "string" ? value : fail(path, "must be text");
  const decimal = (value: unknown, path: string): number => {
    const t = string(value, path);
    if (!/^-?\d+(\.\d+)?$/.test(t)) return fail(path, `must be a plain decimal number; got: ${JSON.stringify(t)}`);
    const n = Number(t);
    return Number.isFinite(n) ? n : fail(path, `is not a finite number; got: ${JSON.stringify(t)}`);
  };
  const amount = <C extends Currency>(value: unknown, path: string, currency: C): Money<C> => {
    const t = string(value, path);
    const match = /^(-?\d+\.\d{2}) (EUR|USD)$/.exec(t);
    if (match === null) return fail(path, `must be an amount in cents and its currency; got: ${JSON.stringify(t)}`);
    if (match[2] !== currency) return fail(path, `is in ${match[2]}, not in the silo's ${currency}`);
    const n = Number(match[1]);
    return canCountInCents(n) ? money(n, currency) : fail(path, "is too large to count in cents");
  };
  const optional = <T>(value: unknown, read: (v: unknown) => T): T | null => (value === null ? null : read(value));
  const ticker = (value: unknown, path: string): Ticker => {
    const checked = checkTicker(value);
    return "ticker" in checked ? checked.ticker : fail(path, checked.problem);
  };

  const doc = object(root, "file");
  if (doc.schema_version !== STORE_VERSION) {
    fail("schema_version", `must be ${STORE_VERSION}; got: ${JSON.stringify(doc.schema_version)}`);
  }
  const silos: { EUR?: PortfolioSnapshot<"EUR">; USD?: PortfolioSnapshot<"USD"> } = {};
  const readSilo = <C extends Currency>(currency: C, raw: unknown): PortfolioSnapshot<C> => {
    const at = `silos.${currency}`;
    const s = object(raw, at);
    const positions = array(s.positions, `${at}.positions`).map((p, i): Position<C> => {
      const path = `${at}.positions[${i}]`;
      const o = object(p, path);
      return {
        ticker: ticker(o.ticker, `${path}.ticker`),
        currency,
        volume: decimal(o.volume, `${path}.volume`),
        avgPrice: decimal(o.avg_price, `${path}.avg_price`),
        currentPrice: decimal(o.current_price, `${path}.current_price`),
        pl: amount(o.pl, `${path}.pl`, currency),
        stopLoss: optional(o.stop_loss, (v) => decimal(v, `${path}.stop_loss`)),
      };
    });
    const lots = array(s.lots, `${at}.lots`).map((l, i): Lot<C> => {
      const path = `${at}.lots[${i}]`;
      const o = object(l, path);
      const origin = string(o.origin, `${path}.origin`);
      if (!DECISION_ORIGINS.includes(origin as DecisionOrigin)) fail(`${path}.origin`, `unknown origin ${origin}`);
      return {
        ticker: ticker(o.ticker, `${path}.ticker`),
        entryId: string(o.entry_id, `${path}.entry_id`),
        date: string(o.date, `${path}.date`),
        units: decimal(o.units, `${path}.units`),
        entryUnits: decimal(o.entry_units, `${path}.entry_units`),
        entryPrice: decimal(o.entry_price, `${path}.entry_price`),
        initialStop: optional(o.initial_stop, (v) => decimal(v, `${path}.initial_stop`)),
        entryCosts: optional(o.entry_costs, (v) => amount(v, `${path}.entry_costs`, currency)),
        origin: origin as DecisionOrigin,
        rulesVersion: string(o.rules_version, `${path}.rules_version`),
        rulesViolations: array(o.rules_violations, `${path}.rules_violations`).map((v, k) =>
          string(v, `${path}.rules_violations[${k}]`),
        ),
      };
    });
    return {
      currency,
      cash: amount(s.cash, `${at}.cash`, currency),
      ...(s.total_cash !== undefined ? { totalCash: amount(s.total_cash, `${at}.total_cash`, currency) } : {}),
      positions,
      lots,
      syncedAt: string(s.synced_at, `${at}.synced_at`),
    };
  };
  const rawSilos = object(doc.silos, "silos");
  for (const key of Object.keys(rawSilos)) {
    if (!CURRENCIES.includes(key as Currency)) fail(`silos.${key}`, "is not a silo (EUR or USD)");
  }
  if (rawSilos.EUR !== undefined) silos.EUR = readSilo("EUR", rawSilos.EUR);
  if (rawSilos.USD !== undefined) silos.USD = readSilo("USD", rawSilos.USD);
  const unmoved = array(doc.unmoved_batches, "unmoved_batches").map((a, i): AppliedBatch => {
    const o = object(a, `unmoved_batches[${i}]`);
    return {
      file: string(o.file, `unmoved_batches[${i}].file`),
      sha256: string(o.sha256, `unmoved_batches[${i}].sha256`),
      at: string(o.at, `unmoved_batches[${i}].at`),
    };
  });
  const pendingDecisions = array(doc.pending_decisions, "pending_decisions").map((line, i) =>
    string(line, `pending_decisions[${i}]`),
  );
  return {
    silos,
    ...(doc.account_env !== undefined ? { accountEnv: string(doc.account_env, "account_env") } : {}),
    unmoved,
    pendingDecisions,
  };
}

// ─── The Markdown view ────────────────────────────────────────────────────────

/** A cell of the view: the text of the engine's state, with what would break a table row made harmless. */
const cell = (text: string): string => text.replace(/[|\r\n]+/g, "/");

const NONE = "—";
const numberOrNone = (n: number | null, format: (n: number) => string): string => (n === null ? NONE : format(n));
const LOT_HEADER = [
  "Ticker",
  "Entry id",
  "Date",
  "Units",
  "Entry units",
  "Entry price",
  "Initial stop",
  "Entry costs",
  "Origin",
  "Rules version",
  "Rules violations",
];
const POSITION_HEADER = ["Ticker", "Volume", "Avg price", "Current price", "P/L", "Stop loss"];

const table = (header: readonly string[], rows: readonly (readonly string[])[]): string[] => [
  `| ${header.join(" | ")} |`,
  `|${header.map(() => "---").join("|")}|`,
  ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
];

/**
 * The Markdown view of the store: what the owner reads in a notes app. Generated, read-only: the engine
 * overwrites it each time the store changes, and no flow reads it as a source.
 */
export function renderView(store: PortfolioStore): string {
  const syncs = CURRENCIES.flatMap((c) => store.silos[c]?.syncedAt ?? []).sort();
  const lines = [
    "---",
    "schema_version: 2",
    `last_manual_sync: ${syncs.at(-1) ?? new Date(0).toISOString()}`,
    ...(store.accountEnv !== undefined ? [`account_env: ${store.accountEnv}`] : []),
    "---",
    "",
    "# Portfolio",
    "",
    "Generated by the engine from `state/portfolio.json`: do not edit it, the next change overwrites it.",
    "To change the portfolio, drop a batch of commands in `inbox/` (`docs/input-format.md`).",
    "",
  ];
  for (const currency of CURRENCIES) {
    const silo = store.silos[currency];
    if (silo === undefined) continue;
    const num = numberFormat(currency);
    const money2 = (n: number): string => (currency === "EUR" ? `${num(n, 2)} €` : `$${num(n, 2)}`);
    lines.push(
      `## ${currency} — Cash`,
      "",
      ...table(
        ["Item", "Value"],
        [
          ["Available cash", money2(silo.cash)],
          ...(silo.totalCash !== undefined ? [["Total cash", money2(silo.totalCash)]] : []),
        ],
      ),
      "",
      `## ${currency} — Positions`,
      "",
      ...table(
        POSITION_HEADER,
        silo.positions.map((p) => [
          p.ticker,
          num(p.volume, 0),
          num(p.avgPrice, 2),
          num(p.currentPrice, 2),
          num(p.pl, 2),
          numberOrNone(p.stopLoss, (n) => num(n, 2)),
        ]),
      ),
      "",
      `## ${currency} — Lots`,
      "",
      ...table(
        LOT_HEADER,
        silo.lots.map((l) => [
          l.ticker,
          l.entryId,
          l.date,
          num(l.units, 0),
          num(l.entryUnits, 0),
          num(l.entryPrice, 2),
          numberOrNone(l.initialStop, (n) => num(n, 2)),
          numberOrNone(l.entryCosts, (n) => num(n, 2)),
          l.origin,
          l.rulesVersion === "" ? NONE : l.rulesVersion,
          l.rulesViolations.length > 0 ? l.rulesViolations.join(", ") : NONE,
        ]),
      ),
      "",
    );
  }
  return lines.join("\n");
}

// ─── Edits of a silo ──────────────────────────────────────────────────────────

/**
 * The silo with `lots` as its open lots and the position of `change.ticker` created, changed or deleted, the way
 * `applyLotChange` edits the old file: the row keeps its own prices and stop, a new one takes `newStopLoss` and
 * `currentPrice` (the average price if absent), and a volume of nothing deletes it.
 */
export function withLotChange<C extends Currency>(
  silo: PortfolioSnapshot<C>,
  lots: readonly Lot<C>[],
  change: PositionChange,
): PortfolioSnapshot<C> {
  const held = silo.positions.find((p) => p.ticker === change.ticker);
  const others = silo.positions.filter((p) => p.ticker !== change.ticker);
  let positions: Position<C>[];
  if (change.volume <= UNITS_TOLERANCE) positions = others;
  else if (held !== undefined) {
    positions = silo.positions.map((p) =>
      p === held ? { ...p, volume: change.volume, avgPrice: change.avgPrice ?? p.avgPrice } : p,
    );
  } else {
    const avgPrice = change.avgPrice ?? 0;
    positions = [
      ...others,
      {
        ticker: change.ticker,
        currency: silo.currency,
        volume: change.volume,
        avgPrice,
        currentPrice: change.currentPrice ?? avgPrice,
        pl: money(0, silo.currency),
        stopLoss: change.newStopLoss ?? null,
      },
    ];
  }
  return { ...silo, lots: [...lots], positions };
}

/**
 * The silo with the `Current price` and `P/L` of the positions that have a price (`(price - avg price) x volume`);
 * `null` if nothing changes. A P/L too large to count in cents is not written: the row keeps the one it had, as the
 * refresh of the old file is never refused (ADR-0015).
 */
export function withPrices<C extends Currency>(
  silo: PortfolioSnapshot<C>,
  prices: ReadonlyMap<Ticker, number>,
): PortfolioSnapshot<C> | null {
  let changed = false;
  const positions = silo.positions.map((p) => {
    const price = prices.get(p.ticker);
    if (price === undefined || !Number.isFinite(price)) return p;
    const raw = (price - p.avgPrice) * p.volume;
    const pl = canCountInCents(raw) ? money(raw, silo.currency) : p.pl;
    if (price === p.currentPrice && pl === p.pl) return p;
    changed = true;
    return { ...p, currentPrice: price, pl };
  });
  return changed ? { ...silo, positions } : null;
}
