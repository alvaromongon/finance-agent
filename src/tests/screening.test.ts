import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseScreeningLog, extractRetireList, extractPlanSummary } from "../utils/vault-parser.js";

// ── parseScreeningLog ─────────────────────────────────────────────────────────

const SCREENING_LOG_MD = `---
schema_version: 1
title: Screening Log
---

## Historial

| Ticker | Name | Index | Date | Result | Summary | Next review |
|---|---|---|---|---|---|---|
| AAPL | Apple | S&P 500 | 2026-06-28 | not_interesting | High P/E | 2026-08-28 |
| ASML.AS | ASML | Eurostoxx 50 | 2026-06-28 | interesting | Semicond IA | — |
| MSFT | Microsoft | S&P 500 | 2026-06-21 | not_interesting | Sin catalizador | 2026-08-21 |
`;

describe("parseScreeningLog", () => {
  it("parses the data rows correctly", () => {
    const rows = parseScreeningLog(SCREENING_LOG_MD);
    assert.equal(rows.length, 3);
  });

  it("rejects a screening-log without schema_version", () => {
    assert.throws(
      () => parseScreeningLog(SCREENING_LOG_MD.replace("schema_version: 1\n", "")),
      /screening-log\.md.*schema_version/,
    );
  });

  it("rejects an unknown Result, naming the row", () => {
    const md = SCREENING_LOG_MD.replace(
      "| 2026-06-28 | not_interesting | High P/E |",
      "| 2026-06-28 | No interesante | High P/E |",
    );
    assert.throws(
      () => parseScreeningLog(md),
      /screening-log\.md: unknown Result "No interesante" in row AAPL of 2026-06-28/,
    );
  });

  it("does not include the header row", () => {
    const rows = parseScreeningLog(SCREENING_LOG_MD);
    assert.ok(rows.every((r) => r.ticker !== "Ticker"));
  });

  it("maps the fields correctly", () => {
    const rows = parseScreeningLog(SCREENING_LOG_MD);
    const aapl = rows[0];
    assert.equal(aapl.ticker, "AAPL");
    assert.equal(aapl.name, "Apple");
    assert.equal(aapl.index, "S&P 500");
    assert.equal(aapl.date, "2026-06-28");
    assert.equal(aapl.result, "not_interesting");
    assert.equal(aapl.summary, "High P/E");
    assert.equal(aapl.nextReview, "2026-08-28");
  });

  it("parses the 'interesting' result correctly", () => {
    const rows = parseScreeningLog(SCREENING_LOG_MD);
    const asml = rows[1];
    assert.equal(asml.result, "interesting");
    assert.equal(asml.nextReview, "—");
  });

  it("returns an empty array for markdown without a table", () => {
    const rows = parseScreeningLog("---\nschema_version: 1\n---\n# Sin tabla\n\nTexto normal.");
    assert.equal(rows.length, 0);
  });

  it("rejects an empty string: it lacks schema_version", () => {
    assert.throws(() => parseScreeningLog(""), /schema_version/);
  });
});

// ── extractRetireList ─────────────────────────────────────────────────────────

describe("extractRetireList", () => {
  it("extracts tickers from the AUTOMATED_ACTIONS section", () => {
    const text = `## Resumen\n\nAlgún texto.\n\n## AUTOMATED_ACTIONS\nRETIRE: IBE.MC,SAN.MC`;
    const result = extractRetireList(text);
    assert.deepEqual(result, ["IBE.MC", "SAN.MC"]);
  });

  it("returns an empty array if RETIRE is empty", () => {
    const text = `## AUTOMATED_ACTIONS\nRETIRE:`;
    assert.deepEqual(extractRetireList(text), []);
  });

  it("an empty RETIRE: does not swallow the next line (regression)", () => {
    const text = `## AUTOMATED_ACTIONS\nRETIRE:\nPLAN_SUMMARY: Acumular cash, sin compras\nPROPOSALS: []`;
    assert.deepEqual(extractRetireList(text), []);
  });

  it("returns an empty array if there is no AUTOMATED_ACTIONS section", () => {
    assert.deepEqual(extractRetireList("## Resumen\n\nSin acciones."), []);
  });

  it("trims spaces around each ticker", () => {
    const text = `## AUTOMATED_ACTIONS\nRETIRE:  XOM , VST `;
    const result = extractRetireList(text);
    assert.deepEqual(result, ["XOM", "VST"]);
  });

  it("returns a single ticker without a comma", () => {
    const text = `## AUTOMATED_ACTIONS\nRETIRE: IBE.MC`;
    assert.deepEqual(extractRetireList(text), ["IBE.MC"]);
  });
});

// ── extractPlanSummary ────────────────────────────────────────────────────────

describe("extractPlanSummary", () => {
  it("extracts the plan summary from the AUTOMATED_ACTIONS section", () => {
    const text = `## AUTOMATED_ACTIONS\nRETIRE:\nPLAN_SUMMARY: Acumular cash esta semana`;
    assert.equal(extractPlanSummary(text), "Acumular cash esta semana");
  });

  it("trims spaces", () => {
    const text = `PLAN_SUMMARY:   Comprar XOM por 40 €  `;
    assert.equal(extractPlanSummary(text), "Comprar XOM por 40 €");
  });

  it("returns an empty string if there is no PLAN_SUMMARY", () => {
    assert.equal(extractPlanSummary("## Resumen\n\nSin acciones."), "");
  });
});
