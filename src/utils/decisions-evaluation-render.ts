// Render of logs/decisions-evaluation.md. Presentation only: the
// figures come from decisions-evaluation.ts, so text and numbers cannot be
// computed two different ways. The cutoff table goes first and under a fixed
// heading, because monday-briefing:prepare extracts it for the prompt.
import { messages, type Messages } from "../i18n/index.js";
import { STOP_ATR_BY_HORIZON } from "./atr-stop.js";
import {
  MIN_SAMPLE,
  PLAN_WINDOW_SESSIONS,
  SESSION_HORIZONS,
  decisionGroupings,
  groupStats,
  tradeGroupings,
  tradeStats,
  type ClosedTrade,
  type CutBoard,
  type DecisionEvaluation,
  type EvaluationReport,
} from "./decisions-evaluation.js";
import { normalizeEol } from "./parse.js";

// Format, not output: monday-briefing:prepare finds the board by this heading, so
// it is the same in every language.
export const CUT_BOARD_HEADING = "## Cut criterion board";

/** Percentage with an explicit sign (+8.2% / -3.1%). */
export function fmtPct(pct: number): string {
  return (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%";
}

const fmtR = (r: number) => `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;
const fmtMoney = (n: number) => n.toFixed(2);
const fmtSigned = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

function opt<T>(value: T | null | undefined, fmt: (v: T) => string): string {
  return value == null ? "—" : fmt(value);
}

function smallSampleWarning(sizes: readonly number[], m: Messages): string[] {
  if (!sizes.some((n) => n < MIN_SAMPLE)) return [];
  return [...m.evaluation.groupsSmallSample(MIN_SAMPLE), ""];
}

/** Skipped exits named one by one in the board; the rest are only counted (until #44 every real exit is skipped). */
const SKIPPED_EXITS_SHOWN = 10;

/**
 * The board's warnings in words: one heading and its lines per group, in the language of `m`. The
 * group is decided by the kind of the warning, never by comparing the translated headings: the
 * unmeasured exits and lots (every kind but the silo reconstruction) share one heading.
 */
export function boardWarnings(board: CutBoard, m: Messages = messages()): { title: string; lines: string[] }[] {
  const t = m.evaluation;
  const groups = board.warnings.map((w): { group: "reconstruction" | "unmeasured"; title: string; lines: string[] } => {
    switch (w.kind) {
      case "reconstruction":
        return { group: "reconstruction", title: t.reconstructionMismatch, lines: w.lines };
      case "exitsWithoutSnapshot": {
        const shown = w.exits.slice(0, SKIPPED_EXITS_SHOWN);
        const rest = w.exits.length - shown.length;
        return {
          group: "unmeasured",
          title: t.unmeasured.title,
          lines: [
            t.unmeasured.exitsWithoutSnapshot(w.exits.length),
            ...shown.map((e) => t.unmeasured.skippedExit(e.ticker ?? "—", e.date, e.lotId)),
            ...(rest > 0 ? [t.unmeasured.moreSkippedExits(rest)] : []),
          ],
        };
      }
      case "oversoldLots":
        return {
          group: "unmeasured",
          title: t.unmeasured.title,
          lines: w.lots.map((l) => t.unmeasured.oversoldLot(l.ticker, l.lotId)),
        };
      case "inconsistentLots":
        return {
          group: "unmeasured",
          title: t.unmeasured.title,
          lines: w.lots.map((l) => t.unmeasured.inconsistentLot(l.ticker, l.lotId, l.reason)),
        };
    }
  });
  return groups
    .reduce<{ group: string; title: string; lines: string[] }[]>((merged, g) => {
      const same = merged.find((x) => x.group === g.group);
      if (same) same.lines.push(...g.lines);
      else merged.push({ group: g.group, title: g.title, lines: [...g.lines] });
      return merged;
    }, [])
    .map(({ title, lines }) => ({ title, lines }));
}

function cutBoardSection(board: CutBoard, m: Messages): string[] {
  const t = m.evaluation;
  const { framework: f, trades } = board;
  const lines = [CUT_BOARD_HEADING, ""];
  if (board.measuredFrom == null) return [...lines, t.emptyRegistry, ""];

  if (board.counterStart == null) {
    lines.push(...t.counterNotStarted(board.rulesVersion, board.measuredFrom), "");
  } else {
    lines.push(t.counterRunning(board.counterStart, board.rulesVersion), "");
  }

  const excluded = trades.total - trades.withR;
  const expectancy =
    trades.expectancy == null
      ? t.expectancyNone
      : t.expectancy(fmtR(trades.expectancy), trades.withR, trades.winners) +
        (excluded > 0 ? t.excludedNoStop(excluded) : "");
  const total =
    board.totalEur == null
      ? t.totalNone
      : t.total(
          fmtMoney(board.totalEur.real),
          fmtMoney(board.totalEur.shadow),
          fmtSigned(board.totalEur.real - board.totalEur.shadow),
        );

  lines.push(
    ...t.boardHeader,
    t.closedTradesRow(trades.total, f.cutReviewTrades, f.cutDecisionTrades),
    t.expectancyRow(expectancy),
    t.openTradesRow(board.open),
    t.portfoliosRow(total),
    "",
    ...t.siloHeader,
    ...board.silos.map(
      (s) =>
        `| ${s.currency} | ${s.reference} | ${s.start} | ${fmtMoney(s.real)} | ${opt(s.shadow, fmtMoney)} | ` +
        `${s.shadow == null ? "—" : fmtSigned(s.real - s.shadow)} | ${opt(s.realReturnPct, fmtPct)} | ${opt(s.shadowReturnPct, fmtPct)} | ` +
        `${s.drawdown.currentPct.toFixed(1)}% | ${s.drawdown.maxPct.toFixed(1)}% |`,
    ),
    "",
  );

  for (const s of board.silos.filter((s) => s.drawdown.currentPct >= f.drawdownPausePct)) {
    lines.push(
      ...t.drawdownPause(s.currency, s.drawdown.currentPct.toFixed(1), s.drawdown.peakDate, f.drawdownPausePct),
      ...(board.counterStart == null ? [t.drawdownTrial] : []),
      "",
    );
  }
  if (trades.withR > 0 && trades.withR < MIN_SAMPLE) {
    lines.push(...t.tradesSmallSample(MIN_SAMPLE), "");
  }
  for (const group of boardWarnings(board, m)) {
    lines.push(group.title, ...group.lines.map((l) => `> - ${l}`), "");
  }
  return lines;
}

function howToReadSection(board: CutBoard, m: Messages): string[] {
  const stops = Object.entries(STOP_ATR_BY_HORIZON)
    .map(([horizon, atr]) => m.evaluation.stopAt(atr, horizon))
    .join(", ");
  return m.evaluation.howToRead({
    horizons: SESSION_HORIZONS.join(m.and),
    stops,
    minRewardRisk: board.framework.minRewardRisk,
    planWindow: PLAN_WINDOW_SESSIONS,
  });
}

function tradesSection(trades: readonly ClosedTrade[], m: Messages): string[] {
  const t = m.evaluation;
  const lines = [t.tradesTitle, ""];
  if (trades.length === 0) return [...lines, t.noTrades, ""];

  const groups = tradeGroupings(trades, m).filter((g) => g.items.length > 0);
  lines.push(...t.tradeGroupsHeader);
  for (const g of groups) {
    const s = tradeStats(g.items);
    lines.push(
      `| ${g.label} | ${s.total} | ${s.withR} | ${opt(s.expectancy, fmtR)} | ${s.withR > 0 ? `${s.winners}/${s.withR}` : "—"} |`,
    );
  }
  lines.push(
    "",
    ...smallSampleWarning(
      groups.map((g) => g.items.length),
      m,
    ),
  );

  lines.push(
    ...t.tradesHeader,
    ...trades.map(
      (tr) =>
        `| ${tr.entryDate} | ${tr.exitDate} | ${tr.ticker} | ${tr.currency} | ${tr.origin}${tr.counts ? " ✓" : ""} | ` +
        `${tr.rulesVersion} | ${tr.ruleViolations.join(", ") || "—"} | ${opt(tr.stop, fmtMoney)} | ${opt(tr.rNet, fmtR)} |`,
    ),
    "",
    t.countsLegend,
    "",
  );
  return lines;
}

function aggregatesSection(evals: readonly DecisionEvaluation[], m: Messages): string[] {
  const t = m.evaluation;
  const header = t.aggregatesHead + SESSION_HORIZONS.map(t.aggregatesHorizon).join(" | ") + t.aggregatesTail;
  const separator = "|" + "---|".repeat(2 + 3 * SESSION_HORIZONS.length + 5);
  const lines = [t.aggregatesTitle, ""];

  for (const grouping of decisionGroupings(evals, m)) {
    lines.push(`### ${grouping.title}`, "", `*${grouping.note}*`, "");
    const groups = grouping.groups.filter((g) => g.items.length > 0);
    if (groups.length === 0) {
      lines.push(t.noDecisions, "");
      continue;
    }
    lines.push(header, separator);
    for (const g of groups) {
      const s = groupStats(g.items);
      const horizonCells = SESSION_HORIZONS.map((h) => {
        const hs = s.horizons[h];
        return `${hs.complete} | ${opt(hs.meanReturn, fmtPct)} | ${opt(hs.meanExcess, fmtPct)}`;
      }).join(" | ");
      lines.push(
        `| ${g.label} | ${s.total} | ${horizonCells} | ${s.withResult} | ${s.targetFirst} | ${s.stopFirst} | ${s.targetAfterStop} | ${opt(s.meanResultR, fmtR)} |`,
      );
    }
    lines.push(
      "",
      ...smallSampleWarning(
        groups.map((g) => g.items.length),
        m,
      ),
    );
  }
  return lines;
}

/** Return cell: in italics and with the elapsed sessions if the horizon is not complete. */
function returnCell(e: DecisionEvaluation, horizon: number, m: Messages): string {
  if (!e.base) return m.evaluation.noData;
  const ret = e.horizons[horizon]?.ret;
  if (!ret) return m.evaluation.pending;
  return ret.partial ? `*${fmtPct(ret.pct)} (${ret.sessions}s)*` : fmtPct(ret.pct);
}

function excessCell(e: DecisionEvaluation, horizon: number): string {
  const outcome = e.horizons[horizon];
  if (!outcome?.ret || outcome.excess == null) return "—";
  return outcome.ret.partial ? `*${fmtPct(outcome.excess)}*` : fmtPct(outcome.excess);
}

function firstCell(e: DecisionEvaluation, m: Messages): string {
  const t = m.evaluation;
  const x = e.excursion;
  if (!x) return "—";
  if (x.first == null) return x.resultR == null ? t.neitherAfter(x.sessions) : t.neither;
  if (x.first === "target") return t.target;
  return x.targetAfterStop ? t.stopToTarget : t.stop;
}

function detailSection(evals: readonly DecisionEvaluation[], m: Messages): string[] {
  const t = m.evaluation;
  const lines = [t.detailTitle, "", t.detailNote, ""];
  if (evals.length === 0) return [...lines, t.noDecisionsToFollow, ""];

  lines.push(
    t.detailHead + SESSION_HORIZONS.map(t.detailHorizon).join(" | ") + t.detailTail,
    "|" + "---|".repeat(7 + 2 * SESSION_HORIZONS.length + 5),
  );
  for (const e of evals) {
    const d = e.decision;
    const x = e.excursion;
    const horizonCells = SESSION_HORIZONS.map((h) => `${returnCell(e, h, m)} | ${excessCell(e, h)}`).join(" | ");
    const plan = e.plan ? `${fmtMoney(e.plan.stop)} / ${fmtMoney(e.plan.target)}${e.plan.inferred ? " †" : ""}` : "—";
    lines.push(
      `| ${d.date} | ${d.ticker} | ${d.type} | ${d.origin} | ${d.conviction ?? "—"} | ${d.rules_version} | ${opt(d.price, fmtMoney)} | ` +
        `${horizonCells} | ${plan} | ${opt(x?.mfeR, fmtR)} | ${opt(x?.maeR, fmtR)} | ${firstCell(e, m)} | ${opt(x?.resultR, fmtR)} |`,
    );
  }
  lines.push("");

  const missing = [...new Set(evals.filter((e) => !e.base).map((e) => e.decision.ticker))];
  if (missing.length > 0) lines.push(t.noHistory(missing.join(", ")), "");
  return lines;
}

/** Full report `logs/decisions-evaluation.md`. */
export function renderDecisionsEvaluation(report: EvaluationReport, m: Messages = messages()): string {
  const t = m.evaluation;
  const span = report.span ? t.span(report.span[0], report.span[1]) : "—";
  return [
    "---",
    "id: decisions-evaluation",
    `title: "${t.frontmatterTitle}"`,
    "tags: [project-note, log]",
    "status: active",
    `updated: ${report.asOf}`,
    "---",
    "",
    ...t.generated(report.asOf, report.decisions, span),
    "",
    ...cutBoardSection(report.board, m),
    ...howToReadSection(report.board, m),
    ...tradesSection(report.trades, m),
    ...aggregatesSection(report.evaluations, m),
    ...detailSection(report.evaluations, m),
  ].join("\n");
}

/** The cutoff table of an already generated report, without its heading; `null` if it is missing. */
export function extractCutBoard(md: string): string | null {
  const text = normalizeEol(md);
  const at = text.indexOf(`${CUT_BOARD_HEADING}\n`);
  if (at === -1) return null;
  const body = text.slice(at + CUT_BOARD_HEADING.length + 1);
  const end = body.indexOf("\n## ");
  return (end === -1 ? body : body.slice(0, end)).trim();
}
