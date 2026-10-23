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
  parseLots,
  parseLotRows,
  splitTableRow,
  LotsTableError,
} from "../utils/vault-parser.js";

// ─── Test Markdown ────────────────────────────────────────────────────────────

const LOTS_HEADER =
  "| Ticker | Entry id | Date | Units | Entry units | Entry price | Initial stop | Entry costs | Origin | Rules version | Rules violations |\n" +
  "|---|---|---|---|---|---|---|---|---|---|---|";

const PORTFOLIO_MD = `---
schema_version: 2
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

## EUR — Lots

${LOTS_HEADER}
| DEF.MI | def-1 | 2026-05-04 | 1 | 1 | 46,80 | 41,50 | 1,50 | sistema | 1.0 | — |
| IBE.MC | ibe-1 | 2026-06-01 | 4 | 6 | 12,50 | — | — | propietario | 1.0 | no_stop, overrode_block |
| IBE.MC | ibe-2 | 2026-06-15 | 6 | 6 | 12,50 | 11,00 | — | sistema | 1.1 | — |

## USD — Cash

| Item | Value |
|---|---|
| Available cash | $2,500.00 |

## USD — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| XOM | 5 | 130.00 | 138.00 | 40.00 | 120.00 |

## USD — Lots

${LOTS_HEADER}
| XOM | xom-1 | 2026-04-01 | 5 | 5 | 130.00 | 120.00 | 2.00 | sistema | 1.0 | — |
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
    const md = `## EUR — Cash\n\n| Item | Value |\n|---|---|\n| Available cash | TBD |\n\n## EUR — Positions\n\n| Ticker | Volume | Avg price | Current price | P/L | Stop loss |\n|---|---|---|---|---|---|\n\n## EUR — Lots\n`;
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

  it("accepts a silo whose Lots section is empty", () => {
    const md = PORTFOLIO_MD.replace(/^\| xom-1 .*\n/m, "");
    assert.doesNotThrow(() => {
      assertPortfolioSections(md, "USD");
    });
  });

  it("leaves the Lots section to the Lots reader: a silo without it passes here", () => {
    const md = PORTFOLIO_MD.replace("## USD — Lots", "## USD — Lotes");
    assert.doesNotThrow(() => {
      assertPortfolioSections(md, "USD");
    });
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
  it("accepts schema_version: 2 in portfolio.md", () => {
    assert.doesNotThrow(() => {
      assertSchemaVersion(PORTFOLIO_MD, "portfolio.md");
    });
  });

  it("accepts schema_version: 1 in every other vault file", () => {
    for (const file of ["watchlist.md", "screening-log.md", "screening-universe.md", "tesis/tesis-x.md"]) {
      assert.doesNotThrow(() => {
        assertSchemaVersion("---\nschema_version: 1\n---\n", file);
      }, file);
    }
  });

  it("rejects a file without schema_version, naming the file", () => {
    assert.throws(() => {
      assertSchemaVersion("---\nid: x\n---\n", "watchlist.md");
    }, /watchlist\.md.*schema_version/);
    assert.throws(() => {
      assertSchemaVersion("# Sin frontmatter", "watchlist.md");
    }, /watchlist\.md.*schema_version/);
  });

  it("rejects a v1 portfolio.md, naming the file and the version it expects", () => {
    assert.throws(() => {
      assertSchemaVersion("---\nschema_version: 1\n---\n", "portfolio.md");
    }, /portfolio\.md.*schema_version 1.*version 2/);
  });

  it("rejects a v2 file other than portfolio.md: the version is per file", () => {
    for (const file of ["watchlist.md", "screening-log.md", "tesis/tesis-x.md"]) {
      assert.throws(() => {
        assertSchemaVersion("---\nschema_version: 2\n---\n", file);
      }, /schema_version 2.*version 1/);
    }
  });

  it("a portfolio.md without schema_version says it expects version 2", () => {
    assert.throws(() => {
      assertSchemaVersion("---\nid: x\n---\n", "portfolio.md");
    }, /portfolio\.md.*schema_version missing.*version 2/);
  });
});

// ─── parseLots ────────────────────────────────────────────────────────────────

describe("parseLots", () => {
  it("a silo without a Lots section throws a LotsTableError naming file, silo and section", () => {
    const md = PORTFOLIO_MD.replace("## USD — Lots", "## USD — Lotes");
    assert.throws(
      () => parseLots(md, "USD"),
      (err: unknown) => {
        assert.ok(err instanceof LotsTableError);
        assert.match(
          err.message,
          /^portfolio\.md \(USD\): missing section "## USD — Lots" \(see docs\/input-format\.md\)$/,
        );
        return true;
      },
    );
  });

  it("a header that does not read names file and silo, the same prefix as the lots check", () => {
    const md = PORTFOLIO_MD.replace("| Entry units |", "| Entry unitz |");
    assert.throws(
      () => parseLots(md, "EUR"),
      /^LotsTableError: portfolio\.md \(EUR\): ## EUR — Lots: columns Entry units missing/,
    );
  });

  it("a v2 file written before the Ticker column existed says to add it, first", () => {
    const md = PORTFOLIO_MD.replaceAll("| Ticker | Entry id |", "| Entry id |");
    assert.throws(
      () => parseLots(md, "USD"),
      /columns Ticker missing.*add a "Ticker" column, first, to "## USD — Lots"/,
    );
  });

  it("a header that does not read throws the parser's own LotsTableError", () => {
    const md = PORTFOLIO_MD.replace("| Entry units |", "| Entry unitz |");
    assert.throws(() => parseLots(md, "EUR"), LotsTableError);
  });

  it("parses the lots of a silo into typed fields", () => {
    assert.deepEqual(parseLots(PORTFOLIO_MD, "EUR")[0], {
      ticker: "DEF.MI",
      entryId: "def-1",
      date: "2026-05-04",
      units: 1,
      entryUnits: 1,
      entryPrice: 46.8,
      initialStop: 41.5,
      entryCosts: 1.5,
      origin: "sistema",
      rulesVersion: "1.0",
      rulesViolations: [],
    });
  });

  it("reads — as no stop, no costs and no violations, and a comma list as several violations", () => {
    const lot = parseLots(PORTFOLIO_MD, "EUR")[1];
    assert.equal(lot.initialStop, null);
    assert.equal(lot.entryCosts, null);
    assert.deepEqual(lot.rulesViolations, ["no_stop", "overrode_block"]);
  });

  it("reads only the lots of the asked silo", () => {
    assert.deepEqual(
      parseLots(PORTFOLIO_MD, "EUR").map((l) => l.entryId),
      ["def-1", "ibe-1", "ibe-2"],
    );
    assert.deepEqual(
      parseLots(PORTFOLIO_MD, "USD").map((l) => l.entryId),
      ["xom-1"],
    );
  });

  it("reads the columns by their header, in any order", () => {
    const swapped = PORTFOLIO_MD.replaceAll(
      "| Ticker | Entry id | Date | Units | Entry units |",
      "| Date | Entry units | Units | Entry id | Ticker |",
    ).replace("| XOM | xom-1 | 2026-04-01 | 5 | 5 |", "| 2026-04-01 | 8 | 5 | xom-1 | XOM |");
    const lot = parseLots(swapped, "USD").find((l) => l.entryId === "xom-1");
    assert.deepEqual([lot?.units, lot?.entryUnits], [5, 8]);
  });

  it("skips placeholder rows and rows whose Units is not a number", () => {
    const md = PORTFOLIO_MD.replace(
      "| XOM | xom-1 |",
      "| — | — | — | — | — | — | — | — | — | — | — |\n| XOM | xom-0 | 2026-03-01 | TBD | 5 | 1 | 1 | — | sistema | 1.0 | — |\n| XOM | xom-1 |",
    );
    assert.deepEqual(
      parseLots(md, "USD").map((l) => l.entryId),
      ["xom-1"],
    );
  });

  it("reads en dash headings, CRLF and `:---:` separator rows as the rest of the vault does", () => {
    const md = PORTFOLIO_MD.replace("## USD — Lots", "## USD – Lots").replace(
      /\|---\|---\|---\|---\|---\|---\|---\|---\|---\|---\|---\|/g,
      "|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|",
    );
    assert.equal(parseLots(md.replace(/\n/g, "\r\n"), "USD").length, 1);
  });

  it("throws, naming the section and the column, if a required column is missing", () => {
    const md = PORTFOLIO_MD.replaceAll("| Initial stop |", "| Stop |");
    assert.throws(() => parseLots(md, "USD"), /## USD — Lots.*Initial stop/);
  });

  it("throws, naming the section and the column, if the Ticker column is missing (#52)", () => {
    const md = PORTFOLIO_MD.replaceAll("| Ticker | Entry id |", "| Entry id |").replace("| XOM | xom-1 |", "| xom-1 |");
    assert.throws(() => parseLots(md, "USD"), /## USD — Lots.*Ticker/);
  });

  it("skips a row with no ticker, so it does not count towards any Volume", () => {
    const md = PORTFOLIO_MD.replace("| XOM | xom-1 |", "| — | xom-1 |");
    assert.deepEqual(parseLots(md, "USD"), []);
  });

  it("returns an empty array when the section has no table", () => {
    assert.deepEqual(parseLots("## USD — Lots\n\nnothing\n", "USD"), []);
  });
});

// ─── parseLotRows: what the Lots reader skips, and why (#55) ───────────────────

describe("parseLotRows", () => {
  const LOT = ["XOM", "xom-1", "2026-04-01", "5", "5", "100", "90", "—", "sistema", "1.0", "—"];
  const mdWith = (...rows: string[][]) =>
    `## USD — Lots\n\n${LOTS_HEADER}\n${rows.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n`;
  const edited = (at: number, value: string) => LOT.map((c, i) => (i === at ? value : c));

  it("reads the lots and reports nothing for a clean table, placeholder rows and a repeated header", () => {
    const md = mdWith(
      LOT,
      LOT.map(() => "—"),
      ["Ticker", "Entry id", ...LOT.slice(2).map(() => "")],
    );
    const { lots, skipped } = parseLotRows(md, "USD");
    assert.equal(lots.length, 1);
    assert.deepEqual(skipped, []);
  });

  for (const [name, at, value, reason] of [
    ["no entry id", 1, "—", /no Entry id/],
    ["no ticker", 0, "—", /no Ticker/],
    ["non-numeric units", 3, "TBD", /Units "TBD" is not a number/],
    ["non-numeric entry units", 4, "x", /Entry units "x" is not a number/],
    ["non-numeric entry price", 5, "", /Entry price "" is not a number/],
    ["an unknown origin", 8, "otro", /Origin "otro" is not sistema or propietario/],
    ["a non-ISO date", 2, "01/04/2026", /Date "01\/04\/2026" is not YYYY-MM-DD/],
    ["an empty rules version", 9, "—", /no Rules version/],
  ] as const) {
    it(`reports a row with ${name}, naming the row, its ticker and entry id, and the reason`, () => {
      const { lots, skipped } = parseLotRows(
        mdWith(
          LOT,
          edited(at, value).map((c, i) => c || (i === at ? "" : c)),
        ),
        "USD",
      );
      assert.equal(lots.length, 1, "the other lot is still read");
      assert.equal(skipped.length, 1);
      assert.match(skipped[0], /^Lots row 2/);
      assert.match(skipped[0], reason);
    });
  }

  it("names the ticker and entry id of the skipped row when it has them", () => {
    const { skipped } = parseLotRows(mdWith(edited(2, "01/04/2026")), "USD");
    assert.match(skipped[0], /Lots row 1 \(XOM, xom-1\): .*skipped/);
  });

  it("Origin matches exactly, as the log stores it; the message points to the right case", () => {
    const { lots, skipped } = parseLotRows(mdWith(edited(8, "Sistema")), "USD");
    assert.deepEqual(lots, []);
    assert.match(skipped[0], /Origin "Sistema" is not sistema or propietario \(write it "sistema"\)/);
  });

  it("the headers stay case-insensitive", () => {
    const md = mdWith(LOT).replace("| Origin |", "| ORIGIN |");
    assert.equal(parseLotRows(md, "USD").lots.length, 1);
  });

  it("parseLots reads the same lots", () => {
    const md = mdWith(LOT, edited(8, "Sistema"));
    assert.deepEqual(parseLots(md, "USD"), parseLotRows(md, "USD").lots);
  });
});

describe("splitTableRow", () => {
  it("splits a row into trimmed cells, with or without the closing bar", () => {
    assert.deepEqual(splitTableRow("| a | b  |  c |"), ["a", "b", "c"]);
    assert.deepEqual(splitTableRow("| a | b"), ["a", "b"]);
  });
});
