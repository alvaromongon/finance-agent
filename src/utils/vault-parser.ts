// Pure parsing functions for the vault Markdown. No I/O, no config.
// Exported so they can be unit-tested.
import yaml from "js-yaml";
import { normalizeEol, parseMarkdownNumber } from "./parse.js";
import { DECISION_ORIGINS } from "../decisions.js";
import type { Currency, Lot, Position } from "../types.js";

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

export type PortfolioSection = "Cash" | "Positions" | "Lots";

/**
 * Range [start, end) of the body under the `## <CURRENCY> — <kind>` heading
 * up to the next `##` heading or `---` rule; `null` if it does not exist.
 * Accepts em dash, en dash or hyphen. `md` must have normalized EOLs
 * (readTextFile already normalizes them).
 */
export function sectionRange(
  md: string,
  currency: Currency,
  kind: PortfolioSection,
): { start: number; end: number } | null {
  const headingRe = new RegExp(`^##\\s+${currency}\\s+[—–-]\\s+${kind}\\b.*$`, "m");
  const m = headingRe.exec(md);
  if (!m) return null;
  const start = m.index + m[0].length;
  const next = md.slice(start).search(/^(?:##\s|---\s*$)/m);
  return { start, end: next === -1 ? md.length : start + next };
}

/** Body of the `## <CURRENCY> — <kind>` section; empty string if it does not exist. */
export function sectionBody(md: string, currency: Currency, kind: PortfolioSection): string {
  const normalized = normalizeEol(md);
  const range = sectionRange(normalized, currency, kind);
  return range ? normalized.slice(range.start, range.end) : "";
}

/**
 * Checks the silo has the `Cash`, `Positions` and `Lots` sections and the
 * `Available cash` row. Without this, a misspelled heading or row (e.g. from
 * the previous format) would read as an empty silo and the heartbeat would
 * silently stop watching its positions.
 */
export function assertPortfolioSections(md: string, currency: Currency): void {
  const normalized = normalizeEol(md);
  for (const kind of ["Cash", "Positions", "Lots"] as const) {
    if (!sectionRange(normalized, currency, kind)) {
      throw new Error(`portfolio.md: missing section "## ${currency} — ${kind}" (see docs/input-format.md)`);
    }
  }
  const hasAvailableCash = parseTableRows(sectionBody(normalized, currency, "Cash")).some((cells) =>
    AVAILABLE_CASH_RE.test(cells[0] ?? ""),
  );
  if (!hasAvailableCash) {
    throw new Error(`portfolio.md: missing "Available cash" row in "## ${currency} — Cash" (see docs/input-format.md)`);
  }
}

/** Extracts the data rows of a Markdown table (skips the |---| separator). */
export function parseTableRows(body: string): string[][] {
  const rows: string[][] = [];
  for (const line of normalizeEol(body).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .slice(1, trimmed.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    rows.push(cells);
  }
  return rows;
}

/**
 * Reads "Available cash" from the `## <CURRENCY> — Cash` section: the capital
 * free to trade. Returns 0 if there is no parseable number (e.g. "TBD").
 */
const AVAILABLE_CASH_RE = /^available\s+cash$/i;

export function parseCash(md: string, currency: Currency): number {
  return cashRow(md, currency, AVAILABLE_CASH_RE) ?? 0;
}

/**
 * Reads "Total cash" from the `## <CURRENCY> — Cash` section: the account
 * balance including what pending orders hold. The row is optional because it
 * only differs from the available balance while there are pending orders;
 * `null` if missing or not a number.
 */
export function parseTotalCash(md: string, currency: Currency): number | null {
  return cashRow(md, currency, /^total\s+cash$/i);
}

function cashRow(md: string, currency: Currency, label: RegExp): number | null {
  const rows = parseTableRows(sectionBody(md, currency, "Cash"));
  const row = rows.find((cells) => label.test(cells[0] ?? ""));
  return row ? parseMarkdownNumber(row[1]) : null;
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
  ticker: string;
  name: string;
  index: string;
  date: string;
  result: ScreeningResultValue;
  summary: string;
  nextReview: string;
}

/**
 * Parses the screening-log.md table from its raw content.
 * Skips the header row (first row with "Ticker" as its first cell).
 */
export function parseScreeningLog(md: string): ScreeningLogRow[] {
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
    .map((cells) => ({
      ticker: cells[0],
      name: cells[1],
      index: cells[2],
      date: cells[3],
      result: cells[4] as ScreeningResultValue,
      summary: cells[5],
      nextReview: cells[6],
    }));
}

/**
 * Extracts the list of tickers to remove from the AUTOMATED_ACTIONS section
 * Claude adds at the end of the Monday Briefing.
 * Returns an empty array if there are no removals or the section is missing.
 */
export function extractRetireList(reviewText: string): string[] {
  // [ \t]* and not \s*: with an empty `RETIRE:`, \s* jumped to the next line
  // and returned "PLAN_SUMMARY: …" as if it were a ticker to remove.
  const match = /^##\s+AUTOMATED_ACTIONS\s*\nRETIRE:[ \t]*(.*)$/m.exec(normalizeEol(reviewText));
  const line = match?.[1]?.trim() ?? "";
  return line
    ? line
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
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
 * Adds an entry to the watchlist.md YAML block.
 * Pure function: takes the current markdown and returns the updated one.
 * Returns the same string if the ticker already exists.
 */
export function applyAddWatchlistEntry(md: string, entry: import("../types.js").WatchlistEntry): string {
  md = normalizeEol(md);
  const block = extractYamlBlock(md);
  const parsed = yaml.load(block) as { watchlist?: import("../types.js").WatchlistEntry[] };
  const watchlist = parsed?.watchlist ?? [];
  if (watchlist.some((e) => e.ticker === entry.ticker)) return md;
  watchlist.push(entry);
  const newYaml = yaml.dump({ watchlist }, { lineWidth: 120, quotingType: '"' });
  return md.replace(/```yaml\n[\s\S]*?\n```/, "```yaml\n" + newYaml + "```");
}

/**
 * Removes a ticker from the watchlist.md YAML block.
 * Pure function: takes the current markdown and returns the updated one.
 */
export function applyRetireWatchlistEntry(md: string, ticker: string): string {
  md = normalizeEol(md);
  const block = extractYamlBlock(md);
  const parsed = yaml.load(block) as { watchlist?: import("../types.js").WatchlistEntry[] };
  const watchlist = (parsed?.watchlist ?? []).filter((e) => e.ticker !== ticker);
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
 * Index of each positions-table column from its header row (the table's
 * first row). Columns are read by name, not by position; a missing one →
 * error with the section and the column.
 */
export function positionColumns(header: readonly string[], currency: Currency): Record<PositionColumn, number> {
  const normalized = header.map((c) => c.trim().toLowerCase());
  const missing: string[] = [];
  const indexes = {} as Record<PositionColumn, number>;
  for (const [key, label] of Object.entries(POSITION_COLUMNS) as [PositionColumn, string][]) {
    const i = normalized.indexOf(label.toLowerCase());
    if (i === -1) missing.push(label);
    indexes[key] = i;
  }
  if (missing.length > 0) {
    throw new Error(`## ${currency} — Positions: columns ${missing.join(", ")} missing from the table header`);
  }
  return indexes;
}

/** True if the row is a placeholder or a repeated header, not a position. */
export function isPositionPlaceholder(ticker: string): boolean {
  return !ticker || ticker === "—" || ticker === "-" || /^ticker$/i.test(ticker);
}

/**
 * Parses the rows of the `## <CURRENCY> — Positions` table (columns in
 * POSITION_COLUMNS, in any order). Skips placeholder rows ("—") and ignores
 * rows without a numeric volume/average price.
 */
export function parsePositions(md: string, currency: Currency): Position[] {
  const [header, ...rows] = parseTableRows(sectionBody(md, currency, "Positions"));
  if (!header) return [];
  const col = positionColumns(header, currency);
  const positions: Position[] = [];

  for (const cells of rows) {
    const ticker = (cells[col.ticker] ?? "").trim();
    if (isPositionPlaceholder(ticker)) continue;

    const volume = parseMarkdownNumber(cells[col.volume]);
    const avgPrice = parseMarkdownNumber(cells[col.avgPrice]);
    if (volume == null || avgPrice == null) continue;

    positions.push({
      ticker,
      currency,
      volume,
      avgPrice,
      currentPrice: parseMarkdownNumber(cells[col.currentPrice]) ?? 0,
      pl: parseMarkdownNumber(cells[col.pl]) ?? 0,
      stopLoss: parseMarkdownNumber(cells[col.stopLoss]),
    });
  }

  return positions;
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

export function lotColumns(header: readonly string[], currency: Currency): Record<LotColumn, number> {
  const normalized = header.map((c) => c.trim().toLowerCase());
  const missing: string[] = [];
  const indexes = {} as Record<LotColumn, number>;
  for (const [key, label] of Object.entries(LOT_COLUMNS) as [LotColumn, string][]) {
    const i = normalized.indexOf(label.toLowerCase());
    if (i === -1) missing.push(label);
    indexes[key] = i;
  }
  if (missing.length > 0) {
    throw new Error(`## ${currency} — Lots: columns ${missing.join(", ")} missing from the table header`);
  }
  return indexes;
}

const isPlaceholder = (cell: string): boolean => cell === "" || cell === "—" || cell === "-";

/**
 * Parses the rows of the `## <CURRENCY> — Lots` table (columns in LOT_COLUMNS, in any order). Skips
 * placeholder rows and rows that do not read as a lot (no id or ticker, units or price that are numbers, ...):
 * the lot then does not count towards its position's `Volume`, so the check against the decision
 * log reports the mismatch instead of the row vanishing silently. Cross-checks with the log are
 * not made here: this parser is pure.
 */
export function parseLots(md: string, currency: Currency): Lot[] {
  const [header, ...rows] = parseTableRows(sectionBody(md, currency, "Lots"));
  if (!header) return [];
  const col = lotColumns(header, currency);
  return rows.map((cells) => lotOfRow(cells, col)).filter((lot): lot is Lot => lot !== null);
}

/** True for a placeholder row (`—`) or a repeated header of the lots table: not a lot, and nothing to keep. */
export function isLotPlaceholderRow(cells: readonly string[], col: Record<LotColumn, number>): boolean {
  const entryId = (cells[col.entryId] ?? "").trim();
  return isPlaceholder(entryId) || /^entry id$/i.test(entryId) || isPlaceholder((cells[col.ticker] ?? "").trim());
}

/** The lot a row of the lots table reads as; `null` for a placeholder or a row that does not read as a lot. */
export function lotOfRow(cells: readonly string[], col: Record<LotColumn, number>): Lot | null {
  if (isLotPlaceholderRow(cells, col)) return null;
  const cell = (key: LotColumn) => (cells[col[key]] ?? "").trim();
  const units = parseMarkdownNumber(cell("units"));
  const entryUnits = parseMarkdownNumber(cell("entryUnits"));
  const entryPrice = parseMarkdownNumber(cell("entryPrice"));
  const origin = cell("origin");
  const rulesVersion = cell("rulesVersion");
  const date = cell("date");
  if (units == null || entryUnits == null || entryPrice == null) return null;
  if (!(DECISION_ORIGINS as readonly string[]).includes(origin) || isPlaceholder(rulesVersion)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  return {
    ticker: cell("ticker"),
    entryId: cell("entryId"),
    date,
    units,
    entryUnits,
    entryPrice,
    initialStop: parseMarkdownNumber(cell("initialStop")),
    entryCosts: parseMarkdownNumber(cell("entryCosts")),
    origin: origin as Lot["origin"],
    rulesVersion,
    rulesViolations: isPlaceholder(cell("rulesViolations"))
      ? []
      : cell("rulesViolations")
          .split(",")
          .map((v) => v.trim())
          .filter((v) => v !== ""),
  };
}
