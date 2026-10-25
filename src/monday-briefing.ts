// Monday Briefing: weekly contribution plan + strategic review of portfolio
// and watchlist (replaces weekly-review.ts).
//
// The flow is split into two deterministic commands (no LLM)
// so the reasoning is done by a Claude Code Routine without spending
// ANTHROPIC_API_KEY — same handoff pattern as the heartbeat:
//
//   npm run monday-briefing:prepare   → prints the user prompt to stdout
//     (the Routine reasons with routines/monday-briefing.md as system prompt
//      and its native WebSearch instead of the API web_search tool)
//   npm run monday-briefing:finalize  → takes the report on stdin, validates
//     it and runs the post-processing (log with frontmatter, watchlist
//     removals with guardrail, email)
//
// The original API mode (npm run monday-briefing, no subcommand) is still
// available as an escape hatch behind the same switch as the heartbeat: with
// ANALYST_PROVIDER=api (or unset) it calls the API; with "handoff" it fails
// explicitly so the API is not spent by accident.
import { messages, responseLanguageInstruction } from "./i18n/index.js";
import { en } from "./i18n/en.js";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { YahooFinanceProvider } from "./providers/yahoo-finance.js";
import {
  appendDecisions,
  readDecisions,
  readPortfolioIgnoringLots,
  readRoutinePrompt,
  readRulesVersion,
  readWatchlistSkippingBadTickers,
  retireWatchlistEntry,
  updatePortfolioPrices,
} from "./vault-io.js";
import { buildBriefingDecisions, extractProposals, formatEngineTicketsSection } from "./utils/briefing-decisions.js";
import { CUT_BOARD_HEADING, extractCutBoard } from "./utils/decisions-evaluation-render.js";
import { siloValue } from "./utils/sizing.js";
import { fetchBenchmarks } from "./utils/benchmark.js";
import { formatRegimeLines } from "./utils/market-regime.js";
import { assertMailConfigured, sendSummaryEmail } from "./mailer.js";
import { extractRetireList, extractPlanSummary } from "./utils/vault-parser.js";
import { readTextFile } from "./utils/fs-text.js";
import {
  filterSafeRetireList,
  buildTechnicalsSection,
  collectTickerSnapshots,
  computeAssetClassWeights,
  formatPortfolioWeights,
  formatUsdCushion,
  validateBriefingReport,
  buildBriefingLogContent,
  webSearchSucceeded,
  injectMacroSearchWarning,
  type TechnicalsProvider,
} from "./utils/monday-briefing-helpers.js";

// FX pair in Yahoo Finance format: same `chart` endpoint YahooFinanceProvider
// already uses for stocks/ETCs — no new provider needed.
const EUR_USD_TICKER = "EURUSD=X";

async function safeRead(path: string): Promise<string> {
  return readTextFile(path).catch(() => "");
}

export interface PreparedBriefing {
  today: string;
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Deterministic phase before the reasoning: reads the vault context
 * (portfolio, watchlist, theses, logs), computes technicals and the exchange
 * rate, and builds the full user prompt. No LLM. Progress goes to stderr so
 * that in `prepare` mode stdout only holds the prompt (pipeable).
 */
export async function prepareBriefing(
  provider: TechnicalsProvider = new YahooFinanceProvider(),
): Promise<PreparedBriefing> {
  const today = new Date().toISOString().slice(0, 10);
  const vaultDir = config.paths.vaultProjectDir;
  const logsDir = join(vaultDir, "logs");

  console.error("[monday-briefing] Reading vault context...");

  const [watchlistMd, evaluationMd, systemPromptMd, policyMd] = await Promise.all([
    safeRead(join(vaultDir, "watchlist.md")),
    safeRead(join(logsDir, "decisions-evaluation.md")),
    readRoutinePrompt("monday-briefing"),
    safeRead(join(vaultDir, "portfolio-policy.md")),
  ]);

  // Cash and positions/watchlist of both silos (portfolio.md/watchlist.md are
  // single files with EUR/USD sections, but vault-io exposes them per currency).
  const [initialEur, initialUsd] = await Promise.all([
    readPortfolioIgnoringLots("EUR"),
    readPortfolioIgnoringLots("USD"),
  ]);
  const [eurWatchlist, usdWatchlist] = await Promise.all([
    readWatchlistSkippingBadTickers("EUR"),
    readWatchlistSkippingBadTickers("USD"),
  ]);

  const allTickers = [
    ...new Set([
      ...initialEur.positions.map((p) => p.ticker),
      ...initialUsd.positions.map((p) => p.ticker),
      ...eurWatchlist.map((e) => e.ticker),
      ...usdWatchlist.map((e) => e.ticker),
    ]),
  ];

  // Refresh Current price and P/L in portfolio.md BEFORE reading it for the
  // prompt. Without this the briefing got the table as the last heartbeat
  // left it next to today's technicals, and had to resolve the contradiction
  // in prose: the 2026-08-31 report spent a process note explaining why
  // BTC-EUR showed both 79.858,60 and 67.308,25. With the batch provider this
  // is 1–2 requests that also warm the cache for buildTechnicalsSection.
  console.error("[monday-briefing] Refreshing portfolio.md prices...");
  const refreshedPrices = await provider.getPrices(allTickers);
  await updatePortfolioPrices("EUR", refreshedPrices);
  await updatePortfolioPrices("USD", refreshedPrices);

  // Re-read with the prices already written: the prompt, the weight breakdown
  // and the USD buffer must all describe the same state.
  const portfolioMd = await safeRead(join(vaultDir, "portfolio.md"));
  const [eurPortfolio, usdPortfolio] = await Promise.all([
    readPortfolioIgnoringLots("EUR"),
    readPortfolioIgnoringLots("USD"),
  ]);

  console.error(`[monday-briefing] Computing technicals for ${allTickers.length} assets...`);
  // Entries of both silos: buildTechnicalsSection looks for the candidates'
  // current setups (ADR-0013) and runs them through eligibility.
  const entriesByTicker = new Map([...eurWatchlist, ...usdWatchlist].map((entry) => [entry.ticker, entry] as const));
  // Value of each silo: the base of each setup's ticket.
  const silos = {
    EUR: { cash: eurPortfolio.cash, value: siloValue(eurPortfolio) },
    USD: { cash: usdPortfolio.cash, value: siloValue(usdPortfolio) },
  };
  // Market regime of each silo: one more eligibility rule.
  const benchmarks = await fetchBenchmarks(provider, ["EUR", "USD"]);
  const technicalsSection = await buildTechnicalsSection(provider, allTickers, entriesByTicker, {
    silos,
    positionsByTicker: new Map(
      [...eurPortfolio.positions, ...usdPortfolio.positions].map((p) => [p.ticker, p] as const),
    ),
    regimes: { EUR: benchmarks.EUR?.regime, USD: benchmarks.USD?.regime },
  });

  // EUR/USD exchange rate: for the weight breakdown in a single currency and
  // the USD buffer in euros. Non-blocking: if Yahoo fails, the briefing goes on without it.
  console.error("[monday-briefing] Fetching EUR/USD exchange rate...");
  const fxPriceMap = await provider.getPrices([EUR_USD_TICKER]);
  const eurUsdRate = fxPriceMap.get(EUR_USD_TICKER) ?? null;

  const weightsSection =
    eurUsdRate != null
      ? formatPortfolioWeights(
          computeAssetClassWeights(eurPortfolio, usdPortfolio, eurWatchlist, usdWatchlist, eurUsdRate),
        )
      : "(not available: the current EUR/USD rate could not be fetched)";

  // Thesis notes
  const thesisFiles = await readdir(join(vaultDir, "tesis")).catch(() => [] as string[]);
  const thesisPaths = thesisFiles
    .filter((f) => f.startsWith("tesis-") && f.endsWith(".md"))
    .sort()
    .map((f) => join("tesis", f));
  const thesisContents = await Promise.all(thesisPaths.map((f) => safeRead(join(vaultDir, f))));

  const allLogFiles = await readdir(logsDir).catch(() => [] as string[]);

  // Decision logs of the last 30 days, without the weekly reports themselves.
  // Aggregated reports carry no date in their name and the date filter
  // leaves them out.
  const cutoff = Date.now() - 30 * 86_400_000;
  const recentLogs = allLogFiles
    .filter(
      (f) => f.endsWith(".md") && f !== ".gitkeep" && !f.includes("weekly-review") && !f.includes("monday-briefing"),
    )
    .filter((f) => {
      const dateStr = f.slice(0, 10);
      return !Number.isNaN(Date.parse(dateStr)) && new Date(dateStr).getTime() >= cutoff;
    })
    .sort();
  const recentLogContents = await Promise.all(recentLogs.map((f) => safeRead(join(logsDir, f))));

  // Build user prompt with all context
  const sections: string[] = [
    `# Finance Agent context — Monday Briefing ${today}`,
    "",
    "## Available funds",
    `EUR: ${eurPortfolio.cash.toFixed(2)} €`,
    `USD: ${usdPortfolio.cash.toFixed(2)} $`,
    ...(["EUR", "USD"] as const).map((c) => {
      const { riskPerTradePct, maxPositionPct } = config.framework;
      const value = silos[c].value;
      return (
        `Silo value ${c}: ${value.toFixed(2)} · risk per trade ${riskPerTradePct}% = ${((value * riskPerTradePct) / 100).toFixed(2)}` +
        ` · per-position cap ${maxPositionPct}% = ${((value * maxPositionPct) / 100).toFixed(2)}`
      );
    }),
    eurUsdRate != null ? `Current EUR/USD rate: ${eurUsdRate.toFixed(4)}` : "",
    formatUsdCushion(silos.USD, eurUsdRate, config.framework.maxPositionPct),
    "",
    "## Market regime",
    ...formatRegimeLines(benchmarks, en),
    "",
    "## Weights by asset class (EUR-equivalent)",
    weightsSection,
    "",
    "## portfolio.md",
    portfolioMd || "(not available)",
    "",
    "## watchlist.md",
    watchlistMd || "(not available)",
    "",
    "## Current technicals",
    technicalsSection,
    "",
  ];

  if (policyMd) {
    sections.push("## portfolio-policy.md");
    sections.push(policyMd);
    sections.push("");
  }

  if (thesisPaths.length > 0) {
    sections.push("## Thesis notes");
    for (let i = 0; i < thesisPaths.length; i++) {
      sections.push(`### ${thesisPaths[i]}`);
      sections.push(thesisContents[i] || "(not available)");
    }
    sections.push("");
  }

  // Cutoff criterion table (ADR-0009 §4): decisions:evaluate builds
  // it in step 1 of the Routine. Only the table: the per-decision detail is for
  // reading, not for the prompt.
  sections.push(CUT_BOARD_HEADING);
  sections.push(
    extractCutBoard(evaluationMd) ??
      "(not available: logs/decisions-evaluation.md is missing; run `npm run decisions:evaluate`)",
  );
  sections.push("");

  if (recentLogContents.length > 0) {
    sections.push(`## Recent decision logs (${recentLogs.length} in 30 days)`);
    for (let i = 0; i < recentLogs.length; i++) {
      sections.push(`### ${recentLogs[i]}`);
      sections.push(recentLogContents[i]);
    }
  } else {
    sections.push("## Recent decision logs\n\n(no decisions in the last 30 days)");
  }
  sections.push("", responseLanguageInstruction());

  return { today, systemPrompt: systemPromptMd, userPrompt: sections.join("\n") };
}

/**
 * Deterministic post-processing of the report (same path for API mode and
 * the Routine): checks the report is complete, saves it in logs/ with
 * frontmatter, applies the watchlist removals with the open-positions
 * guardrail and sends the summary email.
 *
 * It re-reads portfolio.md instead of taking prepare's snapshot: in handoff
 * mode it runs in a different process and the vault state rules (same
 * principle as buildSignal in pending.ts).
 */
export async function finalizeBriefing(
  fullText: string,
  provider: TechnicalsProvider = new YahooFinanceProvider(),
): Promise<void> {
  const problems = validateBriefingReport(fullText);
  if (problems.length > 0) {
    // Same spirit as the API mode stop_reason=max_tokens check: never
    // commit/send a truncated report or one without the machine section.
    throw new Error(`Incomplete report — not processed:\n- ${problems.join("\n- ")}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const logsDir = join(config.paths.vaultProjectDir, "logs");
  const m = messages();

  const [eurPortfolio, usdPortfolio, eurWatchlist, usdWatchlist, rulesVersion, history] = await Promise.all([
    readPortfolioIgnoringLots("EUR"),
    readPortfolioIgnoringLots("USD"),
    readWatchlistSkippingBadTickers("EUR"),
    readWatchlistSkippingBadTickers("USD"),
    readRulesVersion(),
    readDecisions(),
  ]);

  // Briefing decisions, computed before writing anything: one per
  // open position. Technicals are
  // recomputed here because prepare runs in another process; early on Monday
  // prices are the same.
  const proposals = extractProposals(fullText) ?? [];
  const watchlist = [...eurWatchlist, ...usdWatchlist];
  const positions = [...eurPortfolio.positions, ...usdPortfolio.positions];
  const snapshots = await collectTickerSnapshots(
    provider,
    positions.map((p) => p.ticker),
  );
  const benchmarks = await fetchBenchmarks(provider, ["EUR", "USD"]);
  const { decisions, tickets, warnings } = buildBriefingDecisions({
    date: today,
    rulesVersion,
    logLink: `logs/${today}-monday-briefing.md`,
    proposals,
    watchlist,
    positions,
    snapshots,
    benchmarks,
  });
  for (const w of warnings) console.warn(`[monday-briefing] ⚠ ${w}`);
  // Engine tickets: they go to the log and the email with the report.
  const ticketsSection = formatEngineTicketsSection(tickets, m);
  const reportWithTickets = ticketsSection ? `${fullText.trimEnd()}\n\n${ticketsSection}\n` : fullText;

  const content = buildBriefingLogContent(today, reportWithTickets);

  const outPath = join(logsDir, `${today}-monday-briefing.md`);
  await writeFile(outPath, content, "utf8");
  console.log(`[monday-briefing] Saved to ${outPath}`);

  // Parse the AUTOMATED_ACTIONS section: removals + plan summary
  const rawRetireList = extractRetireList(fullText);
  const planSummary = extractPlanSummary(fullText) || m.briefing.planFallback;

  // Deterministic guardrail: never remove a ticker with an open position, even
  // if the model proposes it (the system prompt asks for this, but that is not enough).
  const openPositionTickers = new Set([
    ...eurPortfolio.positions.map((p) => p.ticker),
    ...usdPortfolio.positions.map((p) => p.ticker),
  ]);
  const { safe: toRetire, blocked: blockedRetires } = filterSafeRetireList(rawRetireList, openPositionTickers);

  if (blockedRetires.length > 0) {
    console.warn(`[monday-briefing] ⚠ Ignoring removal of tickers with an open position: ${blockedRetires.join(", ")}`);
  }

  if (toRetire.length > 0) {
    console.log(`[monday-briefing] Removing from watchlist: ${toRetire.join(", ")}`);
    for (const ticker of toRetire) {
      await retireWatchlistEntry(ticker, m.briefing.retireReason(today));
    }
  }

  // Idempotent: if finalize is rerun the same day (failed push, manual retry),
  // the log and the removals are redone with no cumulative effect, but the
  // decision log is append-only and already has this briefing's decisions.
  if (history.some((d) => d.source === "monday-briefing" && d.date === today)) {
    console.warn(`[monday-briefing] ⚠ The ${today} briefing is already in logs/decisions.jsonl: not recorded again`);
  } else {
    await appendDecisions(decisions);
    console.log(`[monday-briefing] ${decisions.length} decision(s) in logs/decisions.jsonl`);
  }

  // The email is always sent (also when the plan is "accumulate cash").
  const emailBody = [
    m.briefing.emailTitle(today),
    "=".repeat(60),
    "",
    ...formatRegimeLines(benchmarks, m),
    "",
    reportWithTickets,
    "",
    "---",
    toRetire.length > 0 ? m.briefing.retired(toRetire.join(", ")) : m.briefing.noneRetired,
  ].join("\n");

  await sendSummaryEmail(m.briefing.subject(today, planSummary), emailBody);
}

/** Full API mode (escape hatch): prepare → Claude Opus with web search → finalize. */
async function runApiBriefing(): Promise<void> {
  const { systemPrompt, userPrompt } = await prepareBriefing();

  const weeklyModel = process.env.CLAUDE_WEEKLY_MODEL ?? "claude-opus-4-8";
  const weeklyEffort = process.env.CLAUDE_WEEKLY_EFFORT ?? "medium";

  console.error(`[monday-briefing] Calling ${weeklyModel} (effort: ${weeklyEffort})...`);

  const client = new Anthropic({ apiKey: config.claude.apiKey(), maxRetries: 4 });
  const stream = client.messages.stream({
    model: weeklyModel,
    // Generous headroom: with adaptive thinking + up to 8 web searches, the
    // token budget is shared between reasoning and final text before reaching
    // the 7 sections (incl. executive summary) + tables of the full report.
    max_tokens: 20000,
    thinking: { type: "adaptive" },
    output_config: { effort: weeklyEffort as "low" | "medium" | "high" | "max" },
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    // Native web search: real macro/geopolitical context instead of
    // only Claude's trained knowledge. Server-side: if it fails or runs out of
    // max_uses, the briefing goes on with base knowledge (no exception; the
    // system prompt itself asks it to say so explicitly).
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
  });
  const response = await stream.finalMessage();

  // If max_tokens runs out the text is cut mid-sentence and without the
  // AUTOMATED_ACTIONS section — fail explicitly instead of silently committing
  // an incomplete report (issue found on 2026-07-13).
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude response truncated by max_tokens before completing the report");
  }

  // With web search the response interleaves text between searches: join all
  // the text blocks (not just the first) before processing the report.
  const textBlocks = response.content.filter((b) => b.type === "text");
  if (textBlocks.length === 0) {
    throw new Error("Claude response without a text block");
  }
  let fullText = textBlocks.map((b) => b.text).join("\n\n");

  // Deterministic safety net (unlike the Routine, here we do see the
  // `web_search` tool_results): if no search returned results, we do not trust
  // the model to say so on its own — we guarantee it by injecting the notice
  // ourselves before validating/committing.
  if (!webSearchSucceeded(response.content)) {
    console.warn("[monday-briefing] web_search without results in this run — injecting a notice into section 4.");
    fullText = injectMacroSearchWarning(fullText, false);
  }

  await finalizeBriefing(fullText);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// CLI dispatch only when the file runs directly — not when the tests import
// it (same pattern as pending.ts).
const isMain = process.argv[1] != null && import.meta.filename === process.argv[1];
if (isMain) {
  const [cmd] = process.argv.slice(2);
  const commands: Record<string, () => Promise<void>> = {
    prepare: async () => {
      const { userPrompt } = await prepareBriefing();
      process.stdout.write(userPrompt + "\n");
    },
    finalize: async () => {
      const fullText = await readStdin();
      await finalizeBriefing(fullText);
    },
  };

  const fn =
    cmd != null
      ? commands[cmd]
      : async () => {
          // No subcommand = API mode, guarded by the same switch as the heartbeat
          // (ANALYST_PROVIDER): in handoff mode the Routine resolves the briefing
          // with prepare/finalize, and calling the API would be accidental spending.
          if (config.analyst.provider !== "api") {
            throw new Error(
              `ANALYST_PROVIDER="${config.analyst.provider}": API mode is disabled. ` +
                "Use monday-briefing:prepare / monday-briefing:finalize (Routine), " +
                "or run with ANALYST_PROVIDER=api as an escape hatch.",
            );
          }
          await runApiBriefing();
        };

  if (!fn) {
    throw new Error("Usage: monday-briefing.ts [prepare|finalize]");
  }
  // Fail fast when delivery is required but not configured, before any API
  // spend (the same check the heartbeat runs at startup).
  Promise.resolve()
    .then(() => {
      assertMailConfigured();
      return fn();
    })
    .catch((err) => {
      console.error("[monday-briefing] Error:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
