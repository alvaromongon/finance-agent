// Builders for the v2 portfolio.md fixtures: the `Lots` table of a silo and the decision-log lines of
// the entries behind its lots (ADR-0015). Plain strings and objects, no engine imports: a test
// file sets VAULT_PROJECT_DIR before it first imports the engine, and this must not load it first.

export type Silo = "EUR" | "USD";

/** One open lot, which is also the whole position of its ticker unless a test adds more. */
export interface HeldLot {
  ticker: string;
  /** Units still open. */
  units: number;
  /** Entry price. */
  price: number;
  /** Entry id; defaults to one derived from the ticker. */
  id?: string;
  /** Units the entry bought; defaults to `units`. */
  entryUnits?: number;
  date?: string;
  stop?: number;
}

export const LOTS_HEADER = [
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

export const lotId = (ticker: string): string => `lot-${ticker.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;

/** A Markdown table from a header and its rows. */
export const mdTable = (header: string[], rows: string[]): string =>
  [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows].join("\n");

/** The `## <CCY> — Lots` section for these lots; the rows are in the order given. */
export function lotsSection(currency: Silo, held: HeldLot[] = []): string {
  const rows = held.map(
    (l) =>
      `| ${l.id ?? lotId(l.ticker)} | ${l.date ?? "2026-06-15"} | ${l.units} | ${l.entryUnits ?? l.units} | ${l.price} | ${
        l.stop ?? "—"
      } | — | sistema | 1.0 | — |`,
  );
  return `## ${currency} — Lots\n\n${mdTable(LOTS_HEADER, rows)}\n`;
}

/** The `entry` lines of the decision log that these lots come from, as JSONL. */
export function entryLines(currency: Silo, held: HeldLot[]): string {
  return held
    .map((l) => {
      const entryUnits = l.entryUnits ?? l.units;
      return JSON.stringify({
        id: l.id ?? lotId(l.ticker),
        date: l.date ?? "2026-06-15",
        ticker: l.ticker,
        currency,
        origin: "sistema",
        source: "portfolio-sync",
        type: "entry",
        price: l.price,
        amount: Math.round(entryUnits * l.price * 100) / 100,
        ...(l.stop != null ? { stop_initial: l.stop } : {}),
        rules_version: "1.0",
      });
    })
    .map((line) => `${line}\n`)
    .join("");
}
