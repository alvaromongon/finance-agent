// Helpers of weekly-screening.ts, extracted so they can be tested without
// importing the script (which runs main() on load — see weekly-screening.ts).
import { messages, type Messages } from "../i18n/index.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CURRENCIES, HORIZONS } from "../types.js";
import type { AssetClass, Benchmark, Conviction, ConvictionPoint, Currency } from "../types.js";
import type { ScreeningSelection } from "../decisions.js";
import type { WatchlistExit } from "./watchlist-exit.js";
import type { RankingFallback } from "../screening-ranking.js";
import { formatRegimeLines } from "./market-regime.js";
import { describeConviction } from "./conviction.js";
import { assertSchemaVersion, extractFrontmatter, SCHEMA_VERSION } from "./vault-parser.js";
import { readTextFile } from "./fs-text.js";
import type { Ticker } from "../ticker.js";

interface ClassifiableTicker {
  market: string;
  currency: Currency;
  asset_class?: AssetClass;
}

/**
 * "Index" label for logs/email. It used to be derived from
 * `market`/`currency` with a heuristic that assumed EU/US stocks only: any
 * unknown ticker (e.g. a Xetra ETC) defaulted to "Eurostoxx 50", which is
 * wrong in `screening-log.md`.
 */
export function classifyIndex(ticker: ClassifiableTicker): string {
  if (ticker.asset_class === "commodity") return "Commodities";
  return ticker.market.includes("S&P") || ["NYSE", "NASDAQ"].includes(ticker.market) ? "S&P 500" : "Eurostoxx 50";
}

// ── Friendly summary of the screening email ─────────────────────

export interface FriendlySummaryInput {
  ticker: Ticker;
  name: string;
  conviction: Conviction;
  /** Rubric points that add up to the conviction. */
  convictionPoints: ConvictionPoint[];
  thesis: string | null;
  reason: string;
  nextCatalyst: string | null;
  /** Setups current on the prepare day, one line per setup (describeSetup). */
  setups: string[];
  /** `selectionLabel` label; empty if drawn at random. */
  selection?: string;
}

/**
 * Prose lines for the screening email: the thesis, its current setups or how
 * it would be bought, and the next catalyst if known. Deterministic
 * formatting over data the screening already computes.
 */
export function buildFriendlySummaryLines(input: FriendlySummaryInput, m: Messages = messages()): string[] {
  const t = m.screening;
  const conviction = describeConviction({ conviction: input.conviction, points: input.convictionPoints }, m);
  const lines = [
    t.candidateHeader(input.ticker, input.name, conviction, input.selection ?? ""),
    input.thesis ?? input.reason,
    ...(input.setups.length > 0 ? input.setups.map(t.setupLine) : [t.buyOnlyWithSetup]),
  ];
  if (input.nextCatalyst) lines.push(t.nextCatalyst(input.nextCatalyst));
  return lines;
}

// ── Result of a candidate's evaluation ──────────────────────────────────────

/**
 * Final result of evaluating a candidate, whatever the backend (API or
 * handoff). It is the record that feeds screening-log.md, the thesis note,
 * watchlist.md and the run email.
 */
export interface ScreeningResult extends ScreeningSelection {
  ticker: Ticker;
  name: string;
  index: string;
  currency: Currency;
  currentPrice: number;
  interesting: boolean;
  /** Engine rubric; null if not interesting. */
  conviction: Conviction | null;
  convictionPoints: ConvictionPoint[];
  reason: string;
  thesis: string | null;
  horizon: "short" | "medium" | null;
  nextCatalyst: string | null;
  /** What would break the thesis; empty if not interesting or API mode did not bring it. */
  invalidation: string[];
  /** Setups current on the prepare day (describeSetup). */
  setups: string[];
}

/**
 * JSON contract the reasoner produces for a candidate — the fields of
 * `routines/weekly-screening.md`, without the asset identity (the candidate
 * file's frontmatter rules there, not what the reasoner repeats). Conviction
 * is not in it: the engine computes it with `scoreConviction`.
 */
export interface ScreeningEvaluation {
  interesting: boolean;
  reason: string;
  thesis: string | null;
  horizon: "short" | "medium" | null;
  next_catalyst: string | null;
  /** Business criteria that would mark the thesis as broken; required if interesting. */
  invalidation: string[];
}

const RETIRED_FIELDS: readonly [string, string][] = [
  ["conviction", "the engine computes it with the ADR-0012 §7 rubric"],
  ["market_notes", "any relevant context goes in reason or thesis"],
];

/**
 * Validates a candidate's evaluation JSON (handoff backend).
 * Same spirit as validateRecommendation in claude-analyst.ts: it collects all
 * problems and throws a single descriptive error — a malformed JSON must not
 * corrupt screening-log.md or watchlist.md. Unlike the tolerant parsing of API
 * mode (which degrades to "not interesting" if Claude answers badly), here the
 * reasoner can fix it and retry, so failing beats degrading.
 */
export function validateScreeningEvaluation(raw: unknown): ScreeningEvaluation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("The evaluation is not a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof obj.interesting !== "boolean") {
    errors.push(`interesting must be a boolean; got: ${JSON.stringify(obj.interesting)}`);
  }
  const interesting = obj.interesting === true;

  if (typeof obj.reason !== "string" || obj.reason.trim() === "") {
    errors.push("reason must be a non-empty string");
  }

  // A reasoner sending them thinks they count, and they do not.
  for (const [field, why] of RETIRED_FIELDS) {
    if (field in obj) errors.push(`${field} is no longer part of the contract: ${why}; remove it`);
  }

  let thesis: string | null = null;
  if (interesting) {
    if (typeof obj.thesis === "string" && obj.thesis.trim() !== "") {
      thesis = obj.thesis.trim();
    } else {
      errors.push("thesis must be a non-empty string when interesting=true");
    }
  }

  let invalidation: string[] = [];
  if (interesting) {
    const items = Array.isArray(obj.invalidation) ? obj.invalidation : [];
    const valid = items.length > 0 && items.every((i) => typeof i === "string" && i.trim() !== "");
    if (valid) {
      invalidation = (items as string[]).map((i) => i.trim());
    } else {
      errors.push("invalidation must be a non-empty list of non-empty strings when interesting=true");
    }
  }

  let horizon: ScreeningEvaluation["horizon"] = null;
  if (obj.horizon != null) {
    if (typeof obj.horizon === "string" && (HORIZONS as readonly string[]).includes(obj.horizon)) {
      horizon = obj.horizon as "short" | "medium";
    } else {
      errors.push(`horizon must be one of [${HORIZONS.join(", ")}]; got: ${JSON.stringify(obj.horizon)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid screening evaluation:\n- ${errors.join("\n- ")}`);
  }

  return {
    interesting,
    reason: (obj.reason as string).trim(),
    thesis,
    horizon,
    next_catalyst:
      typeof obj.next_catalyst === "string" && obj.next_catalyst.trim() !== "" ? obj.next_catalyst.trim() : null,
    invalidation,
  };
}

// ── Run aggregated email ────────────────────────────────────────────────────

export interface ScreeningEmailContext {
  today: string;
  /** Overdue next_review of screening-universe.md, if a reminder is due. */
  overdueReview: string | null;
  /** Tickers of active theses without a defined exit criterion. */
  pendingExitCriteria: string[];
  /** Candidates left unresolved when closing the run (handoff only). */
  unresolvedCandidates?: string[];
  /** How prepare picked the candidates; absent in runs from before it was stored. */
  selection?: ScreeningRunSelection;
}

/**
 * How `prepare` picked the run's candidates (ADR-0012) and each silo's regime
 * that day. In handoff mode it travels from prepare to summarize in
 * `logs/pending-screening/run.json`.
 */
export interface ScreeningRunSelection {
  /** Why the ranking was not reliable and a draw was made; null if there was a ranking. */
  fallbackReason: RankingFallback | null;
  /** Ranking eligibles per silo; absent if drawn at random. */
  eligibleBySilo?: Record<Currency, number>;
  /** Candidates picked per silo. */
  selectedBySilo: Record<Currency, number>;
  /** Each silo's benchmark with its regime; absent in older runs. */
  benchmarks?: Partial<Record<Currency, Benchmark>>;
  /** Mechanical watchlist exits applied by prepare; absent without a ranking. */
  retired?: WatchlistExit[];
}

/** One line per removed ticker, for the email. */
export function describeExit(exit: WatchlistExit, m: Messages = messages()): string {
  return `${m.screening.exitReasons[exit.reason]}: ${describeExitDetail(exit, m)}`;
}

/** The specifics of an exit: the rank, the weeks without a setup… */
export function describeExitDetail(exit: WatchlistExit, m: Messages = messages()): string {
  const d = m.screening.exitDetails;
  switch (exit.reason) {
    case "out_of_universe":
      return d.notInUniverse;
    case "filter_zero":
      return exit.exclusion;
    case "out_of_top":
      return d.rankPosition(exit.rank, exit.of, exit.currency);
    case "no_setup":
      return d.noSetupWeeks(exit.weeks);
  }
}

/** Why the run fell back to a draw, in a sentence. */
export function describeRankingFallback(f: RankingFallback, m: Messages = messages()): string {
  const t = m.screening.rankingFallback;
  switch (f.code) {
    case "no_reference_history":
      return t.noReferenceHistory(f.ticker);
    case "low_coverage":
      return t.lowCoverage(f.withData, f.total);
    case "stale_universe":
      return t.staleMedian(f.medianLastBar);
  }
}

/** Email warnings about the selection: fallback draw and silos without candidates. */
export function selectionWarningLines(selection: ScreeningRunSelection, m: Messages = messages()): string[] {
  const t = m.screening;
  const lines: string[] = [];
  if (selection.fallbackReason != null) {
    lines.push(...t.noRanking(describeRankingFallback(selection.fallbackReason, m)), "");
  }
  for (const currency of CURRENCIES) {
    if (selection.selectedBySilo[currency] > 0) continue;
    const eligible = selection.eligibleBySilo?.[currency];
    const cause =
      eligible == null ? t.noDrawnPassesFilter : eligible === 0 ? t.noneEligible : t.allEligibleTaken(eligible);
    lines.push(t.siloWithoutCandidates(currency, cause), "");
  }
  return lines;
}

/** How the candidate entered the run (ADR-0012): exploration, "ranking #N" or empty if drawn at random. */
export function selectionLabel(r: Pick<ScreeningResult, "rank" | "exploration">, m: Messages = messages()): string {
  if (r.exploration) return m.screening.exploration;
  return r.rank != null ? m.screening.rankingLabel(r.rank) : "";
}

/** Run email subject, depending on whether there are watchlist additions. */
export function buildScreeningEmailSubject(results: ScreeningResult[], m: Messages = messages()): string {
  const added = results.filter((r) => r.interesting).length;
  return added > 0 ? m.screening.subjectAdded(added) : m.screening.subjectNoneAdded(results.length);
}

/**
 * Body of the run's aggregated email, shared by API mode and
 * screening:summarize (handoff) — same information in both backends.
 */
export function buildScreeningEmailLines(
  results: ScreeningResult[],
  ctx: ScreeningEmailContext,
  m: Messages = messages(),
): string[] {
  const t = m.screening;
  const interesting = results.filter((r) => r.interesting);
  const notInteresting = results.filter((r) => !r.interesting);

  const lines: string[] = [
    t.emailTitle(ctx.today),
    "=".repeat(60),
    "",
    t.counts(results.length, interesting.length, notInteresting.length),
    "",
  ];

  if (ctx.selection) lines.push(...selectionWarningLines(ctx.selection, m));
  if (ctx.selection?.benchmarks) lines.push(...formatRegimeLines(ctx.selection.benchmarks, m), "");

  if (ctx.overdueReview) {
    lines.push(...t.overdueReview(ctx.overdueReview), "");
  }

  if (ctx.unresolvedCandidates && ctx.unresolvedCandidates.length > 0) {
    lines.push(...t.unresolved(ctx.unresolvedCandidates.length, ctx.unresolvedCandidates.join(", ")), "");
  }

  const withSetup = interesting.filter((r) => r.setups.length > 0);
  const toWatch = interesting.filter((r) => r.setups.length === 0);
  const summary = (r: ScreeningResult) =>
    buildFriendlySummaryLines(
      {
        ticker: r.ticker,
        name: r.name,
        conviction: r.conviction ?? "low",
        convictionPoints: r.convictionPoints,
        thesis: r.thesis,
        reason: r.reason,
        nextCatalyst: r.nextCatalyst,
        setups: r.setups,
        selection: selectionLabel(r, m),
      },
      m,
    );
  for (const [title, group] of [
    [t.withSetupTitle, withSetup],
    [t.toWatchTitle, toWatch],
  ] as const) {
    if (group.length === 0) continue;
    lines.push(title);
    for (const r of group) lines.push("", ...summary(r));
    lines.push("");
  }

  if (interesting.length > 0) {
    lines.push(t.addedTitle);
    for (const r of interesting) lines.push(`  ${r.ticker.padEnd(12)} ${r.reason}`);
    lines.push("");
  }

  const retired = ctx.selection?.retired ?? [];
  if (retired.length > 0) {
    lines.push(t.retiredTitle);
    for (const exit of retired) lines.push(`  ${exit.ticker.padEnd(12)} ${describeExit(exit, m)}`);
    lines.push("");
  }

  if (notInteresting.length > 0) {
    lines.push(t.rejectedTitle);
    for (const r of notInteresting) {
      const label = selectionLabel(r, m);
      lines.push(`  ${r.ticker.padEnd(12)} ${label ? `[${label}] ` : ""}${r.reason.slice(0, 100)}`);
    }
    lines.push("");
  }

  if (ctx.pendingExitCriteria.length > 0) {
    lines.push(...t.pendingExitCriteria(ctx.pendingExitCriteria.join(", ")), "");
  }

  lines.push("---", ...t.footer);

  return lines;
}

// ── Pending exit criterion reminder ─────────────────────────────

/** True if the thesis has `exit_criteria: pending` in its frontmatter (v1 format). */
export function hasPendingExitCriteria(thesisContent: string): boolean {
  return extractFrontmatter(thesisContent)?.exit_criteria === "pending";
}

/**
 * Tickers of active (not archived) theses with a pending invalidation
 * criterion (`exit_criteria: pending`). Read-only, no LLM.
 */
export async function findTickersWithPendingExitCriteria(vaultDir: string): Promise<string[]> {
  const thesisDir = join(vaultDir, "tesis");
  const files = await readdir(thesisDir).catch(() => [] as string[]);
  const thesisFiles = files.filter((f) => /^tesis-.+\.md$/.test(f));

  const pending: string[] = [];
  for (const file of thesisFiles) {
    const raw = await readTextFile(join(thesisDir, file)).catch(() => "");
    if (!raw) continue;
    assertSchemaVersion(raw, `tesis/${file}`);
    const frontmatter = extractFrontmatter(raw);
    if (frontmatter?.status === "archived") continue;
    if (hasPendingExitCriteria(raw)) {
      pending.push(
        file
          .replace(/^tesis-/, "")
          .replace(/\.md$/, "")
          .toUpperCase(),
      );
    }
  }
  return pending;
}

// ── New thesis of an interesting candidate ───────────────────────────────────

/**
 * Note `tesis/tesis-<slug>.md` for a new interesting candidate. The technicals
 * block is the one the reasoner saw, so it stays in English.
 */
export function buildThesisNote(
  input: {
    ticker: Ticker;
    name: string;
    slug: string;
    today: string;
    technicalsText: string;
    result: Pick<ScreeningResult, "thesis" | "nextCatalyst" | "invalidation">;
  },
  m: Messages = messages(),
): string {
  const t = m.thesis;
  const { result, today } = input;
  return [
    "---",
    `id: ${today.replace(/-/g, "")}-tesis-${input.slug}`,
    `schema_version: ${SCHEMA_VERSION}`,
    `title: "${t.title(input.ticker, input.name)}"`,
    `tags: [project-note]`,
    `status: active`,
    `created: ${today}`,
    `origin: weekly-screening`,
    ...(result.invalidation.length > 0 ? [] : ["exit_criteria: pending"]),
    "---",
    "",
    t.investmentThesis,
    "",
    result.thesis ?? t.thesisPending,
    "",
    t.technicalAnalysis(today),
    "",
    "```",
    input.technicalsText,
    "```",
    "",
    ...(result.nextCatalyst ? [t.nextCatalyst, "", result.nextCatalyst, ""] : []),
    t.entryTitle,
    "",
    t.entry,
    "",
    t.invalidationTitle,
    "",
    result.invalidation.length > 0 ? result.invalidation.map((i) => `- ${i}`).join("\n") : t.exitCriteriaPending,
    "",
    t.referencesTitle,
    "",
    ...t.references,
  ].join("\n");
}
