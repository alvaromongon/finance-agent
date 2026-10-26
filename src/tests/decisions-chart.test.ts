/**
 * Tests of the SLI 1 chart: the series is derived from the evaluations (no
 * second computation of plan R), and the SVG shows only R and counts. Fixtures,
 * no network or vault.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDecision, type Decision, type DecisionType } from "../decisions.js";
import type { DecisionEvaluation } from "../utils/decisions-evaluation.js";
import { buildProposalSeries, renderProposalQualitySvg } from "../utils/decisions-chart.js";
import { en } from "../i18n/en.js";
import { es } from "../i18n/es.js";
import { parseTicker as tk } from "../ticker.js";

interface ProposalFixture {
  date: string;
  /** Plan R; null = the window is still open. */
  resultR: number | null;
  /** 60-session benchmark return in %, if the window is complete. */
  benchmarkPct?: number;
  type?: DecisionType;
}

/** An evaluation with entry 100 and stop 90: 1R is 10% of the price. */
function evaluation({ date, resultR, benchmarkPct, type = "buy_proposal" }: ProposalFixture): DecisionEvaluation {
  const decision = buildDecision({
    date,
    ticker: tk("AAA"),
    currency: "USD",
    origin: "sistema",
    source: "monday-briefing",
    type,
    price: 100,
    ...(type === "buy_proposal" ? { assumptions: ["The trend holds"] } : {}),
    rules_version: "1.0",
  }) as Decision & { ticker: string };
  const assetPct = 12;
  const horizon60 =
    benchmarkPct == null
      ? { ret: null, excess: null }
      : {
          ret: {
            baseDate: date,
            baseClose: 100,
            endDate: date,
            endClose: 112,
            sessions: 60,
            pct: assetPct,
            partial: false,
          },
          excess: assetPct - benchmarkPct,
        };
  return {
    decision,
    reference: "VOO",
    base: null,
    horizons: { 20: { ret: null, excess: null }, 60: horizon60 },
    plan: { entry: 100, stop: 90, target: 120, inferred: false },
    excursion: {
      mfeR: 0,
      maeR: 0,
      first: null,
      targetAfterStop: false,
      resultR,
      sessions: 60,
    },
  };
}

const many = (count: number, make: (i: number) => ProposalFixture) =>
  Array.from({ length: count }, (_, i) => evaluation(make(i)));

const day = (i: number) =>
  `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`;

describe("buildProposalSeries", () => {
  it("counts only buy proposals with a plan R, in date order, cumulatively", () => {
    const series = buildProposalSeries([
      evaluation({ date: "2026-03-10", resultR: 2 }),
      evaluation({ date: "2026-03-01", resultR: -1 }),
      evaluation({ date: "2026-03-05", resultR: null }),
      evaluation({ date: "2026-03-06", resultR: 5, type: "screen_interesting" }),
    ]);
    assert.deepEqual(
      series.points.map((p) => [p.date, p.n, p.meanR]),
      [
        ["2026-03-01", 1, -1],
        ["2026-03-10", 2, 0.5],
      ],
    );
    assert.equal(series.n, 2);
    assert.equal(series.meanR, 0.5);
  });

  it("expresses the benchmark in the proposal's own R: its return over the stop distance", () => {
    const series = buildProposalSeries([
      evaluation({ date: "2026-03-01", resultR: 2, benchmarkPct: 10 }),
      evaluation({ date: "2026-03-02", resultR: 0, benchmarkPct: -5 }),
    ]);
    assert.deepEqual(
      series.points.map((p) => p.benchmarkR),
      [1, 0.25],
    );
    assert.equal(series.benchmarkR, 0.25);
  });

  it("leaves the benchmark out where its 60-session window is not complete", () => {
    const series = buildProposalSeries([
      evaluation({ date: "2026-03-01", resultR: 2 }),
      evaluation({ date: "2026-03-02", resultR: 1, benchmarkPct: 10 }),
    ]);
    assert.deepEqual(
      series.points.map((p) => p.benchmarkR),
      [null, 1],
    );
  });

  it("is insufficient below 30 evaluated proposals and sufficient from 30", () => {
    assert.equal(buildProposalSeries(many(29, (i) => ({ date: day(i), resultR: 1 }))).sufficient, false);
    assert.equal(buildProposalSeries(many(30, (i) => ({ date: day(i), resultR: 1 }))).sufficient, true);
  });

  it("an empty log gives an empty series", () => {
    const series = buildProposalSeries([]);
    assert.deepEqual(series.points, []);
    assert.equal(series.n, 0);
    assert.equal(series.meanR, null);
  });
});

describe("renderProposalQualitySvg", () => {
  const below = buildProposalSeries(
    many(12, (i) => ({ date: day(i), resultR: i % 3 === 0 ? -1 : 2, benchmarkPct: 3 })),
  );
  const above = buildProposalSeries(
    many(34, (i) => ({ date: day(i), resultR: i % 3 === 0 ? -1 : 2, benchmarkPct: 3 })),
  );

  it("below 30 it says insufficient data, not a verdict, and marks the n = 30 line", () => {
    const svg = renderProposalQualitySvg(below, en);
    assert.match(svg, /^<svg /);
    assert.match(svg, /insufficient data/i);
    assert.match(svg, /n = 30/);
    assert.doesNotMatch(svg, /pass|fail|inconclusive/i);
  });

  it("from 30 it no longer says insufficient data, and says the bound is still pending", () => {
    const svg = renderProposalQualitySvg(above, en);
    assert.doesNotMatch(svg, /insufficient data/i);
    assert.match(svg, /confidence bound/i);
  });

  it("carries the not-financial-advice notice", () => {
    assert.match(renderProposalQualitySvg(below, en), /Not financial advice/);
    assert.match(renderProposalQualitySvg(below, es), /No es asesoramiento financiero/);
  });

  it("shows only R and counts: no currency, no money", () => {
    const svg = renderProposalQualitySvg(above, en);
    assert.doesNotMatch(svg, /[€$]|EUR|USD|silo/);
    assert.match(svg, /\d\.\d\dR/);
  });

  it("is readable in light and dark themes", () => {
    const svg = renderProposalQualitySvg(below, en);
    assert.match(svg, /prefers-color-scheme: dark/);
    assert.match(svg, /<rect class="bg"/);
  });

  it("is self-contained and accessible: no external references, a title and a description", () => {
    const svg = renderProposalQualitySvg(above, en);
    assert.doesNotMatch(svg, /href=|<image|<script|url\(http/);
    assert.match(svg, /<title>/);
    assert.match(svg, /<desc>/);
  });

  it("an empty log renders the notice without NaN", () => {
    const svg = renderProposalQualitySvg(buildProposalSeries([]), en);
    assert.match(svg, /insufficient data/i);
    assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
  });

  it("a single point and a flat series render without NaN", () => {
    const single = renderProposalQualitySvg(
      buildProposalSeries(many(1, () => ({ date: "2026-03-01", resultR: 0 }))),
      en,
    );
    assert.doesNotMatch(single, /NaN|undefined|Infinity/);
    const sameDay = renderProposalQualitySvg(
      buildProposalSeries(many(3, () => ({ date: "2026-03-01", resultR: 1 }))),
      en,
    );
    assert.doesNotMatch(sameDay, /NaN|undefined|Infinity/);
  });

  it("is in Spanish when asked", () => {
    assert.match(renderProposalQualitySvg(below, es), /datos insuficientes/i);
  });
});
