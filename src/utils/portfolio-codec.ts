// The codec of `portfolio.md`: the one module that knows its grammar (ADR-0015, #67). Pure: no I/O.
//
// - `parsePortfolio` gives a model that keeps every line of the file, with its own line end (notes,
//   blank lines, spacing, CRLF included); `serializePortfolio` writes it back, byte for byte.
// - The readers look at the model (`readTable`, `sectionBody`); the writers return a new model
//   (`setTableRows`, `mapTableRows`). Nobody else splits or joins the rows of `portfolio.md`.
//
// A `## <CURRENCY> — <kind>` section holds one table, however many blank lines or notes split it: the
// first table line is the header, the others are its rows (a separator line is never a row). A
// write turns it into one contiguous block.
import type { Currency } from "../types.js";
import { normalizeEol } from "./parse.js";

export type PortfolioSection = "Cash" | "Positions" | "Lots";

/** One line of the file and the line end that followed it (`""` for the last line of a file without one). */
export interface PortfolioLine {
  text: string;
  eol: string;
}

/** `portfolio.md` as its lines, in order. */
export interface PortfolioModel {
  lines: PortfolioLine[];
}

/** The text as a model that keeps every line and every line end (`\n`, `\r\n`, `\r`). */
export function parsePortfolio(text: string): PortfolioModel {
  const parts = text.split(/(\r\n|\r|\n)/);
  const lines: PortfolioLine[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const eol = parts[i + 1] ?? "";
    // The empty piece after the last line end is not a line.
    if (parts[i] === "" && eol === "") break;
    lines.push({ text: parts[i], eol });
  }
  return { lines };
}

/** The model as text: `serializePortfolio(parsePortfolio(text)) === text`. */
export function serializePortfolio(model: PortfolioModel): string {
  return model.lines.map((line) => line.text + line.eol).join("");
}

// ─── Tables ───────────────────────────────────────────────────────────────────

/** True for a line of a Markdown table (it starts with `|`). */
export const isTableLine = (line: string): boolean => line.trim().startsWith("|");

/** The trimmed cells of a table line, with or without the closing `|`. */
export function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  return trimmed
    .slice(1, trimmed.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((c) => c.trim());
}

/** True for the `|---|:---:|` line under a table header. */
export const isTableSeparator = (cells: readonly string[]): boolean => cells.every((c) => /^:?-+:?$/.test(c));

/** The line a row is written as. */
export const renderTableRow = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;

/** The rows of a Markdown table in `body` (any text), header first, separator lines left out. */
export function parseTableRows(body: string): string[][] {
  return rowsOf(parsePortfolio(body).lines);
}

function rowsOf(lines: readonly PortfolioLine[]): string[][] {
  const rows: string[][] = [];
  for (const { text } of lines) {
    if (!isTableLine(text)) continue;
    const cells = splitTableRow(text);
    if (!isTableSeparator(cells)) rows.push(cells);
  }
  return rows;
}

/** A table as the readers see it: its header (`undefined` for a section with no table) and its data rows. */
export interface PortfolioTable {
  header: string[] | undefined;
  rows: string[][];
}

// ─── Sections ─────────────────────────────────────────────────────────────────

interface Span {
  /** Index of the heading line. */
  heading: number;
  /** First line of the body. */
  start: number;
  /** One past the last line of the body: the next `##` heading or `---` rule, or the end of the file. */
  end: number;
}

/**
 * The body of the `## <CURRENCY> — <kind>` section, up to the next `##` heading or `---` rule; `null` if
 * it does not exist. The heading takes an em dash, an en dash or a hyphen.
 */
function spanOf(model: PortfolioModel, currency: Currency, kind: PortfolioSection): Span | null {
  const headingRe = new RegExp(`^##\\s+${currency}\\s+[—–-]\\s+${kind}\\b.*$`);
  const { lines } = model;
  const heading = lines.findIndex((line) => headingRe.test(line.text));
  if (heading === -1) return null;
  const start = heading + 1;
  let end = start;
  while (end < lines.length && !/^(?:##\s|---\s*$)/.test(lines[end].text)) end++;
  return { heading, start, end };
}

/** True if the silo has the section. */
export const hasSection = (model: PortfolioModel, currency: Currency, kind: PortfolioSection): boolean =>
  spanOf(model, currency, kind) !== null;

/** The table of the section; `null` if the section does not exist. */
export function readTable(model: PortfolioModel, currency: Currency, kind: PortfolioSection): PortfolioTable | null {
  const span = spanOf(model, currency, kind);
  if (!span) return null;
  const [header, ...rows] = rowsOf(model.lines.slice(span.start, span.end));
  return { header, rows };
}

/** Range [start, end) of the section body in the text of `md`, as character offsets; `null` if it does not exist. */
export function sectionRange(
  md: string,
  currency: Currency,
  kind: PortfolioSection,
): { start: number; end: number } | null {
  const model = parsePortfolio(md);
  const span = spanOf(model, currency, kind);
  if (!span) return null;
  const offsetOf = (index: number) =>
    model.lines.slice(0, index).reduce((sum, line) => sum + line.text.length + line.eol.length, 0);
  return { start: offsetOf(span.heading) + model.lines[span.heading].text.length, end: offsetOf(span.end) };
}

/** Body of the section as text with LF line ends; empty string if it does not exist. */
export function sectionBody(md: string, currency: Currency, kind: PortfolioSection): string {
  const normalized = normalizeEol(md);
  const range = sectionRange(normalized, currency, kind);
  return range ? normalized.slice(range.start, range.end) : "";
}

// ─── Writing ──────────────────────────────────────────────────────────────────

const docEol = (model: PortfolioModel): string => model.lines.find((line) => line.eol !== "")?.eol ?? "\n";

/**
 * The model with the data rows of the section's table replaced by what `edit` returns, from the header
 * cells and the current rows (placeholder rows included). The result is one contiguous table: the
 * header and separator lines stay as they are, the rows are rewritten, and the blank lines that
 * split the table are dropped; a note between its rows moves under it. A section with no table gets one with the
 * `canonicalHeader`, a blank line apart from what follows. `null` if the section does not exist.
 */
export function setTableRows(
  model: PortfolioModel,
  currency: Currency,
  kind: PortfolioSection,
  canonicalHeader: readonly string[],
  edit: (header: string[], rows: string[][]) => string[][],
): PortfolioModel | null {
  const span = spanOf(model, currency, kind);
  if (!span) return null;
  const { lines } = model;
  const eol = docEol(model);
  const newLine = (text: string): PortfolioLine => ({ text, eol });

  const tableAt: number[] = [];
  for (let i = span.start; i < span.end; i++) if (isTableLine(lines[i].text)) tableAt.push(i);

  if (tableAt.length === 0) {
    const table = [
      renderTableRow(canonicalHeader),
      renderTableRow(canonicalHeader.map(() => "---")),
      ...edit([...canonicalHeader], []).map(renderTableRow),
    ];
    // What followed the heading stays after the table, a blank line apart (as before a next heading).
    const rest = lines.slice(span.start, span.end);
    while (rest.length > 0 && rest[0].text.trim() === "") rest.shift();
    const after = rest.length > 0 ? [newLine(""), ...rest] : span.end < lines.length ? [newLine("")] : [];
    return {
      lines: [
        ...lines.slice(0, span.heading),
        { ...lines[span.heading], eol },
        newLine(""),
        ...table.map(newLine),
        ...after,
        ...lines.slice(span.end),
      ],
    };
  }

  const headerAt = tableAt[0];
  const lastAt = tableAt[tableAt.length - 1];
  const header = splitTableRow(lines[headerAt].text);
  const separatorAt = tableAt.length > 1 && isTableSeparator(splitTableRow(lines[tableAt[1]].text)) ? tableAt[1] : -1;
  const rows = tableAt
    .filter((i) => i !== headerAt && !isTableSeparator(splitTableRow(lines[i].text)))
    .map((i) => splitTableRow(lines[i].text));
  const notes = lines.slice(headerAt, lastAt + 1).filter((line) => !isTableLine(line.text) && line.text.trim() !== "");

  const block = [
    lines[headerAt],
    ...(separatorAt === -1 ? [] : [lines[separatorAt]]),
    ...edit(header, rows).map((cells) => newLine(renderTableRow(cells))),
    ...notes,
  ];
  // The last line of a file without a final line end stays the last line, without one.
  if (lines[lastAt].eol === "") block[block.length - 1] = { ...block[block.length - 1], eol: "" };
  return { lines: [...lines.slice(0, headerAt), ...block, ...lines.slice(lastAt + 1)] };
}

/**
 * The model with some rows of the section's table rewritten in place: `update` gets each data row
 * (header and separators excepted) and the header cells, and returns the new cells or `null` to
 * leave the line as it is. Nothing else moves. Returns `model` itself if no line changed; `null` if
 * the section does not exist.
 */
export function mapTableRows(
  model: PortfolioModel,
  currency: Currency,
  kind: PortfolioSection,
  update: (cells: string[], header: string[]) => string[] | null,
): PortfolioModel | null {
  const span = spanOf(model, currency, kind);
  if (!span) return null;
  const lines = [...model.lines];
  let header: string[] | undefined;
  let changed = false;
  for (let i = span.start; i < span.end; i++) {
    if (!isTableLine(lines[i].text)) continue;
    const cells = splitTableRow(lines[i].text);
    if (isTableSeparator(cells)) continue;
    if (!header) {
      header = cells;
      continue;
    }
    const next = update(cells, header);
    if (!next) continue;
    const text = renderTableRow(next);
    if (text === lines[i].text) continue;
    lines[i] = { ...lines[i], text };
    changed = true;
  }
  return changed ? { lines } : model;
}
