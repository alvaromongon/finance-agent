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

export const lotId = (ticker: string): string => `lot-${ticker.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;

/** A Markdown table from a header and its rows. */
export const mdTable = (header: string[], rows: string[]): string =>
  [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows].join("\n");

/** The `## <CCY> — Lots` section for these lots; the rows are in the order given. */
export function lotsSection(currency: Silo, held: HeldLot[] = []): string {
  const rows = held.map(
    (l) =>
      `| ${l.ticker} | ${l.id ?? lotId(l.ticker)} | ${l.date ?? "2026-06-15"} | ${l.units} | ${l.entryUnits ?? l.units} | ${l.price} | ${
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

/** Applies `edit` to the `## USD — Lots` section of a portfolio.md text (up to the next `## ` heading or the end). */
function inUsdLots(portfolioMd: string, edit: (section: string) => string): string {
  const start = portfolioMd.indexOf("## USD — Lots");
  if (start < 0) throw new Error("the fixture has no `## USD — Lots` section");
  const next = portfolioMd.indexOf("\n## ", start + 1);
  const end = next < 0 ? portfolioMd.length : next;
  return portfolioMd.slice(0, start) + edit(portfolioMd.slice(start, end)) + portfolioMd.slice(end);
}

/**
 * The same portfolio.md with the USD silo's `Lots` broken in the three ways the tolerant readers
 * (`pending:resolve`, the Monday briefing, the weekly screening) must carry on through: a misspelled
 * heading (the section is missing), an unreadable table header (a column is missing: a
 * `LotsTableError`), and one unreadable row (Units "TBD": the row is skipped, the header reads).
 * The USD silo is the one that holds a position and a lot in the flow fixtures.
 */
export function brokenUsdLots(portfolioMd: string): [label: string, brokenMd: string][] {
  return [
    ["a misspelled Lots heading", portfolioMd.replace("## USD — Lots", "## USD — Lotes")],
    [
      "an unreadable Lots table header",
      inUsdLots(portfolioMd, (section) => section.replace("| Entry price |", "| Precio |")),
    ],
    [
      "an unreadable Lots row",
      inUsdLots(portfolioMd, (section) => {
        const lines = section.replace(/\n$/, "").split("\n");
        const firstRow = lines.findIndex((line, i) => i >= 4 && line.startsWith("|"));
        if (firstRow >= 0) {
          // Units is the fourth cell: `| Ticker | Entry id | Date | Units | ...`.
          const cells = lines[firstRow].split("|");
          cells[4] = " TBD ";
          lines[firstRow] = cells.join("|");
        } else {
          lines.push("| BAD | lot-bad | 2026-06-15 | TBD | 1 | 10 | — | — | sistema | 1.0 | — |");
        }
        return `${lines.join("\n")}\n`;
      }),
    ],
  ];
}
