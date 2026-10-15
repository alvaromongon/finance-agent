// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  benchmarkFor,
  cohortOf,
  discardReason,
  evaluateRows,
  groupStats,
  symbolsToFetch,
  type EvaluatedRow,
} from "../utils/screening-outcomes-helpers.js";
import { loadClosedBars } from "../utils/forward-returns.js";
import { renderScreeningOutcomes } from "../utils/screening-outcomes-render.js";
import { parseScreeningLog } from "../utils/vault-parser.js";
import type { HistoricalBar } from "../providers/types.js";
import { closes, weekdayBars } from "./fixtures/weekday-bars.js";
import { en } from "../i18n/en.js";
import { SPANISH } from "./fixtures/spanish.js";

// ─── cohortOf / benchmarkFor ─────────────────────────────────────────────────

describe("cohortOf", () => {
  it("splits the cohorts at the DD-0010 and ADR-0012 dates (inclusive towards the new one)", () => {
    assert.equal(cohortOf("2026-08-01"), "pre", "last screening with the old criterion");
    assert.equal(cohortOf("2026-08-02"), "pre");
    assert.equal(cohortOf("2026-08-03"), "post");
    assert.equal(cohortOf("2026-08-08"), "post", "first screening with filter 0");
    assert.equal(cohortOf("2026-09-12"), "post", "last screening by draw");
    assert.equal(cohortOf("2026-09-17"), "ranking");
    assert.equal(cohortOf("2026-09-19"), "ranking", "first screening with the ranking");
  });
});

describe("benchmarkFor", () => {
  it("assigns each block's index and leaves commodities without a benchmark", () => {
    assert.equal(benchmarkFor("S&P 500"), "SPY");
    assert.equal(benchmarkFor("Eurostoxx 50"), "^STOXX50E");
    assert.equal(benchmarkFor("Commodities"), null);
  });
});

// ─── discardReason ───────────────────────────────────────────────────────────

describe("discardReason", () => {
  // Real summaries from screening-log.md (truncated to 80 characters).
  const cases: [string, string][] = [
    ["No supera el filtro 0: precio (70.32) por debajo de la SMA200 (71.18), con sesgo", "No supera el filtro 0"],
    ["Supera el filtro 0 al límite (precio 204.76 apenas un 0.6% por encima de la SMA2", "Filtro 0 al límite"],
    ["Filtro 0 al límite: precio (61,98) apenas por encima de la SMA200 (61,72) pero t", "Filtro 0 al límite"],
    [
      "Supera el filtro 0 (ALCISTA, precio 74.09 por encima de SMA200 67.10, estructura",
      "Supera el filtro 0, no los criterios",
    ],
    [
      "Thales comparte el mismo driver principal que Example Defence (DEF.MI), ya en watchlist",
      "Driver ya cubierto en watchlist",
    ],
    [
      "Duplicado directo del driver que ya cubre Lowe's en la watchlist: mismo sector (",
      "Driver ya cubierto en watchlist",
    ],
    [
      "Histórico técnico insuficiente (solo 9 sesiones): sin SMA50/SMA200, sin ATR, sin",
      "Datos insuficientes o dudosos",
    ],
    [
      "El precio actual de $979.30 es incompatible con el historial conocido de Micron ",
      "Datos insuficientes o dudosos",
    ],
    ["Tendencia bajista confirmada (precio por debajo de SMA50 y SMA200), cotizando pr", "Tendencia bajista"],
    [
      "El activo cotiza al 98% de su rango de 52 semanas (precio €81.96 frente a máximo",
      "Cerca de máximos (criterio previo)",
    ],
    [
      "Bank of America cotiza a solo -1.4% de máximos de 52 semanas (95.1% del rango an",
      "Cerca de máximos (criterio previo)",
    ],
    [
      "Solo a un 8.7% de máximos de 52 semanas, cotizando prácticamente en línea con SM",
      "Cerca de máximos (criterio previo)",
    ],
    [
      "Caterpillar solo ha retrocedido un 18% desde máximos y sigue un 22% por encima d",
      "Cerca de máximos (criterio previo)",
    ],
    [
      "NVDA cumple solo 2 de los 5 criterios: posición en rango aceptable (47.3%, bajo ",
      "No suma criterios suficientes",
    ],
    [
      "PG cumple la posición en rango (46.5%, bien alejado de máximos) y tiene soporte ",
      "No suma criterios suficientes",
    ],
    ["A pesar de noticias positivas (dividendo, revisión al alza de objetivos de anali", "Otro (ver resumen)"],
  ];

  for (const [summary, expected] of cases) {
    it(`${expected} ← "${summary.slice(0, 40)}…"`, () => {
      assert.equal(discardReason(summary), expected);
    });
  }

  it("a low range position does not count as near highs", () => {
    assert.equal(
      discardReason("EL.PA cotiza un 46.8% por debajo de sus máximos de 52 semanas con una tendencia "),
      "Otro (ver resumen)",
    );
  });

  // Recent summaries use a decimal comma: without normalizing it, Number("91,3")
  // is NaN and the 70% threshold would never be evaluated.
  it("reads the range position with a decimal comma", () => {
    assert.equal(
      discardReason("Cotiza al 91,3% de su rango anual sin catalizador que lo sostenga"),
      "Cerca de máximos (criterio previo)",
    );
    assert.equal(
      discardReason("Cotiza al 45,2% de su rango anual sin catalizador que lo sostenga"),
      "Otro (ver resumen)",
    );
  });
});

// ─── evaluateRows ────────────────────────────────────────────────────────────

const LOG_MD = `---
schema_version: 1
---
| Ticker | Name | Index | Date | Result | Summary | Next review |
|---|---|---|---|---|---|---|
| AAA | Aaa | S&P 500 | 2026-07-04 | interesting | Cumple ≥3 criterios | — |
| BBB.PA | Bbb | Eurostoxx 50 | 2026-08-08 | not_interesting | No supera el filtro 0: precio bajo SMA200 | 2026-10-08 |
| PHAG.AS | Plata | Commodities | 2026-07-04 | not_interesting | La plata cotiza en zona media-baja | 2026-09-04 |
| AAA | Aaa | S&P 500 | 2026-08-08 | not_interesting | Supera el filtro 0 pero sin catalizador | 2026-10-08 |
| NODATA | Sin datos | S&P 500 | 2026-07-04 | not_interesting | Tendencia bajista | 2026-09-04 |
| CCC | Ccc | S&P 500 | fecha-rota | interesting | Fila corrupta | — |
`;

// 2026-06-01 (Monday) + 60 sessions reaches late August.
const BARS = new Map<string, HistoricalBar[]>([
  [
    "AAA",
    weekdayBars(
      "2026-06-01",
      closes(60, (i) => 100 + i),
    ),
  ],
  [
    "BBB.PA",
    weekdayBars(
      "2026-06-01",
      closes(60, () => 50),
    ),
  ],
  [
    "PHAG.AS",
    weekdayBars(
      "2026-06-01",
      closes(60, (i) => 30 + i / 10),
    ),
  ],
  [
    "SPY",
    weekdayBars(
      "2026-06-01",
      closes(60, () => 500),
    ),
  ],
  [
    "^STOXX50E",
    weekdayBars(
      "2026-06-01",
      closes(60, (i) => 5000 + 10 * i),
    ),
  ],
]);

describe("evaluateRows", () => {
  const evals = evaluateRows(parseScreeningLog(LOG_MD), BARS, [5, 60]);
  const find = (ticker: string, date: string) => evals.find((e) => e.row.ticker === ticker && e.row.date === date)!;

  it("drops rows with an invalid date instead of measuring them wrong", () => {
    assert.equal(evals.length, 5);
    assert.equal(
      evals.some((e) => e.row.ticker === "CCC"),
      false,
    );
  });

  it("assigns cohort, index and base close (the Friday before the screening Saturday)", () => {
    const aaa = find("AAA", "2026-07-04");
    assert.equal(aaa.cohort, "pre");
    assert.equal(aaa.benchmark, "SPY");
    assert.equal(aaa.base?.date, "2026-07-03");
    assert.equal(find("BBB.PA", "2026-08-08").cohort, "post");
  });

  it("excess over the block index: with a flat index it equals the return", () => {
    const h5 = find("AAA", "2026-07-04").horizons[5];
    assert.ok(h5.ret && !h5.ret.partial);
    assert.equal(h5.excess, h5.ret.pct);
  });

  it("negative excess if the security does not move and the index rises", () => {
    const h5 = find("BBB.PA", "2026-08-08").horizons[5];
    assert.ok(h5.ret && h5.excess != null);
    assert.equal(h5.ret.pct, 0);
    assert.ok(h5.excess < 0);
  });

  it("marks as partial the horizon the series does not cover yet", () => {
    const h60 = find("AAA", "2026-07-04").horizons[60];
    assert.equal(h60.ret?.partial, true);
  });

  it("commodities: return yes, excess no", () => {
    const h5 = find("PHAG.AS", "2026-07-04").horizons[5];
    assert.ok(h5.ret);
    assert.equal(h5.excess, null);
  });

  it("ticker without history: no base close or returns", () => {
    const nodata = find("NODATA", "2026-07-04");
    assert.equal(nodata.base, null);
    assert.equal(nodata.horizons[5].ret, null);
  });

  it("reason only on rejections, and marks tickers evaluated more than once", () => {
    assert.equal(find("AAA", "2026-07-04").reason, null);
    assert.equal(find("BBB.PA", "2026-08-08").reason, "No supera el filtro 0");
    assert.equal(find("AAA", "2026-07-04").repeated, true);
    assert.equal(find("AAA", "2026-08-08").repeated, true);
    assert.equal(find("BBB.PA", "2026-08-08").repeated, false);
  });
});

// ─── groupStats ──────────────────────────────────────────────────────────────

/** Minimal evaluation for aggregates: `pct` null = pending, `base: false` = no data. */
function fakeEval(opts: {
  pct?: number | null;
  partial?: boolean;
  excess?: number | null;
  base?: boolean;
}): EvaluatedRow {
  const base = opts.base === false ? null : { date: "2026-07-03", close: 100, high: 100, low: 100 };
  const ret =
    opts.pct == null || !base
      ? null
      : {
          baseDate: "2026-07-03",
          baseClose: 100,
          endDate: "2026-07-31",
          endClose: 100 + opts.pct,
          sessions: 20,
          pct: opts.pct,
          partial: opts.partial ?? false,
        };
  return {
    row: {
      ticker: "X",
      name: "X",
      index: "S&P 500",
      date: "2026-07-04",
      result: "interesting",
      summary: "",
      nextReview: "—",
    },
    cohort: "pre",
    benchmark: "SPY",
    base,
    horizons: { 20: { ret, excess: ret ? (opts.excess ?? null) : null } },
    reason: null,
    repeated: false,
  };
}

describe("groupStats", () => {
  it("mean, median and excess only over completed horizons", () => {
    const s = groupStats(
      [
        fakeEval({ pct: 10, excess: 4 }),
        fakeEval({ pct: -2, excess: -5 }),
        fakeEval({ pct: 4, excess: 1 }),
        fakeEval({ pct: 50, partial: true, excess: 40 }), // parcial: no entra
        fakeEval({ pct: null }), // pendiente
        fakeEval({ base: false }), // no data
      ],
      20,
    );
    assert.equal(s.total, 6);
    assert.equal(s.complete, 3);
    assert.equal(s.pending, 2, "partial + no later sessions");
    assert.equal(s.missing, 1);
    assert.equal(s.mean, 4);
    assert.equal(s.median, 4);
    assert.equal(s.meanExcess, 0);
    assert.equal(s.beats, 2);
    assert.equal(s.withBenchmark, 3);
  });

  it("median with an even number of samples", () => {
    const s = groupStats(
      [fakeEval({ pct: 1 }), fakeEval({ pct: 3 }), fakeEval({ pct: 10 }), fakeEval({ pct: 20 })],
      20,
    );
    assert.equal(s.median, 6.5);
  });

  it("complete ones without a benchmark do not count in «beats the index»", () => {
    const s = groupStats([fakeEval({ pct: 5, excess: null }), fakeEval({ pct: 5, excess: 2 })], 20);
    assert.equal(s.complete, 2);
    assert.equal(s.withBenchmark, 1);
    assert.equal(s.meanExcess, 2);
  });

  it("group without complete ones: null aggregates, not zeros", () => {
    const s = groupStats([fakeEval({ pct: 3, partial: true })], 20);
    assert.equal(s.mean, null);
    assert.equal(s.median, null);
    assert.equal(s.meanExcess, null);
  });
});

// ─── symbolsToFetch / loadClosedBars ─────────────────────────────────────────

describe("symbolsToFetch", () => {
  it("each evaluable ticker once, plus each block's index (commodities adds no index)", () => {
    assert.deepEqual(symbolsToFetch(parseScreeningLog(LOG_MD)), [
      "AAA",
      "BBB.PA",
      "PHAG.AS",
      "NODATA",
      "SPY",
      "^STOXX50E",
    ]);
  });
});

describe("loadClosedBars", () => {
  it("requests each symbol with its range, drops the not-yet-closed bar and skips the failing one", async () => {
    const calls: [string, string | undefined][] = [];
    const source = {
      getHistorical: async (symbol: string, range?: string) => {
        calls.push([symbol, range]);
        if (symbol === "BROKEN") throw new Error("HTTP 404");
        return weekdayBars("2026-09-09", [10, 11, 12]); // Wed 09-09, Thu 09-10, Fri 09-11
      },
    };

    const warn = mock.method(console, "warn", () => {});
    try {
      // Friday 15:00 UTC: the 09-11 bar is intraday.
      const bars = await loadClosedBars(source, ["AAA", "BROKEN", "SPY"], "1y", new Date("2026-09-11T15:00:00Z"));

      assert.deepEqual(calls, [
        ["AAA", "1y"],
        ["BROKEN", "1y"],
        ["SPY", "1y"],
      ]);
      assert.equal(bars.has("BROKEN"), false, "the failing symbol does not abort the download");
      assert.equal(bars.get("AAA")?.at(-1)?.date, "2026-09-10");
      assert.equal(bars.get("SPY")?.length, 2);
      assert.equal(warn.mock.callCount(), 1, "the failure is warned about");
    } finally {
      warn.mock.restore();
    }
  });
});

// ─── renderScreeningOutcomes ─────────────────────────────────────────────────

describe("renderScreeningOutcomes", () => {
  const evals = evaluateRows(parseScreeningLog(LOG_MD), BARS, [5, 60]);
  const md = renderScreeningOutcomes(evals, "2026-09-12", [5, 60]);

  it("in English", () => {
    const english = renderScreeningOutcomes(
      evaluateRows(parseScreeningLog(LOG_MD), BARS, [5, 60], en),
      "2026-09-12",
      [5, 60],
      en,
    );
    assert.match(english, /## Summary at 5 sessions/);
    assert.match(english, /\| Before DD-0010 \| Interesting \|/);
    assert.match(english, /## Rejections by reason/);
    assert.match(english, /Return at 5 and 60 sessions/);
    assert.doesNotMatch(english, SPANISH);
  });

  it("one summary table per horizon, with the cohorts split", () => {
    assert.match(md, /## Resumen a 5 sesiones/);
    assert.match(md, /## Resumen a 60 sesiones/);
    assert.match(md, /\| Antes de DD-0010 \| Interesante \|/);
    assert.match(md, /\| DD-0010 a ADR-0012 \| No interesante \|/);
  });

  it("warns about a small sample, and that no long horizon has completed", () => {
    assert.match(md, /\[!warning\] Muestra pequeña/);
    assert.match(md, /Ninguna evaluación ha cumplido todavía 60 sesiones/);
  });

  // «No interesante» is what the filter rejected: presenting it as chance
  // would skew precisely the comparison the report exists to make.
  it("only «Todos (sorteo)» is presented as the chance baseline, and it warns about the dependence between rows", () => {
    assert.match(md, /Referencia de elegir al azar: solo «Todos \(sorteo\)»/);
    assert.match(md, /«No interesante» no es aleatorio/);
    assert.match(md, /Observaciones no independientes/);
  });

  it("the detail tells partial, no data and repeated apart", () => {
    assert.match(md, /\| 2026-07-04 \| AAA † \|/);
    assert.match(md, /\| NODATA \| S&P 500 \| No interesante \| Tendencia bajista \| sin datos \| sin datos \|/);
    assert.match(md, /\*[+-]\d+\.\d% \(\d+s\)\*/, "incomplete horizons go in italics with the sessions");
    assert.match(md, /Sin histórico utilizable en Yahoo: NODATA/);
  });

  it("since ADR-0012 the all-rows line is the ranking's, not a draw", () => {
    const rankingLog = `---
schema_version: 1
---
| Ticker | Name | Index | Date | Result | Summary | Next review |
|---|---|---|---|---|---|---|
| AAA | Aaa | S&P 500 | 2026-07-04 | interesting | Cumple ≥3 criterios | — |
| AAA | Aaa | S&P 500 | 2026-09-19 | interesting | Cumple 2 de 4 criterios | — |
`;
    const out = renderScreeningOutcomes(evaluateRows(parseScreeningLog(rankingLog), BARS, [5]), "2026-09-26", [5]);
    assert.match(out, /\| Antes de DD-0010 \| Todos \(sorteo\) \|/);
    assert.match(out, /\| Desde ADR-0012 \| Todos \(ranking\) \|/);
    assert.match(out, /ranking frente a exploración/);
  });

  it("groups rejections by reason with the Interesting reference row", () => {
    assert.match(md, /\| DD-0010 a ADR-0012 \| No supera el filtro 0 \| 1 \|/);
    assert.match(md, /\| Antes de DD-0010 \| \*\(Interesante\)\* \| 1 \|/);
  });
});
