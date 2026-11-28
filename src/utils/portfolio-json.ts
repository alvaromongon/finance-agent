// The engine's own store of the portfolio (#132, spec #124, ADR-0018): the state of both silos as JSON that only
// the engine writes, and `portfolio.md` as a read-only view generated from it. Pure: no I/O. Part of the storage
// layer, behind the portfolio store (`portfolio-store.ts`): the flows see `PortfolioSnapshot`, never this text.
//
// - `encodeStore` / `decodeStore`: the JSON text and the strict reader of it. Numbers are plain decimal text
//   (never an exponent, so nothing reads `1e-8` differently); every amount of money carries its currency.
// - `renderView`: the Markdown view, in the tables the old reader reads, so the two stay one format.
// - `withPrices`: the silo with the given prices over its positions (the last prices, `utils/price-telemetry.ts`).
// - The watchlist (#140) is part of the store too: `watchlist` (the entries) and `starting_watchlist` (the entries the
//   store began with, from `watchlist.md`, what a correction and the repair replay the `watch` and `stop_watching`
//   commands over). `renderWatchlistView` is `watchlist.md`, generated from it.
import { asNumber, canCountInCents, money, type Money } from "../money.js";
import { checkTicker, type Ticker } from "../ticker.js";
import yaml from "js-yaml";
import {
  ASSET_CLASSES,
  CURRENCIES,
  HORIZONS,
  type AssetClass,
  type Currency,
  type Difference,
  type Horizon,
  type Lot,
  type PortfolioSnapshot,
  type Position,
  type Reconciliation,
  type WatchlistEntry,
} from "../types.js";
import { DECISION_ORIGINS, type DecisionOrigin } from "../decisions.js";
import { numberFormat } from "./portfolio-writer.js";

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

/**
 * A rejected batch that is settled: a later batch replaced it (`replaces:`) or discarded it (`discard`). The file stays
 * in `inbox/rejected/` as the audit trail; the hash of its text tells it from a file that is later moved there under
 * the same name. The rejected batches not listed here are the ones awaiting a replacement or a discard (#152).
 */
export interface ResolvedRejection {
  /** The file name in `inbox/rejected/`. */
  file: string;
  sha256: string;
  how: "replaced" | "discarded";
  /** The batch that settled it, by its file name in `inbox/`. */
  by: string;
  /** ISO timestamp of when it was settled. */
  at: string;
}

/**
 * A pending escalation that was closed (#141): a `resolve` command said it was answered or given up. The signal's file
 * stays in `logs/pending/` as the record; the hash of its text tells it from a file written later under the same name
 * (a new escalation). The pending escalations not listed here are the ones still open, named in every digest.
 */
export interface ClosedEscalationRecord {
  /** The id of the escalation: its file in `logs/pending/` without `.md`. */
  id: string;
  sha256: string;
  outcome: "resolved" | "discarded";
  note?: string;
  /** YYYY-MM-DD: the day it was closed. */
  date: string;
  /** The batch that closed it, by its file name in `inbox/`. */
  by: string;
  /** ISO timestamp of when it was closed. */
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
  /** The rejected batches that were replaced or discarded, see `ResolvedRejection`. */
  resolvedRejections: ResolvedRejection[];
  /** The pending escalations that were closed, see `ClosedEscalationRecord`. */
  closedEscalations: ClosedEscalationRecord[];
  /**
   * The silos as the store began, from `portfolio.md` (#139): what the batches in `inbox/applied/` are replayed over by a
   * correction and by the repair. Absent in a store that began empty.
   */
  starting?: { readonly [C in Currency]?: PortfolioSnapshot<C> };
  /**
   * The watchlist (#140): what `watch` and `stop_watching` change and every flow reads. Absent while the state is still
   * the old `watchlist.md`; the first `inbox:ingest` after that seeds it from the file. A ticker is on it once.
   */
  watchlist?: WatchlistEntry[];
  /** The watchlist as the store began, from `watchlist.md`: present exactly when `watchlist` is (`starting` is for the silos). */
  startingWatchlist?: WatchlistEntry[];
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

const amountText = <C extends Currency>(amount: Money<C>, currency: C): string =>
  `${asNumber(amount).toFixed(2)} ${currency}`;

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

const encodeDifference = (d: Difference, currency: Currency) =>
  d.kind === "cash"
    ? { kind: "cash", broker: amountText(d.broker, currency), engine: amountText(d.engine, currency) }
    : { kind: "position", ticker: d.ticker, broker: plainDecimal(d.broker), engine: plainDecimal(d.engine) };

const encodeSilo = (silo: PortfolioSnapshot) => ({
  synced_at: silo.syncedAt,
  ...(silo.reconciled !== undefined
    ? {
        reconciled: {
          date: silo.reconciled.date,
          ...(silo.reconciled.recordedOn !== undefined ? { recorded_on: silo.reconciled.recordedOn } : {}),
          differences: silo.reconciled.differences.map((d) => encodeDifference(d, silo.currency)),
        },
      }
    : {}),
  cash: amountText(silo.cash, silo.currency),
  ...(silo.totalCash !== undefined ? { total_cash: amountText(silo.totalCash, silo.currency) } : {}),
  positions: silo.positions.map((p) => encodePosition(p, silo.currency)),
  lots: silo.lots.map((l) => encodeLot(l, silo.currency)),
});

const encodeEntry = (e: WatchlistEntry) => ({
  ticker: e.ticker,
  currency: e.currency,
  horizon: e.horizon,
  ...(e.asset_class !== undefined ? { asset_class: e.asset_class } : {}),
  thesis: e.thesis,
  ...(e.thesis_link !== undefined ? { thesis_link: e.thesis_link } : {}),
  ...(e.name !== undefined ? { name: e.name } : {}),
  ...(e.market !== undefined ? { market: e.market } : {}),
  ...(e.date !== undefined ? { date: e.date } : {}),
});

const encodeSilos = (silos: PortfolioStore["silos"]) =>
  Object.fromEntries(
    CURRENCIES.flatMap((currency) => {
      const silo = silos[currency];
      return silo === undefined ? [] : [[currency, encodeSilo(silo)]];
    }),
  );

/** The text of the store file. */
export function encodeStore(store: PortfolioStore): string {
  const silos = encodeSilos(store.silos);
  const document = {
    schema_version: STORE_VERSION,
    ...(store.accountEnv !== undefined ? { account_env: store.accountEnv } : {}),
    unmoved_batches: store.unmoved,
    pending_decisions: store.pendingDecisions,
    resolved_rejections: store.resolvedRejections.map((r) => ({
      file: r.file,
      sha256: r.sha256,
      how: r.how,
      by: r.by,
      at: r.at,
    })),
    closed_escalations: store.closedEscalations.map((c) => ({
      id: c.id,
      sha256: c.sha256,
      outcome: c.outcome,
      ...(c.note !== undefined ? { note: c.note } : {}),
      date: c.date,
      by: c.by,
      at: c.at,
    })),
    silos,
    ...(store.starting !== undefined ? { starting_silos: encodeSilos(store.starting) } : {}),
    ...(store.watchlist !== undefined ? { watchlist: store.watchlist.map(encodeEntry) } : {}),
    ...(store.startingWatchlist !== undefined ? { starting_watchlist: store.startingWatchlist.map(encodeEntry) } : {}),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ─── Decoding ─────────────────────────────────────────────────────────────────

/** A real calendar date, YYYY-MM-DD. */
function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

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
  const readSilo = <C extends Currency>(currency: C, raw: unknown, root: string): PortfolioSnapshot<C> => {
    const at = `${root}.${currency}`;
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
    // A silo never reconciled has no `reconciled`: it is stale until a snapshot says otherwise (#138).
    const reconciled = (value: unknown): Reconciliation<C> => {
      const path = `${at}.reconciled`;
      const o = object(value, path);
      const date = string(o.date, `${path}.date`);
      if (!isCalendarDate(date))
        fail(`${path}.date`, `must be a calendar date as YYYY-MM-DD; got: ${JSON.stringify(date)}`);
      const differences = array(o.differences, `${path}.differences`).map((d, i): Difference<C> => {
        const at = `${path}.differences[${i}]`;
        const entry = object(d, at);
        if (entry.kind === "cash") {
          return {
            kind: "cash",
            broker: amount(entry.broker, `${at}.broker`, currency),
            engine: amount(entry.engine, `${at}.engine`, currency),
          };
        }
        if (entry.kind !== "position") return fail(`${at}.kind`, 'must be "cash" or "position"');
        return {
          kind: "position",
          ticker: ticker(entry.ticker, `${at}.ticker`),
          broker: decimal(entry.broker, `${at}.broker`),
          engine: decimal(entry.engine, `${at}.engine`),
        };
      });
      const recordedOn = o.recorded_on === undefined ? undefined : string(o.recorded_on, `${path}.recorded_on`);
      if (recordedOn !== undefined && !isCalendarDate(recordedOn))
        fail(`${path}.recorded_on`, `must be a calendar date as YYYY-MM-DD; got: ${JSON.stringify(recordedOn)}`);
      return { date, ...(recordedOn !== undefined ? { recordedOn } : {}), differences };
    };
    return {
      currency,
      cash: amount(s.cash, `${at}.cash`, currency),
      ...(s.total_cash !== undefined ? { totalCash: amount(s.total_cash, `${at}.total_cash`, currency) } : {}),
      positions,
      lots,
      syncedAt: string(s.synced_at, `${at}.synced_at`),
      ...(s.reconciled !== undefined ? { reconciled: reconciled(s.reconciled) } : {}),
    };
  };
  const readSilos = (value: unknown, root: string): PortfolioStore["silos"] => {
    const raw = object(value, root);
    for (const key of Object.keys(raw)) {
      if (!CURRENCIES.includes(key as Currency)) fail(`${root}.${key}`, "is not a silo (EUR or USD)");
    }
    return {
      ...(raw.EUR !== undefined ? { EUR: readSilo("EUR", raw.EUR, root) } : {}),
      ...(raw.USD !== undefined ? { USD: readSilo("USD", raw.USD, root) } : {}),
    };
  };
  const silos = readSilos(doc.silos, "silos");
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
  // A store written before #152 has no such list: nothing was settled then.
  const resolvedRejections = (
    doc.resolved_rejections === undefined ? [] : array(doc.resolved_rejections, "resolved_rejections")
  ).map((r, i): ResolvedRejection => {
    const path = `resolved_rejections[${i}]`;
    const o = object(r, path);
    const how = string(o.how, `${path}.how`);
    if (how !== "replaced" && how !== "discarded") fail(`${path}.how`, 'must be "replaced" or "discarded"');
    return {
      file: string(o.file, `${path}.file`),
      sha256: string(o.sha256, `${path}.sha256`),
      how: how as ResolvedRejection["how"],
      by: string(o.by, `${path}.by`),
      at: string(o.at, `${path}.at`),
    };
  });
  const readWatchlist = (value: unknown, root: string): WatchlistEntry[] => {
    const seen = new Set<string>();
    return array(value, root).map((item, i): WatchlistEntry => {
      const path = `${root}[${i}]`;
      const o = object(item, path);
      const t = ticker(o.ticker, `${path}.ticker`);
      if (seen.has(t)) fail(`${path}.ticker`, `${t} is already on the list`);
      seen.add(t);
      const currency = string(o.currency, `${path}.currency`);
      if (!CURRENCIES.includes(currency as Currency)) fail(`${path}.currency`, "must be EUR or USD");
      const horizon = string(o.horizon, `${path}.horizon`);
      if (!HORIZONS.includes(horizon as Horizon)) fail(`${path}.horizon`, "must be short or medium");
      const assetClass = o.asset_class === undefined ? undefined : string(o.asset_class, `${path}.asset_class`);
      if (assetClass !== undefined && !ASSET_CLASSES.includes(assetClass as AssetClass)) {
        fail(`${path}.asset_class`, "must be equity, commodity or etf");
      }
      const date = o.date === undefined ? undefined : string(o.date, `${path}.date`);
      if (date !== undefined && !isCalendarDate(date)) {
        fail(`${path}.date`, `must be a calendar date as YYYY-MM-DD; got: ${JSON.stringify(date)}`);
      }
      const optionalText = (name: string): string | undefined =>
        o[name] === undefined ? undefined : string(o[name], `${path}.${name}`);
      const [thesisLink, name, market] = [optionalText("thesis_link"), optionalText("name"), optionalText("market")];
      return {
        ticker: t,
        currency: currency as Currency,
        horizon: horizon as Horizon,
        ...(assetClass !== undefined ? { asset_class: assetClass as AssetClass } : {}),
        thesis: string(o.thesis, `${path}.thesis`),
        ...(thesisLink !== undefined ? { thesis_link: thesisLink } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(market !== undefined ? { market } : {}),
        ...(date !== undefined ? { date } : {}),
      };
    });
  };
  // The two lists come together: a store with one and not the other is not one this engine wrote.
  if ((doc.watchlist === undefined) !== (doc.starting_watchlist === undefined)) {
    fail(
      doc.watchlist === undefined ? "watchlist" : "starting_watchlist",
      "is missing: the store has one and not the other",
    );
  }
  const closedEscalations = (
    doc.closed_escalations === undefined ? [] : array(doc.closed_escalations, "closed_escalations")
  ).map((r, i): ClosedEscalationRecord => {
    const path = `closed_escalations[${i}]`;
    const o = object(r, path);
    const outcome = string(o.outcome, `${path}.outcome`);
    if (outcome !== "resolved" && outcome !== "discarded") fail(`${path}.outcome`, 'must be "resolved" or "discarded"');
    const date = string(o.date, `${path}.date`);
    if (!isCalendarDate(date))
      fail(`${path}.date`, `must be a calendar date as YYYY-MM-DD; got: ${JSON.stringify(date)}`);
    return {
      id: string(o.id, `${path}.id`),
      sha256: string(o.sha256, `${path}.sha256`),
      outcome: outcome as ClosedEscalationRecord["outcome"],
      ...(o.note !== undefined ? { note: string(o.note, `${path}.note`) } : {}),
      date,
      by: string(o.by, `${path}.by`),
      at: string(o.at, `${path}.at`),
    };
  });
  return {
    silos,
    ...(doc.account_env !== undefined ? { accountEnv: string(doc.account_env, "account_env") } : {}),
    unmoved,
    pendingDecisions,
    resolvedRejections,
    closedEscalations,
    ...(doc.starting_silos !== undefined ? { starting: readSilos(doc.starting_silos, "starting_silos") } : {}),
    ...(doc.watchlist !== undefined ? { watchlist: readWatchlist(doc.watchlist, "watchlist") } : {}),
    ...(doc.starting_watchlist !== undefined
      ? { startingWatchlist: readWatchlist(doc.starting_watchlist, "starting_watchlist") }
      : {}),
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
    const money2 = (amount: Money): string =>
      currency === "EUR" ? `${num(asNumber(amount), 2)} €` : `$${num(asNumber(amount), 2)}`;
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
          num(asNumber(p.pl), 2),
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
          numberOrNone(l.entryCosts === null ? null : asNumber(l.entryCosts), (n) => num(n, 2)),
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

/**
 * `watchlist.md` as the engine generates it from the store: the first ```yaml block of the file of the old format
 * (`schema_version: 1`), in the order of the list, with a note that it is generated. Nothing reads it as a source while
 * the store holds the watchlist; it is for the owner's notes app.
 */
export function renderWatchlistView(store: PortfolioStore): string {
  const entries = (store.watchlist ?? []).map((e) => ({
    ticker: e.ticker,
    ...(e.name !== undefined ? { name: e.name } : {}),
    ...(e.market !== undefined ? { market: e.market } : {}),
    currency: e.currency,
    horizon: e.horizon,
    ...(e.asset_class !== undefined ? { asset_class: e.asset_class } : {}),
    thesis: e.thesis,
    ...(e.thesis_link !== undefined ? { thesis_link: e.thesis_link } : {}),
    ...(e.date !== undefined ? { date: e.date } : {}),
  }));
  return [
    "---",
    "schema_version: 1",
    "---",
    "",
    "# Watchlist",
    "",
    "Generated by the engine from `state/portfolio.json`: do not edit it, the next change overwrites it.",
    "To change the watchlist, drop a `watch` or `stop_watching` command in `inbox/` (`docs/input-format.md`).",
    "",
    "```yaml",
    yaml.dump({ watchlist: entries }, { lineWidth: 120, quotingType: '"' }).trimEnd(),
    "```",
    "",
  ].join("\n");
}

// ─── Edits of a silo ──────────────────────────────────────────────────────────

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
