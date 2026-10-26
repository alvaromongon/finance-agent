// Pure parsing functions for the vault Markdown. No I/O, no config.
// Exported so they can be unit-tested.
import yaml from "js-yaml";
import { normalizeEol, parseMarkdownMoney, parseMarkdownNumber } from "./parse.js";
import { ZERO, canCountInCents, money, type Money } from "../money.js";
import { DECISION_ORIGINS } from "../decisions.js";
import { checkTicker, namesTicker, type Ticker } from "../ticker.js";
import type { Currency, Lot, Position, SkippedLotRow, WatchlistEntry } from "../types.js";
import { hasSection, parsePortfolio, parseTableRows, readTable, type PortfolioSection } from "./portfolio-codec.js";

// `portfolio.md`'s grammar lives in the codec; these are re-exported for the readers of other files.
export {
  isTableLine,
  isTableSeparator,
  parseTableRows,
  sectionBody,
  sectionRange,
  splitTableRow,
} from "./portfolio-codec.js";
export type { PortfolioSection } from "./portfolio-codec.js";

export function extractYamlBlock(md: string): string {
  const match = /```ya?ml\n([\s\S]*?)```/.exec(normalizeEol(md));
  if (!match) throw new Error("No YAML block found in the Markdown");
  return match[1];
}

export function extractFrontmatter(md: string): Record<string, unknown> | null {
  const match = /^---\n([\s\S]*?)\n---/.exec(normalizeEol(md));
  if (!match) return null;
  return yaml.load(match[1]) as Record<string, unknown>;
}

// ─── Input format version (ADR-0001 §6) ─────────────────────────────

/** Format version of the vault files other than `portfolio.md`, including those the engine writes. */
export const SCHEMA_VERSION = 1;

/** Format version of `portfolio.md`: v2 adds the `Lots` table (ADR-0015). */
export const PORTFOLIO_SCHEMA_VERSION = 2;

/** The `schema_version` this engine reads for a vault file: it is per file, not for the whole vault. */
export function expectedSchemaVersion(file: string): number {
  return file === "portfolio.md" ? PORTFOLIO_SCHEMA_VERSION : SCHEMA_VERSION;
}

/**
 * Checks the `schema_version` in a vault file's frontmatter against the version this engine reads
 * for that file. A file without a version or with another one is rejected instead of being
 * half-read: the format is the contract with whoever uses the engine.
 */
export function assertSchemaVersion(md: string, file: string): void {
  const expected = expectedSchemaVersion(file);
  const version = extractFrontmatter(md)?.schema_version;
  if (version === expected) return;
  if (version == null) {
    throw new Error(
      `${file}: schema_version missing from the frontmatter (this engine reads version ${expected} of this file; see docs/input-format.md)`,
    );
  }
  throw new Error(
    `${file}: unknown schema_version ${JSON.stringify(version)} (this engine reads version ${expected} of this file; see docs/input-format.md)`,
  );
}

// ─── Portfolio ────────────────────────────────────────────────────────────────

/**
 * Checks the silo has the `Cash` and `Positions` sections and the `Available cash` row. Without this,
 * a misspelled heading or row (e.g. from the previous format) would read as an empty silo and the
 * heartbeat would silently stop watching its positions. The `Lots` section is not checked here: the
 * Lots reader (`parseLotRows`) owns it, and reports a missing one as a `LotsTableError`, which the
 * heartbeat tolerates and the strict readers do not.
 */
export function assertPortfolioSections(md: string, currency: Currency): void {
  const model = parsePortfolio(md);
  for (const kind of ["Cash", "Positions"] as const) {
    if (!hasSection(model, currency, kind)) {
      throw new Error(
        `${portfolioWhere(currency)}: missing section "## ${currency} — ${kind}" (see docs/input-format.md)`,
      );
    }
  }
  const hasAvailableCash = tableRows(md, currency, "Cash").some((cells) => AVAILABLE_CASH_RE.test(cells[0] ?? ""));
  if (!hasAvailableCash) {
    throw new Error(
      `${portfolioWhere(currency)}: missing "Available cash" row in "## ${currency} — Cash" (see docs/input-format.md)`,
    );
  }
}

/** The rows of the silo's table, header first; none if the section does not exist or has no table. */
function tableRows(md: string, currency: Currency, kind: PortfolioSection): string[][] {
  const table = readTable(parsePortfolio(md), currency, kind);
  return table?.header ? [table.header, ...table.rows] : [];
}

/** `portfolio.md (USD)`: file and silo, the prefix of every message about the lots of one silo. */
export const portfolioWhere = (currency: Currency): string => `portfolio.md (${currency})`;

/**
 * Reads "Available cash" from the `## <CURRENCY> — Cash` section: the capital
 * free to trade. Returns 0 if there is no parseable number (e.g. "TBD").
 */
const AVAILABLE_CASH_RE = /^available\s+cash$/i;

export function parseCash(md: string, currency: Currency, onUnreadable?: (message: string) => void): Money {
  return cashRow(md, currency, AVAILABLE_CASH_RE, "Available cash", onUnreadable) ?? ZERO;
}

/**
 * Reads "Total cash" from the `## <CURRENCY> — Cash` section: the account
 * balance including what pending orders hold. The row is optional because it
 * only differs from the available balance while there are pending orders;
 * `null` if missing or not a number.
 */
export function parseTotalCash(md: string, currency: Currency, onUnreadable?: (message: string) => void): Money | null {
  return cashRow(md, currency, /^total\s+cash$/i, "Total cash", onUnreadable);
}

function cashRow(
  md: string,
  currency: Currency,
  label: RegExp,
  name: string,
  onUnreadable?: (message: string) => void,
): Money | null {
  const rows = tableRows(md, currency, "Cash");
  const row = rows.find((cells) => label.test(cells[0] ?? ""));
  if (!row) return null;
  const value = parseMarkdownMoney(row[1]);
  if (value === null) {
    reportTooLarge(row[1], `## ${currency} — Cash: ${name}`, name === "Total cash" ? "absent" : "0", onUnreadable);
  }
  return value;
}

/**
 * A number the owner wrote that cannot be counted in cents (`1e307`) reads as no value, like "TBD", but is
 * not a silent one: `onUnreadable` is told which cell it was (#86). A cell that was never a number is not.
 */
function reportTooLarge(
  cell: string | undefined,
  where: string,
  used: "0" | "absent",
  onUnreadable?: (message: string) => void,
): void {
  if (!onUnreadable || parseMarkdownNumber(cell) === null) return;
  onUnreadable(`${where} ${JSON.stringify((cell ?? "").trim())} is too large to count in cents (read as ${used})`);
}

// ─── Decision logs ────────────────────────────────────────────────────────────

/** The Markdown decision log has `blocked: true` in its frontmatter: blocked ticket, outside the cooldown. */
export function isBlockedLog(content: string): boolean {
  return extractFrontmatter(content)?.blocked === true;
}

// ─── Screening log ────────────────────────────────────────────────────────────

/** Values of the screening-log `Result` column (v1 format). */
export const SCREENING_RESULTS = ["interesting", "not_interesting"] as const;
export type ScreeningResultValue = (typeof SCREENING_RESULTS)[number];

export interface ScreeningLogRow {
  ticker: Ticker;
  name: string;
  index: string;
  date: string;
  result: ScreeningResultValue;
  summary: string;
  nextReview: string;
}

/** What a reader that skips a row it cannot read does with the reason: warns (ADR-0016). */
const warnSkipped = (message: string): void => console.warn(`[vault-parser] WARNING: ${message}`);

/**
 * Parses the screening-log.md table from its raw content.
 * Skips the header row (first row with "Ticker" as its first cell). A row whose ticker does not parse
 * is skipped and reported to `onSkip` (ADR-0016): the log is append-only history, and one old bad row
 * must not stop the weekly run.
 */
export function parseScreeningLog(md: string, onSkip: (message: string) => void = warnSkipped): ScreeningLogRow[] {
  assertSchemaVersion(md, "screening-log.md");
  const rows = parseTableRows(md);
  return rows
    .filter((cells) => cells.length >= 7 && cells[0] !== "Ticker")
    .map((cells) => {
      // An unknown value (e.g. "No interesante" from the previous format) would
      // match no filter and the ticker would be analyzed again too early.
      if (!SCREENING_RESULTS.includes(cells[4] as ScreeningResultValue)) {
        throw new Error(
          `screening-log.md: unknown Result ${JSON.stringify(cells[4])} in row ${cells[0]} of ${cells[3]} (values: ${SCREENING_RESULTS.join(", ")})`,
        );
      }
      return cells;
    })
    .flatMap((cells) => {
      const checked = checkTicker(cells[0]);
      if ("problem" in checked) {
        onSkip(`screening-log.md: row ${JSON.stringify(cells[0])} of ${cells[3]} skipped: ${checked.problem}`);
        return [];
      }
      return [
        {
          ticker: checked.ticker,
          name: cells[1],
          index: cells[2],
          date: cells[3],
          result: cells[4] as ScreeningResultValue,
          summary: cells[5],
          nextReview: cells[6],
        },
      ];
    });
}

/**
 * Extracts the list of tickers to remove from the AUTOMATED_ACTIONS section
 * Claude adds at the end of the Monday Briefing.
 * Returns an empty array if there are no removals or the section is missing.
 */
export function extractRetireList(reviewText: string): Ticker[] {
  // [ \t]* and not \s*: with an empty `RETIRE:`, \s* jumped to the next line
  // and returned "PLAN_SUMMARY: …" as if it were a ticker to remove.
  const match = /^##\s+AUTOMATED_ACTIONS\s*\nRETIRE:[ \t]*(.*)$/m.exec(normalizeEol(reviewText));
  const line = match?.[1]?.trim() ?? "";
  // What does not parse as a ticker cannot be retired: it is reported, not dropped silently.
  return line
    ? line.split(",").flatMap((t) => {
        const checked = checkTicker(t);
        if ("ticker" in checked) return [checked.ticker];
        // A trailing comma leaves an empty token: nothing was asked.
        if (t.trim() !== "")
          warnSkipped(`RETIRE: ${JSON.stringify(t.trim())} is not a ticker and was not retired: ${checked.problem}`);
        return [];
      })
    : [];
}

/**
 * Extracts the one-sentence weekly plan summary (`PLAN_SUMMARY:`) from the
 * Monday Briefing AUTOMATED_ACTIONS section. Returns an empty string if it is
 * not there (the email falls back to a generic subject then).
 */
export function extractPlanSummary(reviewText: string): string {
  // Same reason as in extractRetireList: an empty PLAN_SUMMARY must not take
  // the PROPOSALS line below as the summary.
  const match = /^PLAN_SUMMARY:[ \t]*(.*)$/m.exec(normalizeEol(reviewText));
  return match?.[1]?.trim() ?? "";
}

/**
 * The entries of the watchlist.md YAML block, with their tickers parsed (a ticker written in lower case
 * reads as its upper-case value). An entry whose ticker does not parse throws, naming it (the readers
 * that refuse, `decision:record`), or, given `onSkip`, is skipped and reported to it (ADR-0016).
 */
export function parseWatchlistBlock(block: string, onSkip?: (message: string) => void): WatchlistEntry[] {
  const parsed = yaml.load(block) as { watchlist?: WatchlistEntry[] } | undefined;
  return (parsed?.watchlist ?? []).flatMap((entry, i) => {
    const checked = checkTicker(entry?.ticker);
    if ("problem" in checked) {
      const message = `watchlist.md: entry ${i + 1}: ${checked.problem}`;
      if (!onSkip) throw new Error(message);
      onSkip(`${message} (entry skipped)`);
      return [];
    }
    return [{ ...entry, ticker: checked.ticker }];
  });
}

/**
 * Adds an entry to the watchlist.md YAML block.
 * Pure function: takes the current markdown and returns the updated one.
 * Returns the same string if the ticker already exists.
 */
export function applyAddWatchlistEntry(md: string, entry: import("../types.js").WatchlistEntry): string {
  md = normalizeEol(md);
  const block = extractYamlBlock(md);
  const parsed = yaml.load(block) as { watchlist?: import("../types.js").WatchlistEntry[] };
  const watchlist = parsed?.watchlist ?? [];
  if (watchlist.some((e) => namesTicker(e?.ticker, entry.ticker))) return md;
  watchlist.push(entry);
  const newYaml = yaml.dump({ watchlist }, { lineWidth: 120, quotingType: '"' });
  return md.replace(/```yaml\n[\s\S]*?\n```/, "```yaml\n" + newYaml + "```");
}

/**
 * Removes a ticker from the watchlist.md YAML block.
 * Pure function: takes the current markdown and returns the updated one.
 */
export function applyRetireWatchlistEntry(md: string, ticker: Ticker): string {
  md = normalizeEol(md);
  const block = extractYamlBlock(md);
  const parsed = yaml.load(block) as { watchlist?: import("../types.js").WatchlistEntry[] };
  const watchlist = (parsed?.watchlist ?? []).filter((e) => !namesTicker(e?.ticker, ticker));
  const newYaml = yaml.dump({ watchlist }, { lineWidth: 120, quotingType: '"' });
  return md.replace(/```yaml\n[\s\S]*?\n```/, "```yaml\n" + newYaml + "```");
}

/** Columns of the positions table (v1 format), by header text. */
const POSITION_COLUMNS = {
  ticker: "Ticker",
  volume: "Volume",
  avgPrice: "Avg price",
  currentPrice: "Current price",
  pl: "P/L",
  stopLoss: "Stop loss",
} as const;

export type PositionColumn = keyof typeof POSITION_COLUMNS;

/**
 * Index of each column of a table from its header row, by name (case-insensitive); `missing` lists the
 * labels the header lacks. Shared by the `Positions` and `Lots` readers.
 */
function columnIndexes<K extends string>(
  header: readonly string[],
  labels: Readonly<Record<K, string>>,
): { indexes: Record<K, number>; missing: string[] } {
  const normalized = header.map((c) => c.trim().toLowerCase());
  const missing: string[] = [];
  const indexes = {} as Record<K, number>;
  for (const [key, label] of Object.entries(labels) as [K, string][]) {
    const i = normalized.indexOf(label.toLowerCase());
    if (i === -1) missing.push(label);
    indexes[key] = i;
  }
  return { indexes, missing };
}

/** A cell with no value: empty, `—` or `-`. */
const isPlaceholder = (cell: string): boolean => cell === "" || cell === "—" || cell === "-";

/**
 * Index of each positions-table column from its header row (the table's
 * first row). Columns are read by name, not by position; a missing one →
 * error with the section and the column.
 */
export function positionColumns(header: readonly string[], currency: Currency): Record<PositionColumn, number> {
  const { indexes, missing } = columnIndexes(header, POSITION_COLUMNS);
  if (missing.length > 0) {
    throw new Error(`## ${currency} — Positions: columns ${missing.join(", ")} missing from the table header`);
  }
  return indexes;
}

/** True if the row is a placeholder or a repeated header, not a position. */
export function isPositionPlaceholder(ticker: string): boolean {
  return isPlaceholder(ticker) || /^ticker$/i.test(ticker);
}

/**
 * Parses the rows of the `## <CURRENCY> — Positions` table (columns in
 * POSITION_COLUMNS, in any order). Skips placeholder rows ("—") and ignores
 * rows without a numeric volume/average price. A row whose ticker does not parse throws, naming it (the
 * readers that refuse), or, given `onSkip`, is skipped and reported to it (ADR-0016). A P/L too large to
 * count in cents reads as 0 and, given `onUnreadable`, is reported to it; the row is kept (#86).
 */
export function parsePositions(
  md: string,
  currency: Currency,
  onSkip?: (message: string) => void,
  onUnreadable?: (message: string) => void,
): Position[] {
  const [header, ...rows] = tableRows(md, currency, "Positions");
  if (!header) return [];
  const col = positionColumns(header, currency);
  const positions: Position[] = [];

  for (const cells of rows) {
    const rawTicker = (cells[col.ticker] ?? "").trim();
    if (isPositionPlaceholder(rawTicker)) continue;

    const volume = parseMarkdownNumber(cells[col.volume]);
    const avgPrice = parseMarkdownNumber(cells[col.avgPrice]);
    if (volume == null || avgPrice == null) continue;

    const checked = checkTicker(rawTicker);
    if ("problem" in checked) {
      const message = `## ${currency} — Positions: Ticker ${JSON.stringify(rawTicker)}: ${checked.problem}`;
      if (!onSkip) throw new Error(message);
      onSkip(`${message} (row skipped: it is not watched until fixed)`);
      continue;
    }
    positions.push({
      ticker: checked.ticker,
      ...(rawTicker !== checked.ticker ? { written: rawTicker } : {}),
      currency,
      volume,
      avgPrice,
      currentPrice: parseMarkdownNumber(cells[col.currentPrice]) ?? 0,
      pl: positionPl(cells[col.pl], `## ${currency} — Positions: ${checked.ticker} P/L`, onUnreadable),
      stopLoss: parseMarkdownNumber(cells[col.stopLoss]),
    });
  }

  return positions;
}

/** The row's P/L, display-only: 0 when it does not read; a number too large to count in cents is named (#86). */
function positionPl(cell: string | undefined, where: string, onUnreadable?: (message: string) => void): Money {
  const pl = parseMarkdownMoney(cell);
  if (pl === null) reportTooLarge(cell, where, "0", onUnreadable);
  return pl ?? ZERO;
}

// ─── Lots (ADR-0015) ──────────────────────────────────────────────────────────

/** Columns of the lots table (v2 format), by header text. */
const LOT_COLUMNS = {
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
} as const;

export type LotColumn = keyof typeof LOT_COLUMNS;

/**
 * The `Lots` table cannot be read as such (a missing section, a misspelled column): the heartbeat
 * reports it instead of refusing the file. Its message starts with `portfolioWhere`, like every lots
 * warning.
 */
export class LotsTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LotsTableError";
  }
}

/** The message for a silo without its `## <CURRENCY> — Lots` section: the one place it is worded. */
export const missingLotsSection = (currency: Currency): string =>
  `${portfolioWhere(currency)}: missing section "## ${currency} — Lots" (see docs/input-format.md)`;

export function lotColumns(header: readonly string[], currency: Currency): Record<LotColumn, number> {
  const { indexes, missing } = columnIndexes(header, LOT_COLUMNS);
  if (missing.length > 0) {
    // A v2 file written before the `Ticker` column existed (PR #50) has all the others.
    const fix = missing.includes("Ticker") ? ` (add a "Ticker" column, first, to "## ${currency} — Lots")` : "";
    throw new LotsTableError(
      `${portfolioWhere(currency)}: ## ${currency} — Lots: columns ${missing.join(", ")} missing from the table header${fix}`,
    );
  }
  return indexes;
}

/** The rows of the silo's `Lots` table, header first; a `LotsTableError` if the section is missing. */
function lotsTable(md: string, currency: Currency): string[][] {
  if (!hasSection(parsePortfolio(md), currency, "Lots")) throw new LotsTableError(missingLotsSection(currency));
  return tableRows(md, currency, "Lots");
}

/** What the `Lots` table of a silo reads as: the lots, and one message per row it skipped. */
export interface LotRows {
  lots: Lot[];
  /** The skipped rows, one message each (`Lots row 2 (AAPL, id): <reason>; the row is skipped`, without the file prefix). */
  skipped: SkippedLotRow[];
}

/**
 * Reads the rows of the `## <CURRENCY> — Lots` table (columns in LOT_COLUMNS, in any order). Placeholder
 * rows and a repeated header are nothing. A row that does not read as a lot (no id or ticker, units or
 * price that are not numbers, an origin or date out of format, ...) is skipped and reported in `skipped`
 * with the reason: it then does not count towards its position's `Volume`, and the lots check says so
 * instead of only reporting the mismatch. A silo without the section throws a `LotsTableError`.
 * Cross-checks with the log are not made here: this parser is pure.
 */
export function parseLotRows(md: string, currency: Currency): LotRows {
  const [header, ...rows] = lotsTable(md, currency);
  const result: LotRows = { lots: [], skipped: [] };
  if (!header) return result;
  const col = lotColumns(header, currency);
  rows.forEach((cells, i) => {
    const reading = readLotRow(cells, col);
    if (reading === null) return;
    if ("lot" in reading) {
      result.lots.push(reading.lot);
      return;
    }
    const cell = (key: LotColumn) => (cells[col[key]] ?? "").trim();
    const named = [cell("ticker"), cell("entryId")].filter((c) => !isPlaceholder(c));
    const name = named.length > 0 ? ` (${named.join(", ")})` : "";
    const ticker = isPlaceholder(cell("ticker")) ? undefined : checkTicker(cell("ticker"));
    result.skipped.push({
      message: `Lots row ${i + 1}${name}: ${reading.reason}; the row is skipped`,
      ...(ticker && "ticker" in ticker ? { ticker: ticker.ticker } : {}),
      ...(isPlaceholder(cell("entryId")) ? {} : { entryId: cell("entryId") }),
    });
  });
  return result;
}

/** The lots of the silo's `Lots` table; see `parseLotRows` for the rows it skips. */
export function parseLots(md: string, currency: Currency): Lot[] {
  return parseLotRows(md, currency).lots;
}

/**
 * A row of the lots table: `null` for a placeholder (every cell empty or `—`) or a repeated header, a
 * `lot`, or the `reason` it does not read as one. Origin matches exactly (it is compared with the
 * log's, which writes it in lower case); the headers are the owner's to type and match any case.
 */
function readLotRow(
  cells: readonly string[],
  col: Record<LotColumn, number>,
): { lot: Lot } | { reason: string } | null {
  const cell = (key: LotColumn) => (cells[col[key]] ?? "").trim();
  if (cells.every((c) => isPlaceholder(c.trim())) || /^entry id$/i.test(cell("entryId"))) return null;
  if (isPlaceholder(cell("entryId"))) return { reason: "no Entry id" };
  if (isPlaceholder(cell("ticker"))) return { reason: "no Ticker" };
  const ticker = checkTicker(cell("ticker"));
  if ("problem" in ticker)
    return { reason: `Ticker ${JSON.stringify(cell("ticker"))} does not read: ${ticker.problem}` };

  const numbers = {} as Record<"units" | "entryUnits" | "entryPrice", number>;
  for (const key of ["units", "entryUnits", "entryPrice"] as const) {
    const value = parseMarkdownNumber(cell(key));
    if (value == null) return { reason: `${LOT_COLUMNS[key]} "${cell(key)}" is not a number` };
    numbers[key] = value;
  }
  const costs = cell("entryCosts");
  const costsNumber = parseMarkdownNumber(costs);
  if (costsNumber !== null && !canCountInCents(costsNumber)) {
    return { reason: `${LOT_COLUMNS.entryCosts} "${costs}" is too large to count in cents` };
  }
  const entryCosts = costsNumber === null ? null : money(costsNumber);
  const origin = cell("origin");
  if (!(DECISION_ORIGINS as readonly string[]).includes(origin)) {
    const right = DECISION_ORIGINS.find((o) => o === origin.toLowerCase());
    const hint = right ? ` (write it "${right}")` : "";
    return { reason: `Origin "${origin}" is not ${DECISION_ORIGINS.join(" or ")}${hint}` };
  }
  const date = cell("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { reason: `Date "${date}" is not YYYY-MM-DD` };
  const rulesVersion = cell("rulesVersion");
  if (isPlaceholder(rulesVersion)) return { reason: "no Rules version" };

  return {
    lot: {
      ticker: ticker.ticker,
      entryId: cell("entryId"),
      date,
      units: numbers.units,
      entryUnits: numbers.entryUnits,
      entryPrice: numbers.entryPrice,
      initialStop: parseMarkdownNumber(cell("initialStop")),
      entryCosts,
      origin: origin as Lot["origin"],
      rulesVersion,
      rulesViolations: isPlaceholder(cell("rulesViolations"))
        ? []
        : cell("rulesViolations")
            .split(",")
            .map((v) => v.trim())
            .filter((v) => v !== ""),
    },
  };
}
