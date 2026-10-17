// Chart of SLI 1, proposal quality (ADR-0014): evaluated buy proposals over time
// (n), their mean plan R and the benchmark over the same windows, as a
// self-contained SVG. Presentation only: plan R comes from the evaluation
// (`DecisionEvaluation.excursion`), it is never recomputed here. It shows R and
// counts, never money. Below MIN_SAMPLE it says "insufficient data" instead of
// a verdict; the confidence bound (#1) will be a further line in the same panel.
import { formatNumber, messages, type Messages } from "../i18n/index.js";
import { MIN_SAMPLE, PLAN_WINDOW_SESSIONS, mean, type DecisionEvaluation } from "./decisions-evaluation.js";

/** The decisions that are the system's buy proposals (ADR-0014 SLI 1). */
const PROPOSAL_TYPE = "buy_proposal";

/** The window the benchmark is measured over: the plan's own. */
const BENCHMARK_HORIZON = PLAN_WINDOW_SESSIONS;

export interface ProposalPoint {
  /** Decision date of the latest proposal in this point. */
  date: string;
  /** Evaluated proposals up to and including this date. */
  n: number;
  /** Mean plan R of those proposals. */
  meanR: number;
  /** Mean benchmark in R of those with a complete window; null if none yet. */
  benchmarkR: number | null;
}

export interface ProposalSeries {
  points: ProposalPoint[];
  n: number;
  meanR: number | null;
  benchmarkR: number | null;
  /** n has reached the minimum sample. */
  sufficient: boolean;
}

interface Observation {
  date: string;
  r: number;
  benchmarkR: number | null;
}

/**
 * The benchmark's return over the plan window, in the R of the proposal: the
 * return of holding the benchmark with the same stop distance. Only for a
 * complete window; `null` otherwise.
 */
function benchmarkInR(e: DecisionEvaluation): number | null {
  const outcome = e.horizons[BENCHMARK_HORIZON];
  if (!e.plan || !outcome?.ret || outcome.ret.partial || outcome.excess == null) return null;
  const riskFraction = (e.plan.entry - e.plan.stop) / e.plan.entry;
  return (outcome.ret.pct - outcome.excess) / 100 / riskFraction;
}

/** Cumulative series, by decision date, of the evaluated buy proposals. */
export function buildProposalSeries(evaluations: readonly DecisionEvaluation[]): ProposalSeries {
  const observations: Observation[] = evaluations
    .filter((e) => e.decision.type === PROPOSAL_TYPE && e.excursion?.resultR != null)
    .map((e) => ({ date: e.decision.date, r: e.excursion!.resultR!, benchmarkR: benchmarkInR(e) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const points: ProposalPoint[] = [];
  observations.forEach((o, i) => {
    const upTo = observations.slice(0, i + 1);
    const point: ProposalPoint = {
      date: o.date,
      n: upTo.length,
      meanR: mean(upTo.map((x) => x.r))!,
      benchmarkR: mean(upTo.map((x) => x.benchmarkR).filter((x): x is number => x != null)),
    };
    // One point per date: the latest cumulative value of that day.
    if (points.at(-1)?.date === o.date) points[points.length - 1] = point;
    else points.push(point);
  });

  const last = points.at(-1);
  return {
    points,
    n: observations.length,
    meanR: last?.meanR ?? null,
    benchmarkR: last?.benchmarkR ?? null,
    sufficient: observations.length >= MIN_SAMPLE,
  };
}

// ─── SVG ─────────────────────────────────────────────────────────────────────

const WIDTH = 720;
const LEFT = 64;
const RIGHT = WIDTH - 20;
const RPANEL = { top: 104, bottom: 250 };
const NPANEL = { top: 292, bottom: 388 };
const HEIGHT = 508;

// Both themes in the file itself: it is shown as an image, so the page cannot style it.
const STYLE = `
.bg{fill:#ffffff}
text{fill:#1f2328;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:12px}
.muted{fill:#59636e}
.title{font-size:16px;font-weight:600}
.status{font-size:14px;font-weight:600}
.grid{stroke:#d1d9e0;stroke-width:1;fill:none}
.zero{stroke:#59636e;stroke-width:1;fill:none}
.mean{stroke:#0969da;stroke-width:2.5;fill:none}
.mean-dot{fill:#0969da}
.bench{stroke:#bc4c00;stroke-width:2;stroke-dasharray:6 3;fill:none}
.count{stroke:#0969da;stroke-width:2;fill:none}
.min{stroke:#8250df;stroke-width:1.5;stroke-dasharray:2 3;fill:none}
.min-label{fill:#8250df}
@media (prefers-color-scheme: dark){
.bg{fill:#0d1117}
text{fill:#e6edf3}
.muted{fill:#9198a1}
.grid{stroke:#30363d}
.zero{stroke:#9198a1}
.mean{stroke:#58a6ff}
.mean-dot{fill:#58a6ff}
.bench{stroke:#f0883e}
.count{stroke:#58a6ff}
.min{stroke:#d2a8ff}
.min-label{fill:#d2a8ff}
}`;

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmt = (n: number) => n.toFixed(1);

function fmtR(r: number, m: Messages): string {
  return `${r >= 0 ? "+" : "-"}${formatNumber(m, Math.abs(r))}R`;
}

const text = (x: number, y: number, s: string, cls = "", anchor: "start" | "end" | "middle" = "start") =>
  `<text x="${fmt(x)}" y="${fmt(y)}"${cls ? ` class="${cls}"` : ""} text-anchor="${anchor}">${escapeXml(s)}</text>`;

const line = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
  `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" class="${cls}"/>`;

const polyline = (coords: readonly [number, number][], cls: string) =>
  `<polyline class="${cls}" points="${coords.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}"/>`;

function linear(domain: [number, number], range: [number, number]): (v: number) => number {
  const [d0, d1] = domain;
  return d1 === d0 ? () => (range[0] + range[1]) / 2 : (v) => range[0] + ((v - d0) / (d1 - d0)) * (range[1] - range[0]);
}

const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** Self-contained SVG of SLI 1 for any brain's decision log. */
export function renderProposalQualitySvg(series: ProposalSeries, m: Messages = messages()): string {
  const t = m.chart;
  const { points } = series;
  const out: string[] = [];

  const status = series.sufficient ? t.enough(series.n) : t.insufficient(series.n, MIN_SAMPLE);
  const summary =
    series.meanR == null
      ? t.noProposals
      : t.summary(fmtR(series.meanR, m), series.benchmarkR == null ? "—" : fmtR(series.benchmarkR, m));
  const first = points.at(0)?.date;
  const last = points.at(-1)?.date;
  const description = first && last ? t.description(series.n, first, last) : t.descriptionEmpty;

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" lang="${escapeXml(m.locale)}">`,
    `<title>${escapeXml(t.title)}</title>`,
    `<desc>${escapeXml(description)}</desc>`,
    `<style>${STYLE}</style>`,
    `<rect class="bg" width="${WIDTH}" height="${HEIGHT}"/>`,
    text(LEFT, 28, t.title, "title"),
    text(LEFT, 52, status, "status"),
    text(LEFT, 72, summary, "muted"),
  );

  // Legend.
  out.push(
    line(LEFT, 90, LEFT + 24, 90, "mean"),
    text(LEFT + 30, 94, t.meanRLabel),
    line(LEFT + 230, 90, LEFT + 254, 90, "bench"),
    text(LEFT + 260, 94, t.benchmarkLabel),
  );

  if (points.length > 0) {
    const times = points.map((p) => dayMs(p.date));
    const x = linear([Math.min(...times), Math.max(...times)], [LEFT + 8, RIGHT - 8]);
    const xOf = (p: ProposalPoint) => x(dayMs(p.date));

    // Panel A: cumulative mean plan R and benchmark, in R. Zero is always in range.
    const values = [0, ...points.flatMap((p) => [p.meanR, ...(p.benchmarkR == null ? [] : [p.benchmarkR])])];
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const pad = (hi - lo || 1) * 0.1;
    lo -= pad;
    hi += pad;
    const yR = linear([lo, hi], [RPANEL.bottom, RPANEL.top]);
    for (const tick of [lo + pad, 0, hi - pad]) {
      out.push(
        line(LEFT, yR(tick), RIGHT, yR(tick), tick === 0 ? "zero" : "grid"),
        text(LEFT - 6, yR(tick) + 4, fmtR(tick, m), "muted", "end"),
      );
    }
    const bench = points.filter((p) => p.benchmarkR != null);
    if (bench.length > 0)
      out.push(
        polyline(
          bench.map((p) => [xOf(p), yR(p.benchmarkR!)]),
          "bench",
        ),
      );
    out.push(
      polyline(
        points.map((p) => [xOf(p), yR(p.meanR)]),
        "mean",
      ),
    );
    const end = points[points.length - 1];
    out.push(`<circle class="mean-dot" cx="${fmt(xOf(end))}" cy="${fmt(yR(end.meanR))}" r="3.5"/>`);

    // Panel B: evaluated proposals over time, against the minimum sample.
    const top = Math.max(MIN_SAMPLE, series.n) * 1.1;
    const yN = linear([0, top], [NPANEL.bottom, NPANEL.top]);
    out.push(
      text(LEFT, NPANEL.top - 12, t.countLabel, "muted"),
      line(LEFT, yN(0), RIGHT, yN(0), "zero"),
      text(LEFT - 6, yN(0) + 4, "0", "muted", "end"),
      line(LEFT, yN(MIN_SAMPLE), RIGHT, yN(MIN_SAMPLE), "min"),
      text(LEFT + 4, yN(MIN_SAMPLE) - 5, t.minSampleLabel(MIN_SAMPLE), "min-label"),
    );
    const steps: [number, number][] = [];
    points.forEach((p, i) => {
      if (i > 0) steps.push([xOf(p), yN(points[i - 1].n)]);
      steps.push([xOf(p), yN(p.n)]);
    });
    out.push(polyline(steps, "count"), text(xOf(end) - 6, yN(end.n) - 8, `n = ${series.n}`, "", "end"));
    out.push(text(LEFT, NPANEL.bottom + 20, first!, "muted"), text(RIGHT, NPANEL.bottom + 20, last!, "muted", "end"));
  }

  out.push(
    ...t.method.map((l, i) => text(LEFT, HEIGHT - 20 - (t.method.length - i) * 18, l, "muted")),
    text(LEFT, HEIGHT - 16, t.notice, "muted"),
    "</svg>",
  );
  return out.join("\n") + "\n";
}
