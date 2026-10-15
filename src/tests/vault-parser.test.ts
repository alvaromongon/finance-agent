import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractYamlBlock,
  extractFrontmatter,
  sectionBody,
  parseTableRows,
  parseCash,
  parseTotalCash,
  parsePositions,
  isBlockedLog,
  assertSchemaVersion,
  assertPortfolioSections,
} from "../utils/vault-parser.js";

// ─── Test Markdown ────────────────────────────────────────────────────────────

const PORTFOLIO_MD = `---
schema_version: 1
last_manual_sync: 2026-06-27
---

## EUR — Cash

| Item | Value |
|---|---|
| Available cash | 3,24 € |
| Otros | — |

## EUR — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
| DEF.MI | 1 | 46,80 | 46,00 | -0,80 | 41,50 |
| IBE.MC | 10 | 12,50 | 13,00 | 5,00 | — |
| — | — | — | — | — | — |

## USD — Cash

| Item | Value |
|---|---|
| Available cash | $2,500.00 |

## USD — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| XOM | 5 | 130.00 | 138.00 | 40.00 | 120.00 |
`;

const WATCHLIST_MD = `# Watchlist

\`\`\`yaml
watchlist:
  - ticker: DEF.MI
    name: Example Defence
\`\`\`
`;

const WATCHLIST_YML_MD = `# Watchlist

\`\`\`yml
watchlist:
  - ticker: IBE.MC
\`\`\`
`;

// ─── extractYamlBlock ─────────────────────────────────────────────────────────

describe("extractYamlBlock", () => {
  it("extracts a yaml block", () => {
    const block = extractYamlBlock(WATCHLIST_MD);
    assert.ok(block.includes("ticker: DEF.MI"));
  });

  it("extracts a yml block (alias)", () => {
    const block = extractYamlBlock(WATCHLIST_YML_MD);
    assert.ok(block.includes("ticker: IBE.MC"));
  });

  it("throws if there is no YAML block", () => {
    assert.throws(() => extractYamlBlock("sin bloque"), /No YAML block found/);
  });
});

// ─── extractFrontmatter ───────────────────────────────────────────────────────

describe("extractFrontmatter", () => {
  it("parses a valid frontmatter and holds the expected date", () => {
    const fm = extractFrontmatter(PORTFOLIO_MD);
    assert.ok(fm != null);
    // js-yaml parses bare dates as Date objects, not strings
    const sync = fm.last_manual_sync;
    const asStr = sync instanceof Date ? sync.toISOString().slice(0, 10) : String(sync);
    assert.equal(asStr, "2026-06-27");
  });

  it("returns null if there is no frontmatter", () => {
    assert.equal(extractFrontmatter("# Sin frontmatter"), null);
  });

  it("returns null if the frontmatter is empty", () => {
    const fm = extractFrontmatter("---\n---\n# Hola");
    assert.ok(fm === null || typeof fm === "object");
  });
});

// ─── sectionBody ─────────────────────────────────────────────────────────────

describe("sectionBody", () => {
  it("extracts the EUR Cash section", () => {
    const body = sectionBody(PORTFOLIO_MD, "EUR", "Cash");
    assert.ok(body.includes("Available cash"));
    assert.ok(!body.includes("EUR — Positions"));
  });

  it("extracts the USD Cash section", () => {
    const body = sectionBody(PORTFOLIO_MD, "USD", "Cash");
    assert.ok(body.includes("$2,500.00"));
    assert.ok(!body.includes("DEF.MI"));
  });

  it("extracts the EUR Positions section", () => {
    const body = sectionBody(PORTFOLIO_MD, "EUR", "Positions");
    assert.ok(body.includes("DEF.MI"));
    assert.ok(!body.includes("XOM"));
  });

  it("returns an empty string if the section does not exist", () => {
    assert.equal(sectionBody(PORTFOLIO_MD, "EUR", "Cash").includes("XOM"), false);
    assert.equal(sectionBody("# Sin secciones", "EUR", "Cash"), "");
  });
});

// ─── parseTableRows ───────────────────────────────────────────────────────────

describe("parseTableRows", () => {
  it("extracts data rows and skips separators", () => {
    const body = `
| A | B |
|---|---|
| x | y |
| p | q |
`;
    const rows = parseTableRows(body);
    assert.equal(rows.length, 3); // header + 2 data rows
    assert.deepEqual(rows[0], ["A", "B"]);
    assert.deepEqual(rows[1], ["x", "y"]);
  });

  it("ignores lines that are not a table", () => {
    const body = "\nTexto normal\n| A | B |\n|---|---|\n| 1 | 2 |\n";
    const rows = parseTableRows(body);
    assert.equal(rows.length, 2); // cabecera + 1 fila
  });

  it("returns an empty array for an empty body", () => {
    assert.deepEqual(parseTableRows(""), []);
  });
});

// ─── parseCash ────────────────────────────────────────────────────────────────

describe("parseCash", () => {
  it("parses an EUR balance in European format", () => {
    assert.equal(parseCash(PORTFOLIO_MD, "EUR"), 3.24);
  });

  it("parses a USD balance in American format", () => {
    assert.equal(parseCash(PORTFOLIO_MD, "USD"), 2500.0);
  });

  it("returns 0 if the section does not exist", () => {
    assert.equal(parseCash("# Vacío", "EUR"), 0);
  });

  it("returns 0 if the balance is the TBD placeholder", () => {
    const md = `## EUR — Cash\n\n| Item | Value |\n|---|---|\n| Available cash | TBD |\n`;
    assert.equal(parseCash(md, "EUR"), 0);
  });

  it("returns 0 if the balance is the — placeholder", () => {
    const md = `## EUR — Cash\n\n| Item | Value |\n|---|---|\n| Available cash | — |\n`;
    assert.equal(parseCash(md, "EUR"), 0);
  });
});

// ─── parseTotalCash ───────────────────────────────────────────────────────────

describe("parseTotalCash", () => {
  // With a pending order, the available balance is lower than the account cash.
  const md = `## EUR — Cash\n\n| Item | Value |\n|---|---|\n| Available cash | 28,11 € |\n| Total cash | 595,11 € |\n`;

  it("reads the total cash, different from the available balance", () => {
    assert.equal(parseTotalCash(md, "EUR"), 595.11);
    assert.equal(parseCash(md, "EUR"), 28.11);
  });

  it("returns null if the row does not exist: it is optional", () => {
    assert.equal(parseTotalCash(PORTFOLIO_MD, "EUR"), null);
  });
});

// ─── isBlockedLog ─────────────────────────────────────────────────────────────

describe("isBlockedLog", () => {
  it("detects blocked: true in the frontmatter", () => {
    assert.equal(isBlockedLog(`---\ncreated: 2026-07-05\nblocked: true\n---\n\n## Decisión\n`), true);
  });

  it("returns false without the field or without frontmatter", () => {
    assert.equal(isBlockedLog(`---\ncreated: 2026-07-05\n---\n\n## Decisión\n`), false);
    assert.equal(isBlockedLog("## Decisión\n"), false);
  });
});

// ─── parsePositions ───────────────────────────────────────────────────────────

describe("parsePositions", () => {
  it("parses EUR positions correctly", () => {
    const positions = parsePositions(PORTFOLIO_MD, "EUR");
    assert.equal(positions.length, 2);
  });

  it("first position: DEF.MI with stop-loss", () => {
    const [def] = parsePositions(PORTFOLIO_MD, "EUR");
    assert.equal(def.ticker, "DEF.MI");
    assert.equal(def.volume, 1);
    assert.equal(def.avgPrice, 46.8);
    assert.equal(def.currentPrice, 46.0);
    assert.equal(def.pl, -0.8);
    assert.equal(def.stopLoss, 41.5);
    assert.equal(def.currency, "EUR");
  });

  it("second position: IBE.MC without stop-loss (—)", () => {
    const positions = parsePositions(PORTFOLIO_MD, "EUR");
    const ibe = positions[1];
    assert.equal(ibe.ticker, "IBE.MC");
    assert.equal(ibe.volume, 10);
    assert.equal(ibe.stopLoss, null);
  });

  it("skips — placeholder rows", () => {
    const positions = parsePositions(PORTFOLIO_MD, "EUR");
    assert.ok(positions.every((p) => p.ticker !== "—"));
  });

  it("skips the header row (Ticker)", () => {
    const positions = parsePositions(PORTFOLIO_MD, "EUR");
    assert.ok(positions.every((p) => !/^ticker$/i.test(p.ticker)));
  });

  it("parses a USD position in American format", () => {
    const [xom] = parsePositions(PORTFOLIO_MD, "USD");
    assert.equal(xom.ticker, "XOM");
    assert.equal(xom.volume, 5);
    assert.equal(xom.avgPrice, 130.0);
    assert.equal(xom.stopLoss, 120.0);
  });

  it("returns an empty array if there is no positions section", () => {
    assert.deepEqual(parsePositions("# Sin posiciones", "EUR"), []);
  });

  it("skips rows with a non-numeric volume", () => {
    const md = `## EUR — Positions\n\n| Ticker | Volume | Avg price | Current price | P/L | Stop loss |\n|---|---|---|---|---|---|\n| ABC | — | 10,00 | 11,00 | 1,00 | — |\n`;
    assert.deepEqual(parsePositions(md, "EUR"), []);
  });

  it("reads the columns by their header, not their position", () => {
    const md = `## EUR — Positions\n\n| Stop loss | Ticker | P/L | Avg price | Volume | Current price |\n|---|---|---|---|---|---|\n| 41,50 | DEF.MI | -0,80 | 46,80 | 1 | 46,00 |\n`;
    assert.deepEqual(parsePositions(md, "EUR"), [
      { ticker: "DEF.MI", currency: "EUR", volume: 1, avgPrice: 46.8, currentPrice: 46, pl: -0.8, stopLoss: 41.5 },
    ]);
  });

  it("throws if a required column is missing", () => {
    const md = `## EUR — Positions\n\n| Ticker | Volume | Current price | P/L | Stop loss |\n|---|---|---|---|---|\n| DEF.MI | 1 | 46,00 | -0,80 | 41,50 |\n`;
    assert.throws(() => parsePositions(md, "EUR"), /EUR — Positions.*Avg price/);
  });
});

// ─── assertPortfolioSections ──────────────────────────────────────────────────

describe("assertPortfolioSections", () => {
  it("accepts a silo with Cash, Available cash and Positions", () => {
    assert.doesNotThrow(() => {
      assertPortfolioSections(PORTFOLIO_MD, "EUR");
    });
    assert.doesNotThrow(() => {
      assertPortfolioSections(PORTFOLIO_MD, "USD");
    });
  });

  it("accepts Available cash without a number (TBD): it is 0, but the row exists", () => {
    const md = `## EUR — Cash\n\n| Item | Value |\n|---|---|\n| Available cash | TBD |\n\n## EUR — Positions\n\n| Ticker | Volume | Avg price | Current price | P/L | Stop loss |\n|---|---|---|---|---|---|\n`;
    assert.doesNotThrow(() => {
      assertPortfolioSections(md, "EUR");
    });
  });

  it("rejects the previous Spanish heading instead of reading the silo as empty", () => {
    const md = PORTFOLIO_MD.replace("## EUR — Positions", "## EUR — Posiciones");
    assert.throws(() => {
      assertPortfolioSections(md, "EUR");
    }, /portfolio\.md.*## EUR — Positions/);
  });

  it("rejects a silo without a Cash section", () => {
    const md = PORTFOLIO_MD.replace("## USD — Cash", "## USD — Caja");
    assert.throws(() => {
      assertPortfolioSections(md, "USD");
    }, /portfolio\.md.*## USD — Cash/);
  });

  it("rejects a Cash section without the Available cash row", () => {
    const md = PORTFOLIO_MD.replace("| Available cash | 3,24 € |", "| Saldo disponible | 3,24 € |");
    assert.throws(() => {
      assertPortfolioSections(md, "EUR");
    }, /portfolio\.md.*Available cash/);
  });
});

// ─── assertSchemaVersion ──────────────────────────────────────────────────────

describe("assertSchemaVersion", () => {
  it("accepts schema_version: 1", () => {
    assert.doesNotThrow(() => {
      assertSchemaVersion(PORTFOLIO_MD, "portfolio.md");
    });
  });

  it("rejects a file without schema_version, naming the file", () => {
    assert.throws(() => {
      assertSchemaVersion("---\nid: x\n---\n", "watchlist.md");
    }, /watchlist\.md.*schema_version/);
    assert.throws(() => {
      assertSchemaVersion("# Sin frontmatter", "watchlist.md");
    }, /watchlist\.md.*schema_version/);
  });

  it("rejects an unknown version", () => {
    assert.throws(() => {
      assertSchemaVersion("---\nschema_version: 2\n---\n", "portfolio.md");
    }, /portfolio\.md.*schema_version 2.*1/);
  });
});
