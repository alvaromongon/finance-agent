// Render of logs/screening-outcomes.md. Presentation only: the
// figures come from groupStats/evaluateRows (screening-outcomes-helpers.ts), so
// text and numbers cannot be computed two different ways.
import { messages, type Messages } from "../i18n/index.js";
import {
  BENCHMARKS,
  COHORTS,
  DD0010_DATE,
  DD0016_DATE,
  HORIZONS,
  type Cohort,
  groupStats,
  type EvaluatedRow,
  type GroupStats,
} from "./screening-outcomes-helpers.js";
import { MIN_SAMPLE } from "./decisions-evaluation.js";
import type { ScreeningResultValue } from "./vault-parser.js";
import { fmtPct } from "./decisions-evaluation-render.js";

const RESULT_GROUPS: readonly { result?: ScreeningResultValue; match: (e: EvaluatedRow) => boolean }[] = [
  { result: "interesting", match: (e) => e.row.result === "interesting" },
  { result: "not_interesting", match: (e) => e.row.result === "not_interesting" },
  { match: () => true },
];

/** The all-rows line is only a chance baseline while candidates were drawn at random. */
function allLabel(cohort: Cohort, m: Messages): string {
  return cohort === "ranking" ? m.outcomes.allRanking : m.outcomes.allDraw;
}

function fmtOpt(pct: number | null): string {
  return pct == null ? "—" : fmtPct(pct);
}

function fmtBeats(s: GroupStats): string {
  if (s.withBenchmark === 0) return "—";
  return `${s.beats}/${s.withBenchmark} (${Math.round((100 * s.beats) / s.withBenchmark)}%)`;
}

/** Return cell: in italics and with the elapsed sessions if the horizon is not complete. */
function fmtReturnCell(e: EvaluatedRow, horizon: number, m: Messages): string {
  if (!e.base) return m.outcomes.noData;
  const ret = e.horizons[horizon]?.ret;
  if (!ret) return m.outcomes.pending;
  return ret.partial ? `*${fmtPct(ret.pct)} (${ret.sessions}s)*` : fmtPct(ret.pct);
}

function fmtExcessCell(e: EvaluatedRow, horizon: number): string {
  const outcome = e.horizons[horizon];
  if (!outcome?.ret || outcome.excess == null) return "—";
  return outcome.ret.partial ? `*${fmtPct(outcome.excess)}*` : fmtPct(outcome.excess);
}

function summarySection(evals: EvaluatedRow[], horizon: number, m: Messages): string[] {
  const t = m.outcomes;
  const lines = [t.summaryTitle(horizon), "", ...t.summaryHeader];

  const sizes: number[] = [];
  for (const cohort of COHORTS) {
    const inCohort = evals.filter((e) => e.cohort === cohort);
    for (const group of RESULT_GROUPS) {
      const s = groupStats(inCohort.filter(group.match), horizon);
      if (s.total === 0) continue;
      if (group.result) sizes.push(s.complete);
      lines.push(
        `| ${t.cohorts[cohort]} | ${group.result ? t.results[group.result] : allLabel(cohort, m)} | ${s.complete} | ${fmtOpt(s.mean)} | ${fmtOpt(s.median)} | ` +
          `${fmtOpt(s.meanExcess)} | ${fmtOpt(s.medianExcess)} | ${fmtBeats(s)} | ${s.pending} | ${s.missing} |`,
      );
    }
  }

  lines.push("");
  if (sizes.every((n) => n === 0)) {
    lines.push(t.noneComplete(horizon));
  } else if (sizes.some((n) => n < MIN_SAMPLE)) {
    lines.push(...t.smallSample(MIN_SAMPLE));
  }
  lines.push("");
  return lines;
}

function reasonSection(evals: EvaluatedRow[], horizons: readonly number[], m: Messages): string[] {
  const t = m.outcomes;
  const header = t.reasonsHead + horizons.map(t.reasonsHorizon).join(" | ") + " |";
  const lines = [t.reasonsTitle, "", ...t.reasonsNote, "", header, "|" + "---|".repeat(3 + 3 * horizons.length)];

  const statsCells = (group: EvaluatedRow[]) =>
    horizons
      .map((h) => {
        const s = groupStats(group, h);
        return `${s.complete} | ${fmtOpt(s.mean)} | ${fmtOpt(s.meanExcess)}`;
      })
      .join(" | ");

  for (const cohort of COHORTS) {
    const inCohort = evals.filter((e) => e.cohort === cohort);
    const interesting = inCohort.filter((e) => e.row.result === "interesting");
    if (interesting.length > 0) {
      lines.push(
        `| ${t.cohorts[cohort]} | ${t.interestingReference} | ${interesting.length} | ${statsCells(interesting)} |`,
      );
    }

    const byReason = new Map<string, EvaluatedRow[]>();
    for (const e of inCohort) {
      if (e.reason == null) continue;
      const group = byReason.get(e.reason) ?? [];
      group.push(e);
      byReason.set(e.reason, group);
    }
    const ordered = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [reason, group] of ordered) {
      lines.push(`| ${t.cohorts[cohort]} | ${reason} | ${group.length} | ${statsCells(group)} |`);
    }
  }

  lines.push("");
  return lines;
}

function detailSection(evals: EvaluatedRow[], horizons: readonly number[], m: Messages): string[] {
  const t = m.outcomes;
  const lines = [
    t.detailTitle,
    "",
    t.detailNote,
    "",
    t.detailHead + horizons.map(t.detailHorizon).join(" | ") + " |",
    "|" + "---|".repeat(6 + 2 * horizons.length),
  ];

  for (const e of evals) {
    const ticker = e.repeated ? `${e.row.ticker} †` : e.row.ticker;
    const base = e.base ? `${e.base.close.toFixed(2)} (${e.base.date})` : t.noData;
    const cells = horizons.map((h) => `${fmtReturnCell(e, h, m)} | ${fmtExcessCell(e, h)}`).join(" | ");
    lines.push(
      `| ${e.row.date} | ${ticker} | ${e.row.index} | ${t.results[e.row.result]} | ${e.reason ?? "—"} | ${base} | ${cells} |`,
    );
  }

  lines.push("");
  const repeated = [...new Set(evals.filter((e) => e.repeated).map((e) => e.row.ticker))];
  if (repeated.length > 0) {
    lines.push(...t.repeated(repeated.join(", ")), "");
  }
  const missing = [...new Set(evals.filter((e) => !e.base).map((e) => e.row.ticker))];
  if (missing.length > 0) {
    lines.push(t.noHistory(missing.join(", ")), "");
  }
  return lines;
}

/** Full report `logs/screening-outcomes.md`. */
export function renderScreeningOutcomes(
  evals: EvaluatedRow[],
  today: string,
  horizons: readonly number[] = HORIZONS,
  m: Messages = messages(),
): string {
  const t = m.outcomes;
  const tickers = new Set(evals.map((e) => e.row.ticker)).size;
  const dates = evals.map((e) => e.row.date).sort();
  const span = dates.length > 0 ? m.evaluation.span(dates[0], dates[dates.length - 1]) : "—";
  const benchmarks = Object.entries(BENCHMARKS)
    .map(([index, symbol]) => t.benchmarkFor(symbol, index))
    .join(", ");

  return [
    "---",
    "id: screening-outcomes",
    `title: "${t.frontmatterTitle}"`,
    "tags: [project-note, log]",
    "status: active",
    `updated: ${today}`,
    "---",
    "",
    ...t.generated(today, evals.length, tickers, span),
    "",
    ...t.howToRead({ horizons: horizons.join(m.and), benchmarks, dd0010: DD0010_DATE, dd0016: DD0016_DATE }),
    ...horizons.flatMap((h) => summarySection(evals, h, m)),
    ...reasonSection(evals, horizons, m),
    ...detailSection(evals, horizons, m),
  ].join("\n");
}
