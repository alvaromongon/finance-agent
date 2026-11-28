// The portfolio state port (ADR-0015, ADR-0017): the one way every flow reads and writes the portfolio
// (cash, positions, lots). It gives one model, `PortfolioSnapshot<C>`, in which every amount is
// `Money<C>` of the silo's currency, and takes changes as that model's values (lots, a position change,
// prices), never as text. No flow knows what is behind it: the text parsers, the codec and the writer are
// used here and nowhere else (`state-boundary.test.ts` fails when another module reads or writes a state
// file or parses a stored number).
//
// Two modes (#132, expand-contract of spec #124). With the engine's own store, `state/portfolio.json`, the
// store is the state: every read and write goes through it, and `portfolio.md` is a view generated from it
// after each write that nothing reads. Without the store (nobody has run `inbox:ingest` yet) the state is
// still the old `portfolio.md` and everything behaves as before; the first `inbox:ingest` seeds the store from
// it, and #143 removes the old way.
//
// Prices are not state (#133). The heartbeat and the Monday briefing write the last prices to `telemetry/prices-<ccy>.json`,
// never to the store: `inbox:ingest` is the store's only writer. A read puts the last prices over the positions they were seen
// against, and the generated view shows them, so no flow notices where they live.
//
// One read, `readPortfolio`, for every flow. What it could not read is in its result: `lotsProblem` (the
// `Lots` table as such), `portfolio.skippedLotRows` (rows of it), `skippedRows` (`Positions` rows) and
// `unreadableCells`. Each flow keeps its own behaviour on them: the heartbeat reports them and goes on, the
// briefings and the screening ignore the `Lots` and warn of the rest (`ignoringLots`), the
// evaluation refuses (`requireReadable`).
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import type { Ticker } from "./ticker.js";
import {
  ASSET_CLASSES,
  CURRENCIES,
  HORIZONS,
  type Currency,
  type Lot,
  type PortfolioSnapshot,
  type WatchlistEntry,
} from "./types.js";
import { applyPrices } from "./utils/portfolio-writer.js";
import {
  decodeStore,
  encodeStore,
  renderView,
  renderWatchlistView,
  type PortfolioStore,
} from "./utils/portfolio-json.js";
import {
  decodeTelemetry,
  encodeTelemetry,
  observePrices,
  withObservedPrices,
  type PriceTelemetry,
} from "./utils/price-telemetry.js";
import { volumeMismatches } from "./utils/lots-check.js";
import { stalenessOf, type Staleness } from "./utils/staleness.js";
import { addCounted, countedInCents, formatMoney } from "./money.js";
import {
  assertPortfolioSections,
  assertSchemaVersion,
  extractFrontmatter,
  extractYamlBlock,
  parseWatchlistBlock,
  LotsTableError,
  parseCash,
  parseLotRows,
  parsePositions,
  parseTotalCash,
  POSITION_ROW_SKIPPED,
  SiloAbsentError,
} from "./utils/vault-parser.js";

export type { PortfolioStore };

/**
 * The store file exists and cannot be read as the store (#139): it is not valid JSON, has a field the engine does not
 * accept, another version. The message names the file and what is wrong. The state is not guessed from it: the flows refuse it
 * and only the heartbeat goes on, over the last state that read (`readLastReadable`), and says so in its digest.
 */
export class StoreUnreadableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreUnreadableError";
  }
}

/** What `readPortfolio` returns: the silo's model and what of the file could not be read into it. */
export interface PortfolioRead<C extends Currency = Currency> {
  portfolio: PortfolioSnapshot<C>;
  /**
   * Why the `Lots` table cannot be read at all (ADR-0015): a missing or misspelled `Lots` heading, a header that
   * does not read. The portfolio then has no lots. `null` when the table reads; the rows of it that do not are
   * `portfolio.skippedLotRows`. The message starts with file and silo.
   */
  lotsProblem: string | null;
  /** The `Positions` rows skipped because their ticker does not parse (ADR-0016), one message each. */
  skippedRows: string[];
  /** The `Positions` P/L and `Cash` cells too large to count in cents, read as 0 or absent (#86), one message each. */
  unreadableCells: string[];
  /**
   * Set only by a read that asked to go on over a store that does not read (`lastReadable`, the heartbeat): why the store
   * cannot be read. The portfolio is then the last state that did read, so what it holds may be older than the
   * store's last write. Absent when the store (or `portfolio.md`, with no store yet) reads.
   */
  storeProblem?: string;
  /**
   * How stale the silo is (#138): the age of its latest `snapshot` of the broker, and a silo with none is stale. `null`
   * while the state is still the old `portfolio.md` (no store yet): it has no snapshot to measure, and keeps its own
   * `last_manual_sync` warning until #143 removes that way.
   */
  staleness: Staleness | null;
}

const projectDir = () => config.paths.vaultProjectDir;
/** The old state file, and, once the store exists, its generated view. */
const portfolioPath = () => join(projectDir(), "portfolio.md");
/** The engine's own store of the portfolio: JSON written only by the engine. */
const storePath = () => join(projectDir(), "state", "portfolio.json");
const STORE_WHERE = "state/portfolio.json";
/** The old state file of the watchlist, and, once the store holds the watchlist, its generated view. */
const watchlistPath = () => join(projectDir(), "watchlist.md");
/**
 * A copy of the store that the engine writes with every write of the store and that it read back: the last state that
 * was readable. The heartbeat falls back to it when the store cannot be read, so risk watch never stops for a corrupt
 * file (ADR-0015, #139). Nothing else reads it.
 */
const lastReadablePath = () => join(projectDir(), "state", "portfolio.last-readable.json");
const LAST_READABLE_WHERE = "state/portfolio.last-readable.json";

/**
 * The last prices the heartbeat and the briefing saw, one file per silo (`telemetry/prices-eur.json`, `prices-usd.json`):
 * telemetry, not state (#133). A silo's file is written only by the runs of that silo, so the two heartbeats never write the
 * same file.
 */
const telemetryWhere = (currency: Currency) => `telemetry/prices-${currency.toLowerCase()}.json`;
const telemetryPath = (currency: Currency) => join(projectDir(), telemetryWhere(currency));

/**
 * The last prices, or none when there are none or the file does not read: they are telemetry, so a file that is missing or
 * corrupt is said and never stops a flow (a bad file of prices must not switch off risk watch). The next refresh writes it again.
 */
async function readTelemetry(): Promise<PriceTelemetry> {
  const read = async (currency: Currency): Promise<PriceTelemetry> => {
    const where = telemetryWhere(currency);
    let text: string;
    try {
      text = await readFile(telemetryPath(currency), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      warnSkipped(`${where} cannot be read: ${(err as Error).message}; the last prices are ignored`);
      return {};
    }
    try {
      const { [currency]: seen } = decodeTelemetry(text, where);
      return seen === undefined ? {} : { [currency]: seen };
    } catch (err) {
      warnSkipped(`${(err as Error).message}; the last prices are ignored`);
      return {};
    }
  };
  return { ...(await read("EUR")), ...(await read("USD")) };
}

/** The read of a silo of the store with the last prices over its positions. */
async function withLastPrices<C extends Currency>(read: PortfolioRead<C>): Promise<PortfolioRead<C>> {
  const seen = (await readTelemetry())[read.portfolio.currency];
  return seen === undefined ? read : { ...read, portfolio: withObservedPrices(read.portfolio, seen) };
}

/** The store as the flows and the view show it: the state, and the last prices over its positions. Never written back. */
async function showingLastPrices(store: PortfolioStore): Promise<PortfolioStore> {
  const telemetry = await readTelemetry();
  const silo = <C extends Currency>(currency: C) => {
    const state: PortfolioSnapshot<C> | undefined = store.silos[currency];
    return state === undefined ? {} : { [currency]: withObservedPrices(state, telemetry[currency]) };
  };
  return { ...store, silos: { ...silo("EUR"), ...silo("USD") } };
}

/** The store, or `null` while there is none (the state is still `portfolio.md`). A store that does not read is refused. */
async function readStore(): Promise<PortfolioStore | null> {
  let text: string;
  try {
    text = await readFile(storePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new StoreUnreadableError(`${STORE_WHERE} cannot be read: ${(err as Error).message}`, { cause: err });
  }
  try {
    return decodeStore(text, STORE_WHERE);
  } catch (err) {
    throw new StoreUnreadableError((err as Error).message, { cause: err });
  }
}

/**
 * The store, or when it cannot be read the copy of the last state that was: `store` with the reason in `problem`. `null`
 * store: there is none, or neither reads. A store that reads gives no `problem`.
 */
async function readLastReadable(): Promise<{ store: PortfolioStore | null; problem?: string }> {
  try {
    return { store: await readStore() };
  } catch (err) {
    if (!(err instanceof StoreUnreadableError)) throw err;
    try {
      return {
        store: decodeStore(await readFile(lastReadablePath(), "utf8"), LAST_READABLE_WHERE),
        problem: err.message,
      };
    } catch {
      return { store: null, problem: err.message };
    }
  }
}

/**
 * The store for the repair (#139): what reads, or why it does not. The repair rebuilds a store that does not read from
 * the audit trail, so a store that is unreadable is an input to it, not an error.
 */
export async function readStoreForRepair(): Promise<{
  store: PortfolioStore | null;
  problem: string | null;
  /** What the store began with, from its last readable copy when the store itself does not read. */
  starting?: PortfolioStore["starting"];
  /** The watchlist the store began with (#140), taken the same way; absent when the state never held the watchlist. */
  startingWatchlist?: PortfolioStore["startingWatchlist"];
}> {
  const began = (store: PortfolioStore | null) => ({
    ...(store?.starting !== undefined ? { starting: store.starting } : {}),
    ...(store?.startingWatchlist !== undefined ? { startingWatchlist: store.startingWatchlist } : {}),
  });
  try {
    const store = await readStore();
    return { store, problem: null, ...began(store) };
  } catch (err) {
    if (!(err instanceof StoreUnreadableError)) throw err;
    const { store } = await readLastReadable();
    return { store: null, problem: err.message, ...began(store) };
  }
}

/** The store, or `null` while there is none: for the run that finishes what an earlier `inbox:ingest` left in it. */
export const readStoreIfAny = readStore;

/** What `readPortfolio` returns for a silo of the store: it reads whole by construction, so nothing is skipped. */
function readFromStore<C extends Currency>(store: PortfolioStore, currency: C, warn: boolean): PortfolioRead<C> {
  const portfolio: PortfolioSnapshot<C> | undefined = store.silos[currency];
  if (portfolio === undefined) {
    throw new SiloAbsentError(
      `${STORE_WHERE}: there is no ${currency} silo in the portfolio (see docs/input-format.md)`,
    );
  }
  const staleness = stalenessOf(portfolio.reconciled?.date, new Date(), config.marketData.portfolioStaleDays);
  if (warn) warnIfSnapshotStale(currency, staleness);
  return { portfolio, lotsProblem: null, skippedRows: [], unreadableCells: [], staleness };
}

/** What the flows that skip a row they cannot read do with the reason (ADR-0016). */
const warnSkipped = (message: string): void => console.warn(`[vault-io] WARNING: ${message}`);

/**
 * Reads the portfolio of one silo. Throws `ENOENT` if there is no `portfolio.md`, and refuses a file that
 * cannot be the portfolio at all: another `schema_version`, a silo without its `Cash` or `Positions`
 * section or its `Available cash` row (otherwise it would read as an empty silo and the heartbeat would
 * stop watching its positions). Warns if it has gone more than `PORTFOLIO_STALE_DAYS` without a manual
 * update; it does not block the run.
 */
export async function readPortfolio<C extends Currency>(
  currency: C,
  { lastReadable = false }: { lastReadable?: boolean } = {},
): Promise<PortfolioRead<C>> {
  // The heartbeat asks to go on over the last state that read when the store does not (#139): it must keep watching the stops.
  if (lastReadable) {
    const { store, problem } = await readLastReadable();
    if (store !== null) {
      const read = await withLastPrices(readFromStore(store, currency, true));
      return problem === undefined ? read : { ...read, storeProblem: problem };
    }
    // Neither the store nor its copy reads: the old file is the state while there is no store, or the error is the verdict.
    if (problem !== undefined) throw new StoreUnreadableError(problem);
  } else {
    const store = await readStore();
    if (store !== null) return withLastPrices(readFromStore(store, currency, true));
  }
  return parsePortfolioText(await readFile(portfolioPath(), "utf8"), currency);
}

/**
 * Both silos from one read of `portfolio.md`; a stale file warns once. A silo the file has no section of is
 * absent (`undefined`), not an error: the inbox tells each command of that currency so. A file with neither
 * silo is refused like any file that is not the portfolio.
 */
export async function readBothPortfolios(): Promise<{ EUR?: PortfolioRead<"EUR">; USD?: PortfolioRead<"USD"> }> {
  const store = await readStore();
  if (store !== null) {
    const silo = <C extends Currency>(currency: C): PortfolioRead<C> | undefined =>
      store.silos[currency] === undefined ? undefined : readFromStore(store, currency, true);
    const eur = silo("EUR");
    const usd = silo("USD");
    if (eur === undefined && usd === undefined) {
      throw new SiloAbsentError(`${STORE_WHERE}: the portfolio has no silo (see docs/input-format.md)`);
    }
    return { ...(eur ? { EUR: eur } : {}), ...(usd ? { USD: usd } : {}) };
  }
  return silosOfText(await readFile(portfolioPath(), "utf8"));
}

/** Both silos of a `portfolio.md` text already read (a stale file warns once); see `readBothPortfolios`. */
function silosOfText(raw: string): { EUR?: PortfolioRead<"EUR">; USD?: PortfolioRead<"USD"> } {
  let warn = true;
  const silo = <C extends Currency>(currency: C): PortfolioRead<C> | undefined => {
    try {
      const read = parsePortfolioText(raw, currency, warn);
      warn = false;
      return read;
    } catch (err) {
      if (err instanceof SiloAbsentError) return undefined;
      throw err;
    }
  };
  const read = { EUR: silo("EUR"), USD: silo("USD") };
  if (read.EUR === undefined && read.USD === undefined) parsePortfolioText(raw, "EUR"); // throws, naming the file
  return {
    ...(read.EUR ? { EUR: read.EUR } : {}),
    ...(read.USD ? { USD: read.USD } : {}),
  };
}

/** Warns if the portfolio has gone more than `PORTFOLIO_STALE_DAYS` without an update, or tells none was ever recorded. */
function warnIfStale(lastSync: string | null | undefined): void {
  if (lastSync) {
    const diffDays = (Date.now() - new Date(lastSync).getTime()) / 86_400_000;
    if (diffDays > config.marketData.portfolioStaleDays) {
      console.warn(
        `[vault-io] WARNING: portfolio.md has not been updated for ${Math.floor(diffDays)} days.` +
          ` See the guide: routines/portfolio-sync.md`,
      );
    }
  } else {
    console.warn("[vault-io] portfolio.md has no last_manual_sync field. Update it by hand.");
  }
}

/** Warns that a silo of the store is stale (#138): it has no snapshot of the broker, or its latest one is too old. */
function warnIfSnapshotStale(currency: Currency, staleness: Staleness): void {
  if (!staleness.stale) return;
  const how =
    staleness.asOf === null
      ? `the ${currency} silo has no snapshot of the broker, so it is stale`
      : `the ${currency} silo's latest snapshot is from ${staleness.asOf.slice(0, 10)}, ${Math.floor(staleness.ageDays!)} days ago: it is stale`;
  console.warn(`[vault-io] WARNING: ${how}. Send a snapshot command (see routines/portfolio-sync.md).`);
}

/**
 * The silo's model from a `portfolio.md` text already read, with the checks and warnings of
 * `readPortfolio`. Not exported: the text is the store's.
 */
function parsePortfolioText<C extends Currency>(raw: string, currency: C, warnStale = true): PortfolioRead<C> {
  assertSchemaVersion(raw, "portfolio.md");
  assertPortfolioSections(raw, currency);

  // Check staleness with the `last_manual_sync` frontmatter field.
  // js-yaml returns a Date when the timestamp is unquoted
  // (`last_manual_sync: 2026-08-27T20:46:00Z`) and a string when quoted: it is
  // normalized to ISO here so `syncedAt` is always what its type says.
  // Without this, any consumer treating it as a string breaks only with the
  // real portfolio, never with the quoted fixtures.
  const frontmatter = extractFrontmatter(raw);
  const rawSync = frontmatter?.last_manual_sync as string | Date | null | undefined;
  const lastSync = rawSync instanceof Date ? rawSync.toISOString() : rawSync;
  if (warnStale) warnIfStale(lastSync);

  const skippedRows: string[] = [];
  const unreadableCells: string[] = [];
  const onUnreadable = (message: string): void => void unreadableCells.push(message);
  // Placeholder rows ("—") and non-numeric values ("TBD") are safely ignored: an empty snapshot, not an error.
  const totalCash = parseTotalCash(raw, currency, onUnreadable);
  const cash = parseCash(raw, currency, onUnreadable);
  const positions = parsePositions(raw, currency, (message) => void skippedRows.push(message), onUnreadable);
  let lotsProblem: string | null = null;
  let lots: Lot<C>[] = [];
  let skippedLotRows: PortfolioSnapshot<C>["skippedLotRows"];
  try {
    const read = parseLotRows(raw, currency);
    lots = read.lots;
    if (read.skipped.length > 0) skippedLotRows = read.skipped;
  } catch (err) {
    // Only the parser's own verdict on the table; anything else is a bug and must crash.
    if (!(err instanceof LotsTableError)) throw err;
    lotsProblem = err.message;
  }
  return {
    portfolio: {
      currency,
      cash,
      ...(totalCash != null ? { totalCash } : {}),
      positions,
      lots,
      ...(skippedLotRows ? { skippedLotRows } : {}),
      syncedAt: lastSync ?? new Date().toISOString(),
    },
    lotsProblem,
    skippedRows,
    unreadableCells,
    staleness: null,
  };
}

/**
 * The model for the flows that refuse a portfolio they cannot read whole (the decisions
 * evaluation): a `Positions` row whose ticker does not parse throws, naming it, and so does a `Lots` table that
 * does not read (`LotsTableError`). The rows of a readable `Lots` table that do not read stay in
 * `skippedLotRows`: the lots check names them.
 */
export function requireReadable<C extends Currency>(read: PortfolioRead<C>): PortfolioSnapshot<C> {
  if (read.skippedRows.length > 0) throw new Error(read.skippedRows[0].replace(POSITION_ROW_SKIPPED, ""));
  if (read.lotsProblem !== null) throw new LotsTableError(read.lotsProblem);
  return read.portfolio;
}

/**
 * The model for the flows that use positions, cash and silo value but not the lots (`pending:record`, the
 * Monday briefing, the weekly screening): a `Lots` table that does not read does not stop them. A `Positions`
 * row whose ticker does not parse and a cell too large to count in cents are warned of, not refused.
 */
export function ignoringLots<C extends Currency>(read: PortfolioRead<C>): PortfolioSnapshot<C> {
  read.skippedRows.forEach(warnSkipped);
  read.unreadableCells.forEach(warnSkipped);
  return read.portfolio;
}

// ─── Writing ──────────────────────────────────────────────────────────────────

/**
 * The silo with its cash (and its total cash, when it has one) moved by `delta`, in cents. Refuses, in words, a
 * movement that takes the available cash below zero: the cash is the store's, so there is no guessing it away.
 */
function withCashChange<C extends Currency>(silo: PortfolioSnapshot<C>, delta: number): PortfolioSnapshot<C> {
  if (delta === 0) return silo;
  const by = countedInCents(delta, `the ${silo.currency} cash movement`, silo.currency);
  if (silo.cash + by < 0) {
    throw new Error(
      `${STORE_WHERE}: this needs ${formatMoney(Math.abs(by))} ${silo.currency}, more than the available cash of ` +
        `${formatMoney(silo.cash)} ${silo.currency} (nothing was recorded)`,
    );
  }
  return {
    ...silo,
    cash: addCounted(silo.cash, by, `the ${silo.currency} cash after the movement`),
    ...(silo.totalCash !== undefined
      ? { totalCash: addCounted(silo.totalCash, by, `the ${silo.currency} total cash after the movement`) }
      : {}),
  };
}

/**
 * Moves the cash of the silos of the store, all in one write (a deposit, a withdrawal or a conversion told to
 * `decision:record`, #152); `false`, having done nothing, while there is no store (the cash is then the owner's cell of
 * `portfolio.md`). With `dryRun` every refusal comes and nothing is written.
 */
export async function changeCash(
  moves: readonly (readonly [Currency, number])[],
  { dryRun = false } = {},
): Promise<boolean> {
  const store = await readStore();
  if (store === null) return false;
  let silos = store.silos;
  for (const [currency, delta] of moves) {
    silos = {
      ...silos,
      [currency]: withCashChange(readFromStore({ ...store, silos }, currency, false).portfolio, delta),
    };
  }
  if (!dryRun) await writeStore({ ...store, silos });
  return true;
}

/**
 * Records the prices the heartbeat and the Monday briefing saw (#133). With the store they are telemetry: written to
 * `telemetry/prices-<ccy>.json` and into the generated view, never into the store, which `inbox:ingest` alone writes. Nothing
 * is written if no price changes, or while a position has none. Without a store the state is still `portfolio.md`, and
 * its `Current price` and `P/L` cells are refreshed as before (#143 removes that way); no other field is touched,
 * `last_manual_sync` included.
 */
export async function recordPrices(currency: Currency, prices: ReadonlyMap<Ticker, number>): Promise<void> {
  let store: PortfolioStore | null;
  try {
    store = await readStore();
  } catch (err) {
    // A store that does not read is not the base of a price: the repair is the way back (#139). The heartbeat goes on.
    if (!(err instanceof StoreUnreadableError)) throw err;
    console.warn(`[vault-io] WARNING: prices not updated: ${err.message}`);
    return;
  }
  if (store !== null) {
    const silo = store.silos[currency];
    if (silo === undefined) return;
    const telemetry = await readTelemetry();
    const observed = observePrices(silo, prices, telemetry[currency]);
    if (observed === null) return; // nothing changed
    await writeAtomically(encodeTelemetry({ [currency]: observed }), telemetryPath(currency));
    // The view shows the last prices: generated again, as after any write of the store (the store itself is not touched).
    await rewriteView(store);
    console.log(`[vault-io] ${telemetryWhere(currency)}: prices updated (${currency})`);
    return;
  }
  // As the file is, line ends included: the writer keeps every line it did not change.
  const raw = await readFile(portfolioPath(), "utf8").catch(() => null);
  if (!raw) return;
  assertSchemaVersion(raw, "portfolio.md");
  const updated = applyPrices(raw, currency, prices);
  if (updated === null) return; // nothing changed
  await writeAtomically(updated);
  console.log(`[vault-io] portfolio.md: prices updated (${currency})`);
}

async function writeAtomically(text: string, target = portfolioPath()): Promise<void> {
  // A temp file in the same directory, renamed over the file, so a crash never leaves it truncated.
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temp, text, "utf8");
    await rename(temp, target);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  }
}

// ─── The engine's store ───────────────────────────────────────────────────────

/**
 * Writes the store, then the view generated from it. The store is the commit: if the view cannot be written the
 * error is thrown after the state is safe, and the next write (or `rewriteView`) generates it again.
 */
async function writeStore(store: PortfolioStore): Promise<void> {
  const text = encodeStore(store);
  // What is written reads back, or nothing is: the copy of the last readable state must never be a bad one.
  decodeStore(text, STORE_WHERE);
  await writeAtomically(text, storePath());
  await writeAtomically(text, lastReadablePath());
  await rewriteView(store);
}

/**
 * Generates the views again from the store (`portfolio.md`, with the last prices over its positions, and `watchlist.md` once the
 * store holds the watchlist), for a run that finds the state already written and for a refresh of the prices.
 */
export async function rewriteView(store: PortfolioStore): Promise<void> {
  await writeAtomically(renderView(await showingLastPrices(store)));
  if (store.watchlist !== undefined) await writeAtomically(renderWatchlistView(store), watchlistPath());
}

/**
 * The portfolio as the view text, for the one flow that puts it in a prompt (the Monday briefing): with a store,
 * generated from it now; without one, the text of `portfolio.md`; "" with neither.
 */
export async function readPortfolioView(): Promise<string> {
  const store = await readStore();
  if (store !== null) return renderView(await showingLastPrices(store));
  return readFile(portfolioPath(), "utf8").catch(() => "");
}

/**
 * `account_env` (`demo` | `real`) of the portfolio: the store's, or while there is none the one in the text of
 * `portfolio.md`; `undefined` with neither. A store that does not read gives its last readable copy (#146).
 */
export async function readAccountEnv(): Promise<string | undefined> {
  const { store } = await readLastReadable();
  const env = store !== null ? store.accountEnv : extractFrontmatter(await readPortfolioView())?.account_env;
  return typeof env === "string" ? env : undefined;
}

// ─── The watchlist (#140) ─────────────────────────────────────────────────────

/**
 * An entry of the old `watchlist.md` as the store holds it: what the store's reader accepts, so a field it would refuse is
 * made what the old readers made of it (a missing or unknown horizon is `medium`, an unknown asset class is none). `null`
 * for an entry with no silo (a currency neither EUR nor USD): nothing ever read it.
 */
function seededEntry(entry: WatchlistEntry): WatchlistEntry | null {
  if (!CURRENCIES.includes(entry.currency)) return null;
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  const [name, market, thesisLink] = [text(entry.name), text(entry.market), text(entry.thesis_link)];
  return {
    ticker: entry.ticker,
    currency: entry.currency,
    horizon: HORIZONS.includes(entry.horizon) ? entry.horizon : "medium",
    ...(ASSET_CLASSES.includes(entry.asset_class!) ? { asset_class: entry.asset_class! } : {}),
    thesis: text(entry.thesis) ?? "",
    ...(thesisLink !== undefined ? { thesis_link: thesisLink } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(market !== undefined ? { market } : {}),
  };
}

/**
 * The entries of the old `watchlist.md`, to seed the store with: no file is an empty list. A file that cannot be
 * read (another `schema_version`, a ticker that does not parse, not YAML) throws, naming it: the watchlist is not guessed.
 * A ticker written twice is kept once, an entry with no silo is left out; both are warned of.
 */
async function readWatchlistFile(): Promise<WatchlistEntry[]> {
  let raw: string;
  try {
    raw = await readFile(watchlistPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  assertSchemaVersion(raw, "watchlist.md");
  const seen = new Set<string>();
  return parseWatchlistBlock(extractYamlBlock(raw)).flatMap((entry) => {
    const seeded = seededEntry(entry);
    if (seeded === null) {
      warnSkipped(
        `watchlist.md: ${entry.ticker} has no silo (currency ${String(entry.currency)}): left out of the store`,
      );
      return [];
    }
    if (seen.has(seeded.ticker)) {
      warnSkipped(`watchlist.md: ${seeded.ticker} is on the list twice: the first entry is kept`);
      return [];
    }
    seen.add(seeded.ticker);
    return [seeded];
  });
}

/**
 * The store with the watchlist seeded from `watchlist.md` when it holds none yet (the state was still the file), as the
 * list it began with too: what a correction and the repair apply the `watch` and `stop_watching` commands over. Nothing
 * is written. With `mustKnow` a file that cannot be read throws (an `ingest` does not guess the watchlist); without it
 * (`check`) the list is empty.
 */
export async function withWatchlist(store: PortfolioStore, mustKnow: boolean): Promise<PortfolioStore> {
  if (store.watchlist !== undefined) return store;
  let entries: WatchlistEntry[];
  try {
    entries = await readWatchlistFile();
  } catch (err) {
    if (mustKnow) throw err;
    entries = [];
  }
  return { ...store, watchlist: entries, startingWatchlist: entries };
}

/**
 * The watchlist the store holds, or `null` while it holds none (nobody has run `inbox:ingest` since the watchlist became
 * state, so `watchlist.md` is still the state). Goes on over the last readable copy of a store that does not read, as the
 * heartbeat does for the portfolio (ADR-0015): risk watch scans the watchlist for setups and must not stop for it.
 */
export async function readWatchlistInStore(): Promise<WatchlistEntry[] | null> {
  const { store } = await readLastReadable();
  return store?.watchlist ?? null;
}

/**
 * The watchlist as the text of `watchlist.md`, for the one flow that puts it in a prompt: with a store that holds it,
 * generated from it now; otherwise the file's text; "" with neither.
 */
export async function readWatchlistView(): Promise<string> {
  const { store } = await readLastReadable();
  if (store?.watchlist !== undefined) return renderWatchlistView(store);
  return readFile(watchlistPath(), "utf8").catch(() => "");
}

/**
 * The silo as `inbox:ingest` works on it: refused, naming what is wrong, unless it reads whole. What
 * the evaluation refuses (`requireReadable`, then the checks of the lots that need no decision log: rows of
 * `Lots` that do not read, a `Volume` that is not the sum of its lots) and the cells too large to count, which read
 * as 0: a state with a guessed cash would give the owner a wrong "clean" and a store with a row lost.
 */
export function requireWhole<C extends Currency>(read: PortfolioRead<C>): PortfolioSnapshot<C> {
  const portfolio = requireReadable(read);
  const problems = [...read.unreadableCells, ...volumeMismatches(portfolio)];
  if (problems.length > 0) {
    throw new Error(
      `${problems.join("\n")}\nFix portfolio.md by hand before checking the inbox (see docs/input-format.md)`,
    );
  }
  return portfolio;
}

/**
 * The store made from the old `portfolio.md`, read whole (`requireWhole`): what `inbox:ingest` applies batches to
 * while there is no store. Nothing is written here. No `portfolio.md` is a portfolio with no silo: every command is
 * refused for that.
 */
export async function storeFromPortfolioFile(): Promise<PortfolioStore> {
  let raw: string;
  try {
    raw = await readFile(portfolioPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { silos: {}, unmoved: [], pendingDecisions: [], resolvedRejections: [], closedEscalations: [] };
    throw err;
  }
  const read = silosOfText(raw);
  const accountEnv = extractFrontmatter(raw)?.account_env;
  const silos = {
    ...(read.EUR ? { EUR: requireWhole(read.EUR) } : {}),
    ...(read.USD ? { USD: requireWhole(read.USD) } : {}),
  };
  return {
    silos,
    starting: silos,
    ...(typeof accountEnv === "string" ? { accountEnv } : {}),
    unmoved: [],
    pendingDecisions: [],
    resolvedRejections: [],
    closedEscalations: [],
  };
}

/** Writes the store `inbox:ingest` ended with, and the view generated from it. */
export async function saveStore(store: PortfolioStore): Promise<void> {
  await writeStore(store);
}

/**
 * Makes the store from the old `portfolio.md` now, with every silo synced and reconciled with the broker as of
 * `syncedAt` (the demo, which runs on a copy of the example brain that must not warn of a stale portfolio: it is made
 * as if the owner had sent a snapshot with no difference that day). A store that exists is left as it is.
 */
export async function seedStore(syncedAt: Date): Promise<void> {
  if ((await readStore()) !== null) return;
  const store = await withWatchlist(await storeFromPortfolioFile(), false);
  const stamp = (silo: PortfolioSnapshot | undefined) =>
    silo
      ? {
          ...silo,
          syncedAt: syncedAt.toISOString(),
          reconciled: { date: syncedAt.toISOString().slice(0, 10), differences: [] }, // no `recordedOn`: nothing to confirm
        }
      : undefined;
  await writeStore({
    ...store,
    silos: {
      ...(store.silos.EUR ? { EUR: stamp(store.silos.EUR) as PortfolioSnapshot<"EUR"> } : {}),
      ...(store.silos.USD ? { USD: stamp(store.silos.USD) as PortfolioSnapshot<"USD"> } : {}),
    },
  });
}
