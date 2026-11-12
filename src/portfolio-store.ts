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
// One read, `readPortfolio`, for every flow. What it could not read is in its result: `lotsProblem` (the
// `Lots` table as such), `portfolio.skippedLotRows` (rows of it), `skippedRows` (`Positions` rows) and
// `unreadableCells`. Each flow keeps its own behaviour on them: the heartbeat reports them and goes on, the
// briefings and the screening ignore the `Lots` and warn of the rest (`ignoringLots`), `decision:record` and
// the evaluation refuse (`requireReadable`).
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import type { Ticker } from "./ticker.js";
import type { Currency, Lot, PortfolioSnapshot } from "./types.js";
import { applyLotChange, applyPrices, type PositionChange } from "./utils/portfolio-writer.js";
import { portfolioWhere } from "./utils/portfolio-where.js";
import {
  decodeStore,
  encodeStore,
  renderView,
  withLotChange,
  withPrices,
  type PortfolioStore,
} from "./utils/portfolio-json.js";
import { volumeMismatches } from "./utils/lots-check.js";
import {
  assertPortfolioSections,
  assertSchemaVersion,
  extractFrontmatter,
  LotsTableError,
  parseCash,
  parseLotRows,
  parsePositions,
  parseTotalCash,
  POSITION_ROW_SKIPPED,
  SiloAbsentError,
} from "./utils/vault-parser.js";

export type { PortfolioStore, PositionChange };

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
}

const projectDir = () => config.paths.vaultProjectDir;
/** The old state file, and, once the store exists, its generated view. */
const portfolioPath = () => join(projectDir(), "portfolio.md");
/** The engine's own store of the portfolio: JSON written only by the engine. */
const storePath = () => join(projectDir(), "state", "portfolio.json");
const STORE_WHERE = "state/portfolio.json";

/** The store, or `null` while there is none (the state is still `portfolio.md`). A store that does not read is refused. */
async function readStore(): Promise<PortfolioStore | null> {
  let text: string;
  try {
    text = await readFile(storePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return decodeStore(text, STORE_WHERE);
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
  if (warn) warnIfStale(portfolio.syncedAt);
  return { portfolio, lotsProblem: null, skippedRows: [], unreadableCells: [] };
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
export async function readPortfolio<C extends Currency>(currency: C): Promise<PortfolioRead<C>> {
  const store = await readStore();
  if (store !== null) return readFromStore(store, currency, true);
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
    let warn = true;
    const silo = <C extends Currency>(currency: C): PortfolioRead<C> | undefined => {
      if (store.silos[currency] === undefined) return undefined;
      const read = readFromStore(store, currency, warn);
      warn = false;
      return read;
    };
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

/**
 * The silo's model from a `portfolio.md` text already read, with the checks and warnings of
 * `readPortfolio`: `changeLots` parses the very text it will rewrite. Not exported: the text is the store's.
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
  };
}

/**
 * The model for the flows that refuse a portfolio they cannot read whole (`decision:record`, the decisions
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
 * The model for the flows that use positions, cash and silo value but not the lots (`pending:resolve`, the
 * Monday briefing, the weekly screening): a `Lots` table that does not read does not stop them. A `Positions`
 * row whose ticker does not parse and a cell too large to count in cents are warned of, not refused.
 */
export function ignoringLots<C extends Currency>(read: PortfolioRead<C>): PortfolioSnapshot<C> {
  read.skippedRows.forEach(warnSkipped);
  read.unreadableCells.forEach(warnSkipped);
  return read.portfolio;
}

// ─── Writing ──────────────────────────────────────────────────────────────────

/** The lots on disk are not the ones the change was planned on: someone else wrote the portfolio meanwhile. */
export class LotsMovedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LotsMovedError";
  }
}

/** The lots of the silo as `readPortfolio` reads them, in a text that compares: the guard of `changeLots`. */
const lotsKey = (lots: readonly Lot[]): string => JSON.stringify(lots);

/**
 * Writes `lots` as the silo's open lots and updates the `Positions` row of `change.ticker` (created,
 * changed or deleted), if the lots on disk are still `expected` (`decision:record`, ADR-0015). Refuses with a
 * `LotsMovedError`, writing nothing, if they are not: the plan is stale. The file is read once per call and
 * that one read is both checked and edited, so a change of the owner's between the check and the write cannot
 * be overwritten. In order, on that read: the `Lots` guard; `check`, which receives the portfolio of the read and
 * refuses by throwing (the recorder checks the lots against the decision history there); the edit, which
 * refuses a `Lots` table with a row that does not read, since that is not the recorder's to guess; and, unless
 * `dryRun`, the write, which replaces the file atomically so a crash never leaves it truncated. With `dryRun`
 * every refusal comes and nothing is written: the recorder tries the change before it appends its log line, then
 * applies it, in a second call, after.
 */
export async function changeLots<C extends Currency>(
  currency: C,
  expected: readonly Lot<C>[],
  lots: readonly Lot<C>[],
  change: PositionChange,
  { check, dryRun = false }: { check?: (read: PortfolioSnapshot<C>) => void; dryRun?: boolean } = {},
): Promise<void> {
  const store = await readStore();
  if (store !== null) {
    const portfolio = readFromStore(store, currency, false).portfolio;
    if (lotsKey(portfolio.lots) !== lotsKey(expected)) {
      throw new LotsMovedError(`${portfolioWhere(currency)}: Lots changed meanwhile`);
    }
    check?.(portfolio);
    if (!dryRun) {
      await writeStore({
        ...store,
        silos: { ...store.silos, [currency]: withLotChange(portfolio, lots, change) },
      });
    }
    return;
  }
  const text = await readFile(portfolioPath(), "utf8");
  // The run read and warned of the file already: this read stays quiet.
  const portfolio = requireReadable(parsePortfolioText(text, currency, false));
  if (lotsKey(portfolio.lots) !== lotsKey(expected)) {
    throw new LotsMovedError(`${portfolioWhere(currency)}: Lots changed meanwhile`);
  }
  check?.(portfolio);
  const edited = applyLotChange(text, currency, lots, change);
  if (!dryRun) await writeAtomically(edited);
}

/**
 * Refreshes the `Current price` and `P/L` of the positions that have a price (the heartbeat and the Monday
 * briefing). It touches no other field, `last_manual_sync` included, and writes nothing if no value changes
 * or there is no `portfolio.md`.
 */
export async function refreshPrices(currency: Currency, prices: ReadonlyMap<Ticker, number>): Promise<void> {
  const store = await readStore();
  if (store !== null) {
    const silo = store.silos[currency];
    const priced = silo === undefined ? null : withPrices(silo, prices);
    if (priced === null) return; // nothing changed
    await writeStore({ ...store, silos: { ...store.silos, [currency]: priced } });
    console.log(`[vault-io] portfolio.md: prices updated (${currency})`);
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
  await writeAtomically(encodeStore(store), storePath());
  await writeAtomically(renderView(store));
}

/** Generates the view again from the store, for a run that finds the state already written. */
export async function rewriteView(store: PortfolioStore): Promise<void> {
  await writeAtomically(renderView(store));
}

/**
 * The portfolio as the view text, for the one flow that puts it in a prompt (the Monday briefing): with a store,
 * generated from it now; without one, the text of `portfolio.md`; "" with neither.
 */
export async function readPortfolioView(): Promise<string> {
  const store = await readStore();
  if (store !== null) return renderView(store);
  return readFile(portfolioPath(), "utf8").catch(() => "");
}

/**
 * The silo as `inbox:ingest` works on it: refused, naming what is wrong, unless it reads whole. What
 * `decision:record` refuses (`requireReadable`, then the checks of the lots that need no decision log: rows of
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
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { silos: {}, unmoved: [], pendingDecisions: [] };
    throw err;
  }
  const read = silosOfText(raw);
  const accountEnv = extractFrontmatter(raw)?.account_env;
  return {
    silos: {
      ...(read.EUR ? { EUR: requireWhole(read.EUR) } : {}),
      ...(read.USD ? { USD: requireWhole(read.USD) } : {}),
    },
    ...(typeof accountEnv === "string" ? { accountEnv } : {}),
    unmoved: [],
    pendingDecisions: [],
  };
}

/** Writes the store `inbox:ingest` ended with, and the view generated from it. */
export async function saveStore(store: PortfolioStore): Promise<void> {
  await writeStore(store);
}

/**
 * Makes the store from the old `portfolio.md` now, with every silo synced at `syncedAt` (the demo, which runs on a
 * copy of the example brain that must not warn of a stale portfolio). A store that exists is left as it is.
 */
export async function seedStore(syncedAt: Date): Promise<void> {
  if ((await readStore()) !== null) return;
  const store = await storeFromPortfolioFile();
  const stamp = (silo: PortfolioSnapshot | undefined) =>
    silo ? { ...silo, syncedAt: syncedAt.toISOString() } : undefined;
  await writeStore({
    ...store,
    silos: {
      ...(store.silos.EUR ? { EUR: stamp(store.silos.EUR) as PortfolioSnapshot<"EUR"> } : {}),
      ...(store.silos.USD ? { USD: stamp(store.silos.USD) as PortfolioSnapshot<"USD"> } : {}),
    },
  });
}
