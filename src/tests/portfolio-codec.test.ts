/**
 * The codec of `portfolio.md` (#67): the model keeps every line, so parsing and serializing without
 * edits is byte-identical, and a table split by blank lines or notes is one table for the readers and
 * the writers alike.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  hasSection,
  mapTableRows,
  parsePortfolio,
  readTable,
  sectionBody,
  sectionRange,
  serializePortfolio,
  setTableRows,
} from "../utils/portfolio-codec.js";

const EXAMPLE = readFileSync(new URL("../../examples/brain/portfolio.md", import.meta.url), "utf8");

const HEADER = ["Ticker", "Volume", "Avg price", "Current price", "P/L", "Stop loss"];

const VARIANTS: Record<string, string> = {
  "the example brain": EXAMPLE,
  "blank lines and notes inside and around the tables": [
    "---",
    "schema_version: 2",
    "---",
    "",
    "Intro note.",
    "",
    "## EUR — Cash",
    "",
    "| Item | Value |",
    "|---|---|",
    "",
    "| Available cash | 1.200,00 € |",
    "A note between two rows.",
    "| Total cash | 1.572,80 € |",
    "",
    "",
    "## EUR — Positions",
    "| Ticker | Volume | Avg price | Current price | P/L | Stop loss |",
    "",
    "|:---:|:---|---:|---|---|---|",
    "| SAP.DE | 2 | 180,00 | 186,40 | 12,80 | 168,00 |",
    "",
    "",
  ].join("\n"),
  "--- rules, :---: separators and aligned rows": [
    "## USD — Cash",
    "",
    "| Item           | Value   |",
    "| :------------: | ------: |",
    "| Available cash | $900.00 |",
    "",
    "---",
    "",
    "## USD — Positions",
    "",
    "| Ticker | Volume |",
    "|:---:|:---:|",
    "| KO     | 5      |",
    "",
  ].join("\n"),
  CRLF: EXAMPLE.replace(/\n/g, "\r\n"),
  "mixed line ends and a lone CR": "## EUR — Cash\r\n\r\n| a | b |\n|---|---|\r| 1 | 2 |\n",
  "en dash and hyphen headings": "## EUR – Cash\n\n| a |\n|---|\n| 1 |\n\n## USD - Positions\n\n| a |\n|---|\n| 2 |\n",
  "no final line end": "## EUR — Cash\n\n| a |\n|---|\n| 1 |",
  "a BOM and trailing spaces": "﻿## EUR — Cash  \n\n| a |  \n|---|\n| 1 |   \n",
  "an empty file": "",
  "only line ends": "\n\n\r\n",
};

describe("portfolio codec: parse then serialize without edits is byte-identical", () => {
  for (const [name, text] of Object.entries(VARIANTS)) {
    it(name, () => {
      assert.equal(serializePortfolio(parsePortfolio(text)), text);
    });
  }

  it("keeps every line with its own line end", () => {
    const model = parsePortfolio("a\r\nb\nc\rd");
    assert.deepEqual(model.lines, [
      { text: "a", eol: "\r\n" },
      { text: "b", eol: "\n" },
      { text: "c", eol: "\r" },
      { text: "d", eol: "" },
    ]);
  });
});

describe("portfolio codec: one table per section, however it is split", () => {
  const SPLIT = [
    "## EUR — Positions",
    "",
    "| Ticker | Volume | Avg price | Current price | P/L | Stop loss |",
    "",
    "|---|---|---|---|---|---|",
    "| A | 1 | 10 | 10 | 0 | — |",
    "",
    "Note between the rows.",
    "| B | 2 | 20 | 20 | 0 | — |",
    "",
    "## EUR — Lots",
    "",
  ].join("\n");

  it("the reader sees one header and every row", () => {
    assert.deepEqual(readTable(parsePortfolio(SPLIT), "EUR", "Positions"), {
      header: HEADER,
      rows: [
        ["A", "1", "10", "10", "0", "—"],
        ["B", "2", "20", "20", "0", "—"],
      ],
    });
  });

  it("the writer leaves one contiguous block, with the note under it and the blank lines of the table gone", () => {
    const edited = setTableRows(parsePortfolio(SPLIT), "EUR", "Positions", HEADER, (_, rows) => [
      ...rows,
      ["C", "3", "30", "30", "0", "—"],
    ])!;
    assert.equal(
      serializePortfolio(edited),
      [
        "## EUR — Positions",
        "",
        "| Ticker | Volume | Avg price | Current price | P/L | Stop loss |",
        "|---|---|---|---|---|---|",
        "| A | 1 | 10 | 10 | 0 | — |",
        "| B | 2 | 20 | 20 | 0 | — |",
        "| C | 3 | 30 | 30 | 0 | — |",
        "Note between the rows.",
        "",
        "## EUR — Lots",
        "",
      ].join("\n"),
    );
  });

  it("edit then parse returns exactly the edited model", () => {
    const edited = setTableRows(parsePortfolio(SPLIT), "EUR", "Positions", HEADER, (_, rows) => rows.slice(1))!;
    assert.deepEqual(parsePortfolio(serializePortfolio(edited)), edited);
    const priced = mapTableRows(edited, "EUR", "Positions", (cells) => [
      ...cells.slice(0, 3),
      "99",
      ...cells.slice(4),
    ])!;
    assert.notEqual(priced, edited);
    assert.deepEqual(parsePortfolio(serializePortfolio(priced)), priced);
  });

  it("the writer keeps the file's line ends, CRLF included", () => {
    const crlf = SPLIT.replace(/\n/g, "\r\n");
    const edited = setTableRows(parsePortfolio(crlf), "EUR", "Positions", HEADER, (_, rows) => rows)!;
    assert.ok(!/[^\r]\n/.test(serializePortfolio(edited)), "no bare LF");
  });

  it("a section with no table gets one, a blank line before what follows; a missing section is null", () => {
    const md = "## EUR — Positions\n\n## EUR — Lots\n";
    const edited = setTableRows(parsePortfolio(md), "EUR", "Positions", HEADER, () => [
      ["A", "1", "1", "1", "0", "—"],
    ])!;
    assert.equal(
      serializePortfolio(edited),
      "## EUR — Positions\n\n| Ticker | Volume | Avg price | Current price | P/L | Stop loss |\n| --- | --- | --- | --- | --- | --- |\n| A | 1 | 1 | 1 | 0 | — |\n\n## EUR — Lots\n",
    );
    assert.equal(
      setTableRows(parsePortfolio(md), "USD", "Positions", HEADER, () => []),
      null,
    );
    assert.equal(
      mapTableRows(parsePortfolio(md), "USD", "Positions", () => null),
      null,
    );
  });

  it("a table at the end of a file with no final line end stays without one", () => {
    const md = "## EUR — Cash\n\n| a |\n|---|\n| 1 |";
    const edited = setTableRows(parsePortfolio(md), "EUR", "Cash", ["a"], (_, rows) => [...rows, ["2"]])!;
    assert.equal(serializePortfolio(edited), "## EUR — Cash\n\n| a |\n|---|\n| 1 |\n| 2 |");
  });

  it("mapTableRows rewrites only the rows it is given cells for, header and separators excepted, and returns the model itself when nothing changed", () => {
    const model = parsePortfolio(SPLIT);
    assert.equal(
      mapTableRows(model, "EUR", "Positions", () => null),
      model,
    );
    assert.equal(
      mapTableRows(model, "EUR", "Positions", (cells) => cells),
      model,
      "the same cells written back are no change",
    );
    const out = serializePortfolio(
      mapTableRows(model, "EUR", "Positions", (cells) => (cells[0] === "B" ? ["B", "2", "20", "21", "2", "—"] : null))!,
    );
    assert.equal(out, SPLIT.replace("| B | 2 | 20 | 20 | 0 | — |", "| B | 2 | 20 | 21 | 2 | — |"));
  });
});

describe("portfolio codec: sections", () => {
  const md = "x\n## EUR — Cash\n\n| a |\n|---|\n| 1 |\n---\n## EUR - Positions extra\nbody\n### sub\n## USD – Cash\n";

  it("a section ends at the next ## heading or --- rule; the heading takes any dash", () => {
    assert.equal(sectionBody(md, "EUR", "Cash"), "\n\n| a |\n|---|\n| 1 |\n");
    assert.equal(sectionBody(md, "EUR", "Positions"), "\nbody\n### sub\n");
    assert.equal(sectionBody(md, "USD", "Cash"), "\n");
    assert.equal(sectionBody(md, "USD", "Lots"), "");
    assert.ok(hasSection(parsePortfolio(md), "EUR", "Positions"));
    assert.ok(!hasSection(parsePortfolio(md), "USD", "Positions"));
  });

  it("sectionRange gives character offsets from the end of the heading to the next boundary", () => {
    const range = sectionRange(md, "EUR", "Cash")!;
    assert.equal(md.slice(0, range.start), "x\n## EUR — Cash");
    assert.equal(md.slice(range.start, range.end), sectionBody(md, "EUR", "Cash"));
    assert.equal(sectionRange(md, "USD", "Lots"), null);
  });
});
