// Reading/writing of the vault Markdown "brain".
import { messages } from "./i18n/index.js";
import { writeFile, readdir, mkdir, unlink, appendFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { config } from "./config.js";
import { validateDecision, type Decision, type ScreeningSelection } from "./decisions.js";
import { describeTicket } from "./utils/sizing.js";
import { describeConviction } from "./utils/conviction.js";
import { parseMarkdownNumber } from "./utils/parse.js";
import { parseLastLog, type LastLog } from "./utils/cooldown.js";
import {
  assertPortfolioSections,
  assertSchemaVersion,
  extractYamlBlock,
  extractFrontmatter,
  isBlockedLog,
  isPositionPlaceholder,
  parseCash,
  parseTableRows,
  parseTotalCash,
  parsePositions,
  parseScreeningLog,
  positionColumns,
  sectionRange,
  SCHEMA_VERSION,
  applyAddWatchlistEntry,
  applyRetireWatchlistEntry,
} from "./utils/vault-parser.js";
import {
  CONVICTION_POINTS,
  CONVICTIONS,
  CURRENCIES,
  MARKET_REGIMES,
  SETUP_PATTERNS,
  TREND_BIASES,
  TRIGGER_KINDS,
} from "./types.js";
import type {
  AssetClass,
  Benchmark,
  Conviction,
  ConvictionPoint,
  Currency,
  EngineConviction,
  EngineTicket,
  MarketRegime,
  PortfolioSnapshot,
  Recommendation,
  Setup,
  Signal,
  StrengthSnapshot,
  TrendBias,
  TriggerKind,
  WatchlistEntry,
} from "./types.js";

// Import and re-export the type from vault-parser (single source of truth)
import type { ScreeningLogRow as ScreeningLogEntry } from "./utils/vault-parser.js";
import { readTextFile } from "./utils/fs-text.js";
export type { ScreeningLogEntry };

/** Data directory, read on use: VAULT_PROJECT_DIR has no default. */
const projectDir = () => config.paths.vaultProjectDir;

/**
 * Reads a reasoning prompt from `routines/<name>.md`. There are no built-in
 * defaults: a missing prompt fails with the example to copy.
 */
export async function readRoutinePrompt(name: "monday-briefing" | "weekly-screening"): Promise<string> {
  const path = join(projectDir(), "routines", `${name}.md`);
  try {
    const prompt = await readTextFile(path);
    if (prompt.trim() !== "") return prompt;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  throw new Error(
    `routines/${name}.md not found or empty: copy examples/brain/routines/${name}.md into your brain and adapt it`,
  );
}

// ─── Watchlist ────────────────────────────────────────────────────────────────

/** Reads watchlist.md and returns the entries of the given currency. */
export async function readWatchlist(currency: Currency): Promise<WatchlistEntry[]> {
  const raw = await readTextFile(join(projectDir(), "watchlist.md"));
  assertSchemaVersion(raw, "watchlist.md");
  const block = extractYamlBlock(raw);
  const parsed = yaml.load(block) as { watchlist?: WatchlistEntry[] } | undefined;
  return (parsed?.watchlist ?? []).filter((e) => e.currency === currency);
}

// ─── Portfolio ────────────────────────────────────────────────────────────────

/**
 * Reads portfolio.md and warns if it has gone more than PORTFOLIO_STALE_DAYS
 * without a manual update. It does not block the run, it only warns.
 */
export async function readPortfolio(currency: Currency): Promise<PortfolioSnapshot> {
  const raw = await readTextFile(join(projectDir(), "portfolio.md"));
  assertSchemaVersion(raw, "portfolio.md");
  assertPortfolioSections(raw, currency);

  // Check staleness with the `last_manual_sync` frontmatter field.
  // js-yaml returns a Date when the timestamp is unquoted
  // (`last_manual_sync: 2026-08-27T20:46:00Z`) and a string when quoted: it is
  // normalized to ISO here so `syncedAt` is always what its type says.
  // Without this, any consumer treating it as a string breaks only with the
  // real portfolio, never with the quoted fixtures.
  const frontmatter = extractFrontmatter(raw);
  const rawSync = frontmatter?.last_manual_sync as string | Date | null | undefined;
  const lastSync = rawSync instanceof Date ? rawSync.toISOString() : rawSync;
  if (lastSync) {
    const diffDays = (Date.now() - new Date(lastSync).getTime()) / 86_400_000;
    if (diffDays > config.marketData.portfolioStaleDays) {
      console.warn(
        `[vault-io] WARNING: portfolio.md has not been updated for ${Math.floor(diffDays)} days.` +
          ` See the guide: routines/portfolio-sync.md`,
      );
    }
  } else {
    console.warn("[vault-io] portfolio.md has no last_manual_sync field. Update it by hand.");
  }

  // Parse the Markdown tables of the given currency's silo. Placeholder rows
  // ("—") and non-numeric values ("TBD") are safely ignored → empty snapshot
  // instead of an error.
  const totalCash = parseTotalCash(raw, currency);
  return {
    currency,
    cash: parseCash(raw, currency),
    ...(totalCash != null ? { totalCash } : {}),
    positions: parsePositions(raw, currency),
    syncedAt: lastSync ?? new Date().toISOString(),
  };
}

// ─── Portfolio auto-update ────────────────────────────────────────────────────

/**
 * Updates the `Current price` and `P/L` columns of the positions in portfolio.md.
 * It only touches rows whose ticker has a price available; it does not change
 * `last_manual_sync` or any other field of the file.
 */
export async function updatePortfolioPrices(currency: Currency, prices: Map<string, number>): Promise<void> {
  const filePath = join(projectDir(), "portfolio.md");
  const raw = await readTextFile(filePath).catch(() => null);
  if (!raw) return;
  assertSchemaVersion(raw, "portfolio.md");

  // Find the positions section and replace cell by cell; columns are read by
  // their header, as in parsePositions.
  const range = sectionRange(raw, currency, "Positions");
  if (!range) return;
  const { start: sectionStart, end: sectionEnd } = range;

  const section = raw.slice(sectionStart, sectionEnd);
  const header = parseTableRows(section)[0];
  if (!header) return;
  const col = positionColumns(header, currency);
  const updatedSection = section.replace(/^\|(.+)\|$/gm, (line) => {
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());

    // Skip header and separator
    if (isPositionPlaceholder(cells[col.ticker] ?? "")) return line;
    if (cells.every((c) => /^:?-+:?$/.test(c))) return line;

    const current = prices.get(cells[col.ticker]);
    if (current == null) return line; // ticker without a price: leave the row alone

    const avgPrice = parseMarkdownNumber(cells[col.avgPrice]);
    const volume = parseMarkdownNumber(cells[col.volume]);
    if (avgPrice == null || volume == null) return line;

    const pl = (current - avgPrice) * volume;
    cells[col.currentPrice] = fmtEU(current);
    cells[col.pl] = fmtEU(pl);

    return `| ${cells.join(" | ")} |`;
  });

  if (updatedSection === section) return; // nothing changed

  const updated = raw.slice(0, sectionStart) + updatedSection + raw.slice(sectionEnd);
  await writeFile(filePath, updated, "utf8");
  console.log(`[vault-io] portfolio.md: prices updated (${currency})`);
}

/** Formats a number European-style with 2 decimals (46,80 / 1.234,56). */
function fmtEU(n: number): string {
  return n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

/** Records a decision in logs/YYYY-MM-DD-<ticker>.md. */
export async function writeDecisionLog(
  rec: Recommendation,
  opts?: {
    blocked?: boolean;
    /** Ticket block codes. */
    reasons?: string[];
    price?: number;
    strength?: StrengthSnapshot;
    /** Engine ticket; absent on HOLD or if it could not be computed. */
    ticket?: EngineTicket | null;
    notes?: string[];
    /** Setup that fired the signal (ADR-0013). */
    setup?: Setup;
    /** Engine conviction; absent in risk signals. */
    conviction?: EngineConviction;
  },
): Promise<void> {
  const cur = rec.ticket.currency;
  const today = new Date().toISOString().slice(0, 10);
  const filename = `${today}-${rec.ticker.toLowerCase()}.md`;
  const path = join(projectDir(), "logs", filename);
  const m = messages();
  const t = m.decisionLog;

  const content = [
    `---`,
    `id: ${today.replace(/-/g, "")}-${rec.ticker.toLowerCase()}`,
    `title: "${rec.action} ${rec.ticker} — ${today}"`,
    `tags: [project-note, log]`,
    `status: active`,
    `created: ${today}`,
    ...(opts?.price != null ? [`price: ${opts.price}`] : []),
    // Read back by the cooldown (parseLastLog); the body is localized output.
    `triggers: [${rec.triggers.join(", ")}]`,
    ...(opts?.blocked ? [`blocked: true`] : []),
    `---`,
    ``,
    t.decisionTitle,
    ``,
    ...t.fieldHeader,
    `| Ticker | ${rec.ticker} |`,
    `| ${t.action} | ${rec.action} |`,
    ...(opts?.conviction ? [`| ${t.conviction} | ${describeConviction(opts.conviction, m)} |`] : []),
    ...(opts?.setup
      ? [`| ${t.setup} | ${t.setupValue(opts.setup.pattern, opts.setup.level, opts.setup.target)} |`]
      : []),
    `| ${t.triggers} | ${rec.triggers.join(", ")} |`,
    // Strength at decision time (ADR-0006), for whoever reads the log; what gets
    // measured is the copy in the decision log (ADR-0006). Rows are left out if
    // it could not be computed, instead of writing a placeholder.
    ...(opts?.strength
      ? [
          `| ${t.rangePosition} | ${opts.strength.rangePosition.toFixed(3)} |`,
          `| ${t.bias} | ${opts.strength.bias} |`,
          ...(opts.strength.atr14 != null ? [`| ATR14 | ${opts.strength.atr14.toFixed(2)} |`] : []),
        ]
      : []),
    ``,
    t.ticketTitle,
    ``,
    ...t.fieldHeader,
    `| ${t.direction} | ${rec.ticket.direction} |`,
    // Engine ticket. Without it (HOLD, or BUY without ATR) at least
    // the reference price remains.
    ...(opts?.ticket
      ? describeTicket(opts.ticket, m).map(([field, value]) => `| ${field} | ${value} |`)
      : [
          ...(opts?.price != null ? [`| ${t.referencePrice} | ${opts.price} ${cur} |`] : []),
          ...(rec.ticket.target != null ? [`| ${t.proposedTarget} | ${rec.ticket.target} ${cur} |`] : []),
        ]),
    ...(opts?.reasons && opts.reasons.length > 0 ? [`| ${t.block} | ${opts.reasons.join(", ")} |`] : []),
    ...(rec.assumptions && rec.assumptions.length > 0
      ? [``, t.assumptionsTitle, ``, ...rec.assumptions.map((a) => `- ${a}`)]
      : []),
    ...(opts?.notes && opts.notes.length > 0 ? [``, t.noticesTitle, ``, ...opts.notes.map((n) => `- ${n}`)] : []),
    ``,
    t.thesisTitle,
    ``,
    rec.thesis_summary,
  ].join("\n");

  await writeFile(path, content, "utf8");
}

/** Lists the logs/ files once, so the directory is not listed again for each ticker. */
export async function listLogFiles(): Promise<string[]> {
  return readdir(join(projectDir(), "logs")).catch(() => [] as string[]);
}

/**
 * Records a signal pending analysis in logs/pending/<date>-<ticker>.md
 * ("handoff" backend —). Unlike logs/, which already exists with
 * versioned content, logs/pending/ may not exist yet in the vault.
 * Returns the path relative to the project directory (for email/logs).
 */
export async function writePendingSignal(
  signal: Signal,
  opts: { systemPrompt: string; userPrompt: string; useWebSearch: boolean },
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const filename = `${today}-${signal.ticker.toLowerCase()}.md`;
  const dir = join(projectDir(), "logs", "pending");
  const relativePath = join("logs", "pending", filename);

  const content = [
    `---`,
    `id: ${today.replace(/-/g, "")}-${signal.ticker.toLowerCase()}-pending`,
    `title: "Signal pending analysis — ${signal.ticker} — ${today}"`,
    `tags: [project-note, log, pending]`,
    `status: active`,
    `created: ${today}`,
    `ticker: ${signal.ticker}`,
    `currency: ${signal.currency}`,
    `price: ${signal.price}`,
    `triggers: [${signal.triggers.join(", ")}]`,
    // Strength when the signal was detected (ADR-0006). It must travel in the
    // pending file: when the Routine resolves it, buildSignal rebuilds the rest
    // of the Signal from the current vault state, but this snapshot is from
    // the detection date and cannot be recomputed later.
    ...(signal.strength
      ? [
          `range_position: ${signal.strength.rangePosition.toFixed(3)}`,
          `bias: ${signal.strength.bias}`,
          ...(signal.strength.atr14 != null ? [`atr14: ${signal.strength.atr14.toFixed(4)}`] : []),
          ...(signal.strength.levels ? [`target_levels: [${signal.strength.levels.join(", ")}]`] : []),
        ]
      : []),
    // Silo benchmark and its regime on the detection date,
    // for the same reason as strength: by resolve time it is no longer that day's.
    ...benchmarkFrontmatter(signal.benchmark),
    // Setup of the detection date (ADR-0013): it goes to the decision log on resolve.
    ...(signal.setup
      ? [
          `setup_pattern: ${signal.setup.pattern}`,
          `setup_date: ${signal.setup.date}`,
          `setup_level: ${signal.setup.level}`,
          `setup_target: ${signal.setup.target}`,
        ]
      : []),
    // Engine conviction on the setup day: it cannot be recomputed on resolve.
    ...(signal.conviction
      ? [`conviction: ${signal.conviction.conviction}`, `conviction_points: [${signal.conviction.points.join(", ")}]`]
      : []),
    `use_web_search: ${opts.useWebSearch}`,
    `---`,
    ``,
    // Queue file read by the Routine, not by the owner: fixed in English like the prompts.
    `> Resolve with: \`npm run pending:show -- ${filename}\` and \`npm run pending:resolve -- ${filename}\``,
    `> (see README › Handoff mode for these commands and the agent session that runs them)`,
    ``,
    `## System prompt`,
    ``,
    opts.systemPrompt,
    ``,
    `## User prompt`,
    ``,
    opts.userPrompt,
  ].join("\n");

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), content, "utf8");
  return relativePath;
}

/** Metadata of a pending signal, read from the frontmatter of logs/pending/*.md. */
export interface PendingSignalMeta {
  ticker: string;
  currency: Currency;
  price: number;
  triggers: TriggerKind[];
  /** Absent in pending files written before 2026-08-03 or without history. */
  strength?: StrengthSnapshot;
  /** Absent in pending files older than the decision log or if the price failed. */
  benchmark?: Benchmark;
  /** Confirmed setup that fired the signal (ADR-0013); absent in risk signals. */
  setup?: Setup;
  /** Engine conviction; absent in risk signals and older pending files. */
  conviction?: EngineConviction;
}

/** Reads `conviction`/`conviction_points`; `undefined` if missing or corrupt. */
function parseConvictionMeta(frontmatter: Record<string, unknown>): EngineConviction | undefined {
  const { conviction, conviction_points: points } = frontmatter;
  if (!CONVICTIONS.includes(conviction as Conviction)) return undefined;
  if (!Array.isArray(points) || !points.every((p) => CONVICTION_POINTS.includes(p as ConvictionPoint)))
    return undefined;
  return { conviction: conviction as Conviction, points: points as ConvictionPoint[] };
}

/** Reads `setup_*` from the frontmatter; `undefined` if missing or incomplete. */
function parseSetupMeta(frontmatter: Record<string, unknown>): Setup | undefined {
  const { setup_pattern: pattern, setup_date: date, setup_level: level, setup_target: target } = frontmatter;
  if (!SETUP_PATTERNS.includes(pattern as Setup["pattern"])) return undefined;
  const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!positive(level) || !positive(target)) return undefined;
  // js-yaml reads an unquoted date as a Date.
  const day = date instanceof Date ? date.toISOString().slice(0, 10) : typeof date === "string" ? date : undefined;
  if (!day) return undefined;
  return { pattern: pattern as Setup["pattern"], state: "triggered", date: day, level, target };
}

/**
 * Reads `range_position`/`bias`/`atr14` from a pending file's frontmatter.
 * Optional fields: a pending file without them (or with corrupt values) returns
 * `undefined` instead of breaking the resolution — instrumentation is an
 * extra, not a requirement for recording the decision.
 */
function parseStrengthMeta(frontmatter: Record<string, unknown>): StrengthSnapshot | undefined {
  const { range_position: rangePosition, bias, atr14, target_levels: levels } = frontmatter;
  if (typeof rangePosition !== "number" || !Number.isFinite(rangePosition)) return undefined;
  if (typeof bias !== "string" || !TREND_BIASES.includes(bias as TrendBias)) return undefined;
  const validAtr = typeof atr14 === "number" && Number.isFinite(atr14) && atr14 > 0;
  // Levels to anchor the target: without them a BUY is blocked, never miscalculated.
  const validLevels =
    Array.isArray(levels) && levels.every((l) => typeof l === "number" && Number.isFinite(l) && l > 0);
  return {
    rangePosition,
    bias: bias as TrendBias,
    ...(validAtr ? { atr14 } : {}),
    ...(validLevels ? { levels: levels as number[] } : {}),
  };
}

/** `benchmark_*` frontmatter lines; empty without a benchmark. */
function benchmarkFrontmatter(b: Benchmark | undefined): string[] {
  if (!b) return [];
  return [
    `benchmark_ticker: ${b.ticker}`,
    `benchmark_price: ${b.price}`,
    ...(b.regime ? [`benchmark_regime: ${b.regime}`] : []),
  ];
}

/** Reads `benchmark_ticker`/`benchmark_price`/`benchmark_regime`. Optional, as tolerant as strength. */
function parseBenchmarkMeta(frontmatter: Record<string, unknown>): Benchmark | undefined {
  const { benchmark_ticker: ticker, benchmark_price: price, benchmark_regime: regime } = frontmatter;
  if (typeof ticker !== "string" || ticker.trim() === "") return undefined;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return undefined;
  return MARKET_REGIMES.includes(regime as MarketRegime)
    ? { ticker, price, regime: regime as MarketRegime }
    : { ticker, price };
}

// Name generated by writePendingSignal: <YYYY-MM-DD>-<lowercase-ticker>.md.
// Validating against this pattern before joining with projectDir() stops a
// filename with "../" from escaping logs/pending/ (path traversal on read or delete).
const PENDING_FILENAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9.-]+\.md$/;

/** Resolves a logs/pending/ filename, checking it does not escape the directory. */
function pendingFilePath(filename: string): string {
  if (!PENDING_FILENAME_RE.test(filename)) {
    throw new Error(`Invalid pending file name: ${filename}`);
  }
  return join(projectDir(), "logs", "pending", filename);
}

/** Lists the .md files in logs/pending/ (empty if the directory does not exist yet). */
export async function listPendingFiles(): Promise<string[]> {
  const files = await readdir(join(projectDir(), "logs", "pending")).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith(".md"));
}

/**
 * Reads logs/pending/<filename>: returns the full content (for
 * `pending:show`) and the parsed frontmatter (for `pending:resolve`, which
 * rebuilds the real Signal from it instead of trusting what the caller
 * repeats). It validates the frontmatter — a corrupt pending file must not
 * propagate a silent NaN/undefined down to validateTicket.
 */
export async function readPendingSignal(filename: string): Promise<{ meta: PendingSignalMeta; content: string }> {
  const path = pendingFilePath(filename);
  const content = await readTextFile(path);
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    throw new Error(`logs/pending/${filename} has no frontmatter`);
  }

  const errors: string[] = [];
  const { ticker, currency, price, triggers } = frontmatter;

  if (typeof ticker !== "string" || ticker.trim() === "") {
    errors.push(`ticker must be a non-empty string; got: ${JSON.stringify(ticker)}`);
  }
  if (typeof currency !== "string" || !CURRENCIES.includes(currency as Currency)) {
    errors.push(`currency must be one of [${CURRENCIES.join(", ")}]; got: ${JSON.stringify(currency)}`);
  }
  if (typeof price !== "number" || !Number.isFinite(price)) {
    errors.push(`price must be a number; got: ${JSON.stringify(price)}`);
  }
  if (!Array.isArray(triggers) || triggers.some((t) => !TRIGGER_KINDS.includes(t as TriggerKind))) {
    errors.push(`triggers must be an array of [${TRIGGER_KINDS.join(", ")}]; got: ${JSON.stringify(triggers)}`);
  }
  if (errors.length > 0) {
    throw new Error(`logs/pending/${filename} has an invalid frontmatter:\n- ${errors.join("\n- ")}`);
  }

  return {
    meta: {
      ticker: ticker as string,
      currency: currency as Currency,
      price: price as number,
      triggers: triggers as TriggerKind[],
      strength: parseStrengthMeta(frontmatter),
      benchmark: parseBenchmarkMeta(frontmatter),
      setup: parseSetupMeta(frontmatter),
      conviction: parseConvictionMeta(frontmatter),
    },
    content,
  };
}

/** Deletes a logs/pending/ file once resolved. */
export async function deletePendingFile(filename: string): Promise<void> {
  await unlink(pendingFilePath(filename));
}

/**
 * Returns price and triggers of a ticker's latest log (any date), ignoring
 * those marked `blocked: true` — a ticket blocked by validateTicket must not
 * interfere with the re-analysis cooldown (relies on the blocked-log
 * hygiene).
 *
 * `files` is optional: if several tickers are looked up in the same run (e.g.
 * the escalation loop in index.ts), pass it precomputed with listLogFiles()
 * so the directory is not listed on every call.
 */
export async function getLastLogForTicker(ticker: string, files?: string[]): Promise<LastLog | null> {
  const dir = join(projectDir(), "logs");
  const allFiles = files ?? (await listLogFiles());
  const suffix = `-${ticker.toLowerCase()}.md`;
  const matches = allFiles
    .filter((f) => f.endsWith(suffix))
    .sort()
    .reverse();

  for (const file of matches) {
    const content = await readTextFile(join(dir, file)).catch(() => null);
    if (!content || isBlockedLog(content)) continue;
    const parsed = parseLastLog(content);
    if (parsed) return parsed;
  }

  return null;
}

// ─── Alerts already sent by the heartbeat ───────────────────────
//
// One file per currency (EUR and USD runs commit separately, so they never
// clash) with the keys of the alerts sent TODAY. It only keeps the current
// day: another day reads as empty and is rewritten, so it does not grow.

const heartbeatSentPath = (currency: Currency) =>
  join(projectDir(), "logs", `heartbeat-sent-${currency.toLowerCase()}.json`);

/** Keys of the digest alerts already sent on `date` in `currency`; empty if the file is from another day. */
export async function readHeartbeatSent(currency: Currency, date: string): Promise<Set<string>> {
  const raw = await readTextFile(heartbeatSentPath(currency)).catch(() => "");
  try {
    const state = JSON.parse(raw) as { date?: unknown; keys?: unknown };
    if (state.date !== date || !Array.isArray(state.keys)) return new Set();
    return new Set(state.keys.filter((k): k is string => typeof k === "string"));
  } catch {
    // No file or corrupt (e.g. a conflict resolved by hand): at worst an alert is repeated.
    return new Set();
  }
}

export async function writeHeartbeatSent(currency: Currency, date: string, keys: Iterable<string>): Promise<void> {
  await mkdir(join(projectDir(), "logs"), { recursive: true });
  await writeFile(
    heartbeatSentPath(currency),
    JSON.stringify({ date, keys: [...new Set(keys)] }, null, 2) + "\n",
    "utf8",
  );
}

// ─── Decision log (ADR-0006) ───────────────────────────────────────

const decisionsPath = () => join(projectDir(), "logs", "decisions.jsonl");

/**
 * Appends decisions to logs/decisions.jsonl, one JSON line each. It validates
 * all of them before writing any: a batch with one bad line does not leave
 * the log half-written.
 */
export async function appendDecisions(decisions: Decision[]): Promise<void> {
  if (decisions.length === 0) return;
  const lines = decisions.map((d) => JSON.stringify(validateDecision(d))).join("\n") + "\n";
  await mkdir(join(projectDir(), "logs"), { recursive: true });
  await appendFile(decisionsPath(), lines, "utf8");
}

/**
 * Reads the whole log, in write order. A line that does not validate (e.g.
 * after resolving a git conflict by hand) is ignored with a warning instead of
 * preventing new decisions from being recorded.
 */
export async function readDecisions(): Promise<Decision[]> {
  return parseDecisionLines(await readTextFile(decisionsPath()).catch(() => ""), "logs/decisions.jsonl");
}

/** Closed quarters of the log (ADR-0006, "Retention"), if there is an archive. */
const decisionArchiveDir = () => config.paths.decisionsArchiveDir();

/**
 * Full log for measuring long periods: the archived quarters
 * (`decisions-AAAA-TN.jsonl`, in order) and then the live file. A decision
 * that appears in both (same id) counts once.
 */
export async function readDecisionHistory(archiveDir: string | undefined = decisionArchiveDir()): Promise<Decision[]> {
  const archived: Decision[] = [];
  if (archiveDir) {
    const files = (await readdir(archiveDir).catch(() => [] as string[]))
      .filter((f) => /^decisions-.+\.jsonl$/.test(f))
      .sort();
    for (const file of files) {
      archived.push(...parseDecisionLines(await readTextFile(join(archiveDir, file)), file));
    }
  }
  const seen = new Set<string>();
  return [...archived, ...(await readDecisions())].filter((d) => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
}

function parseDecisionLines(raw: string, source: string): Decision[] {
  const decisions: Decision[] = [];
  raw.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    try {
      decisions.push(validateDecision(JSON.parse(line)));
    } catch (err) {
      console.warn(`[vault-io] ${source}, line ${i + 1} ignored: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return decisions;
}

/** `account_env` from the portfolio.md frontmatter (`demo` | `real`); `undefined` if missing. */
export async function readAccountEnv(): Promise<string | undefined> {
  const raw = await readTextFile(join(projectDir(), "portfolio.md")).catch(() => "");
  const env = extractFrontmatter(raw)?.account_env;
  return typeof env === "string" ? env : undefined;
}

/**
 * `version` from the strategies/base.md frontmatter (ADR-0009 §5). Without it no
 * decision is recorded: a decision without a rules version cannot be
 * attributed to any system when measured.
 */
export async function readRulesVersion(): Promise<string> {
  const raw = await readTextFile(join(projectDir(), "strategies", "base.md")).catch(() => "");
  const version = extractFrontmatter(raw)?.version;
  if (typeof version === "number" || (typeof version === "string" && version.trim() !== "")) {
    return String(version);
  }
  throw new Error(
    "strategies/base.md has no `version` in its frontmatter: the decision cannot be recorded (ADR-0009 §5)",
  );
}

// ─── Watchlist — writing ──────────────────────────────────────────────────────

/** Reads all the watchlist.md tickers regardless of currency. */
export async function readAllWatchlistTickers(): Promise<string[]> {
  const raw = await readTextFile(join(projectDir(), "watchlist.md"));
  assertSchemaVersion(raw, "watchlist.md");
  const block = extractYamlBlock(raw);
  const parsed = yaml.load(block) as { watchlist?: WatchlistEntry[] } | undefined;
  return (parsed?.watchlist ?? []).map((e) => e.ticker);
}

/** Adds an entry to watchlist.md (in the existing YAML block). */
export async function addWatchlistEntry(entry: WatchlistEntry): Promise<void> {
  const filePath = join(projectDir(), "watchlist.md");
  const raw = await readTextFile(filePath);
  assertSchemaVersion(raw, "watchlist.md");
  const updated = applyAddWatchlistEntry(raw, entry);
  if (updated === raw) return; // already there
  await writeFile(filePath, updated, "utf8");
  console.log(`[vault-io] watchlist.md: added ${entry.ticker}`);
}

/**
 * Date each entry joined the watchlist: the `created` of its thesis
 * (`thesis_link`). Without a thesis or a date, the entry is left out.
 */
export async function readWatchlistAddedOn(entries: readonly WatchlistEntry[]): Promise<Map<string, string>> {
  const addedOn = new Map<string, string>();
  for (const entry of entries) {
    const slug = /\[\[(tesis-[^\]|]+)/.exec(entry.thesis_link ?? "")?.[1];
    if (!slug) continue;
    const raw = await readTextFile(join(projectDir(), "tesis", `${slug}.md`)).catch(() => "");
    if (!raw) continue;
    assertSchemaVersion(raw, `tesis/${slug}.md`);
    const created = extractFrontmatter(raw)?.created;
    // js-yaml reads an unquoted date as a Date.
    const date =
      created instanceof Date ? created.toISOString().slice(0, 10) : typeof created === "string" ? created : null;
    if (date) addedOn.set(entry.ticker, date);
  }
  return addedOn;
}

/**
 * Removes a ticker from watchlist.md (drops it from the YAML block) and
 * archives its thesis note if there is one. `log` lets screening:prepare send
 * progress to stderr: its stdout is the file list the Routine reads.
 */
export async function retireWatchlistEntry(
  ticker: string,
  reason: string,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const filePath = join(projectDir(), "watchlist.md");
  const raw = await readTextFile(filePath);
  assertSchemaVersion(raw, "watchlist.md");
  const updated = applyRetireWatchlistEntry(raw, ticker);
  await writeFile(filePath, updated, "utf8");
  log(`[vault-io] watchlist.md: removed ${ticker}`);

  // Archive the thesis if it exists
  const slug = ticker.toLowerCase().replace(/\./g, "");
  const thesisCandidates = [`tesis-${ticker.toLowerCase()}.md`, `tesis-${slug}.md`];
  for (const name of thesisCandidates) {
    const tPath = join(projectDir(), "tesis", name);
    try {
      const tRaw = await readTextFile(tPath);
      const archived = tRaw
        .replace(/^status:\s*.+$/m, "status: archived")
        .replace(/^(---\n[\s\S]*?)(---)/m, (_: string, fm: string, end: string) => {
          const hasArchiveReason = fm.includes("archive_reason:");
          if (!hasArchiveReason) {
            return `${fm}archive_reason: "${reason.replace(/"/g, "'").slice(0, 120)}"\n${end}`;
          }
          return `${fm}${end}`;
        });
      await writeFile(tPath, archived, "utf8");
      log(`[vault-io] ${name}: archived`);
      break;
    } catch {
      // no thesis with that name, try the next one
    }
  }
}

// ─── Screening log ────────────────────────────────────────────────────────────

/** Reads the screening history from screening-log.md. */
export async function readScreeningLog(): Promise<ScreeningLogEntry[]> {
  const raw = await readTextFile(join(projectDir(), "screening-log.md")).catch(() => null);
  return raw == null ? [] : parseScreeningLog(raw);
}

/** Appends rows at the end of the table in screening-log.md. */
export async function appendScreeningLogEntries(newEntries: ScreeningLogEntry[]): Promise<void> {
  if (newEntries.length === 0) return;
  const filePath = join(projectDir(), "screening-log.md");
  // Without a file it is created with the v1 format header (docs/input-format.md).
  let raw = await readTextFile(filePath).catch(() => null);
  raw ??= `---\nschema_version: ${SCHEMA_VERSION}\n---\n\n| Ticker | Name | Index | Date | Result | Summary | Next review |\n|---|---|---|---|---|---|---|`;
  assertSchemaVersion(raw, "screening-log.md");

  const rows = newEntries
    .map((e) => `| ${e.ticker} | ${e.name} | ${e.index} | ${e.date} | ${e.result} | ${e.summary} | ${e.nextReview} |`)
    .join("\n");

  raw = raw.trimEnd() + "\n" + rows + "\n";
  await writeFile(filePath, raw, "utf8");
  console.log(`[vault-io] screening-log.md: added ${newEntries.length} entries`);
}

// ─── Pending screening candidates (handoff backend) ───────────────
//
// Mirror of logs/pending/ for the Weekly Screening: screening:prepare leaves
// one file per candidate in logs/pending-screening/ and the Routine resolves
// it with screening:resolve. The results of each resolve accumulate in
// results.jsonl in the same directory so that screening:summarize composes
// the run's aggregated email at the end.

const screeningPendingDir = () => join(projectDir(), "logs", "pending-screening");
const SCREENING_RESULTS_FILENAME = "results.jsonl";
/** How prepare picked the run's candidates (ADR-0012), for the summarize email. */
const SCREENING_RUN_FILENAME = "run.json";

/** Metadata of a candidate, read from the frontmatter of logs/pending-screening/*.md. */
export interface ScreeningCandidateMeta extends ScreeningSelection {
  ticker: string;
  name: string;
  market: string;
  currency: Currency;
  asset_class: AssetClass;
  price: number;
  /** Technical snapshot and silo benchmark on the prepare date, for the decision log. */
  strength?: StrengthSnapshot;
  benchmark?: Benchmark;
  /** Conviction rubric: place in the silo's top fraction. */
  topQuintile: boolean;
  /** Best net R:R of the setups current at prepare; absent without a setup. */
  rewardRisk?: number;
  /** Setups current at prepare, one line per setup (describeSetup). */
  setups: string[];
}

const ASSET_CLASSES: readonly AssetClass[] = ["equity", "commodity", "etf"];

/** Resolves a logs/pending-screening/ filename, checking it does not escape the directory. */
function screeningCandidatePath(filename: string): string {
  if (!PENDING_FILENAME_RE.test(filename)) {
    throw new Error(`Invalid candidate file name: ${filename}`);
  }
  return join(screeningPendingDir(), filename);
}

/**
 * Writes a candidate's context file in logs/pending-screening/.
 * The frontmatter carries everything screening:resolve needs to work offline
 * (asset identity, price and technical snapshot); the body carries the
 * technical data (for the thesis note) and the full prompt (system + user)
 * the Routine must reason about — the same the API would see.
 * Returns the name of the created file.
 */
export async function writeScreeningCandidate(
  meta: ScreeningCandidateMeta,
  opts: { systemPrompt: string; userPrompt: string; technicalsText: string },
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const filename = `${today}-${meta.ticker.toLowerCase()}.md`;

  const content = [
    `---`,
    `id: ${today.replace(/-/g, "")}-${meta.ticker.toLowerCase().replace(/\./g, "")}-screening`,
    `title: "Screening candidate — ${meta.ticker} — ${today}"`,
    `tags: [project-note, log, pending-screening]`,
    `status: active`,
    `created: ${today}`,
    `ticker: ${meta.ticker}`,
    `name: "${meta.name}"`,
    `market: "${meta.market}"`,
    `currency: ${meta.currency}`,
    `asset_class: ${meta.asset_class}`,
    `price: ${meta.price}`,
    ...(meta.strength
      ? [
          `range_position: ${meta.strength.rangePosition.toFixed(3)}`,
          `bias: ${meta.strength.bias}`,
          ...(meta.strength.atr14 != null ? [`atr14: ${meta.strength.atr14.toFixed(4)}`] : []),
        ]
      : []),
    ...benchmarkFrontmatter(meta.benchmark),
    ...(meta.rank != null ? [`rank: ${meta.rank}`] : []),
    ...(meta.score != null ? [`score: ${meta.score}`] : []),
    ...(meta.exploration ? [`exploration: true`] : []),
    `top_quintile: ${meta.topQuintile}`,
    ...(meta.rewardRisk != null ? [`reward_risk: ${meta.rewardRisk}`] : []),
    ...(meta.setups.length > 0 ? ["setups:", ...meta.setups.map((s) => `  - ${JSON.stringify(s)}`)] : []),
    `---`,
    ``,
    // Queue file read by the Routine; `## Technicals` is read back by screening:resolve.
    `> Resolve with: evaluation JSON on stdin to \`npm run screening:resolve -- ${filename}\``,
    `> (when every candidate is done, \`npm run screening:summarize\` sends the run's email)`,
    ``,
    `## Technicals`,
    ``,
    "```",
    opts.technicalsText,
    "```",
    ``,
    `## System prompt`,
    ``,
    opts.systemPrompt,
    ``,
    `## User prompt`,
    ``,
    opts.userPrompt,
  ].join("\n");

  await mkdir(screeningPendingDir(), { recursive: true });
  await writeFile(join(screeningPendingDir(), filename), content, "utf8");
  return filename;
}

/** Lists the .md files in logs/pending-screening/ (empty if it does not exist yet). */
export async function listScreeningCandidateFiles(): Promise<string[]> {
  const files = await readdir(screeningPendingDir()).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith(".md")).sort();
}

/**
 * Reads logs/pending-screening/<filename>, validating the frontmatter — a
 * corrupt file must fail here, not propagate NaN/undefined down to
 * watchlist.md or screening-log.md (same principle as readPendingSignal).
 */
export async function readScreeningCandidate(
  filename: string,
): Promise<{ meta: ScreeningCandidateMeta; content: string }> {
  const path = screeningCandidatePath(filename);
  const content = await readTextFile(path);
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    throw new Error(`logs/pending-screening/${filename} has no frontmatter`);
  }

  const errors: string[] = [];
  const str = (field: string): string => {
    const v = frontmatter[field];
    if (typeof v !== "string" || v.trim() === "") {
      errors.push(`${field} must be a non-empty string; got: ${JSON.stringify(v)}`);
    }
    return v as string;
  };
  const num = (field: string): number => {
    const v = frontmatter[field];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`${field} must be a number; got: ${JSON.stringify(v)}`);
    }
    return v as number;
  };

  const meta: ScreeningCandidateMeta = {
    ticker: str("ticker"),
    name: str("name"),
    market: str("market"),
    currency: str("currency") as Currency,
    asset_class: str("asset_class") as AssetClass,
    price: num("price"),
    strength: parseStrengthMeta(frontmatter),
    benchmark: parseBenchmarkMeta(frontmatter),
    rank: frontmatter.rank != null ? num("rank") : undefined,
    score: frontmatter.score != null ? num("score") : undefined,
    exploration: frontmatter.exploration === true ? true : undefined,
    topQuintile: frontmatter.top_quintile === true,
    rewardRisk: frontmatter.reward_risk != null ? num("reward_risk") : undefined,
    setups: Array.isArray(frontmatter.setups) ? frontmatter.setups.map(String) : [],
  };
  if (typeof frontmatter.currency === "string" && !CURRENCIES.includes(frontmatter.currency as Currency)) {
    errors.push(`currency must be one of [${CURRENCIES.join(", ")}]; got: ${JSON.stringify(frontmatter.currency)}`);
  }
  if (typeof frontmatter.asset_class === "string" && !ASSET_CLASSES.includes(frontmatter.asset_class as AssetClass)) {
    errors.push(
      `asset_class must be one of [${ASSET_CLASSES.join(", ")}]; got: ${JSON.stringify(frontmatter.asset_class)}`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`logs/pending-screening/${filename} has an invalid frontmatter:\n- ${errors.join("\n- ")}`);
  }

  return { meta, content };
}

/** Deletes a logs/pending-screening/ file once resolved. */
export async function deleteScreeningCandidateFile(filename: string): Promise<void> {
  await unlink(screeningCandidatePath(filename));
}

/** Appends a resolve result to results.jsonl (one JSON line per candidate). */
export async function appendScreeningRunResult(result: unknown): Promise<void> {
  await mkdir(screeningPendingDir(), { recursive: true });
  const path = join(screeningPendingDir(), SCREENING_RESULTS_FILENAME);
  const existing = await readTextFile(path).catch(() => "");
  await writeFile(path, existing + JSON.stringify(result) + "\n", "utf8");
}

/** Reads the run's accumulated results (empty if there are none yet). */
export async function readScreeningRunResults(): Promise<unknown[]> {
  const path = join(screeningPendingDir(), SCREENING_RESULTS_FILENAME);
  const raw = await readTextFile(path).catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

/** Stores how prepare picked the candidates; each prepare overwrites it. */
export async function writeScreeningRunSelection(selection: unknown): Promise<void> {
  await mkdir(screeningPendingDir(), { recursive: true });
  await writeFile(
    join(screeningPendingDir(), SCREENING_RUN_FILENAME),
    JSON.stringify(selection, null, 2) + "\n",
    "utf8",
  );
}

/** Reads what prepare stored; null if nothing (run older than run.json or already closed). */
export async function readScreeningRunSelection(): Promise<unknown> {
  const raw = await readTextFile(join(screeningPendingDir(), SCREENING_RUN_FILENAME)).catch(() => null);
  return raw == null ? null : (JSON.parse(raw) as unknown);
}

/** Deletes results.jsonl and run.json when closing the run (after sending the aggregated email). */
export async function deleteScreeningRunResults(): Promise<void> {
  await Promise.all(
    [SCREENING_RESULTS_FILENAME, SCREENING_RUN_FILENAME].map((f) =>
      unlink(join(screeningPendingDir(), f)).catch(() => undefined),
    ),
  );
}

// ─── Email outbox ("outbox" transport) ────────────────────────────
//
// Routines cloud environments cannot open SMTP (the egress proxy only tunnels
// port 443), so with MAIL_TRANSPORT=outbox the mailer persists each email as
// JSON in logs/outbox/. The file is committed with the rest of the run and
// the finance-agent-email-relay workflow sends it from GitHub Actions
// (outbox:send), deleting it only if sending succeeded — same lifecycle as
// logs/pending/ (deleted once resolved; the content lives on in the decision
// logs / screening-log).

export interface OutboxMessage {
  subject: string;
  /** Markdown body; the HTML is regenerated on send (markdownToEmailHtml). */
  body: string;
  /** Email origin ("alert", "summary", …) — informational only. */
  source: string;
  /** Enqueue time, ISO UTC. */
  created: string;
}

const outboxDir = () => join(projectDir(), "logs", "outbox");

// Name generated by writeOutboxMessage: <YYYYMMDD>T<HHMMSS>-<mmm>Z-<slug>.json.
// As with PENDING_FILENAME_RE: validating before joining with projectDir() stops
// a filename with "../" from escaping logs/outbox/.
const OUTBOX_FILENAME_RE = /^\d{8}T\d{6}-\d{3}Z-[a-z0-9.-]+\.json$/;

function outboxFilePath(filename: string): string {
  if (!OUTBOX_FILENAME_RE.test(filename)) {
    throw new Error(`Invalid outbox file name: ${filename}`);
  }
  return join(outboxDir(), filename);
}

/**
 * Enqueues an email in logs/outbox/. The millisecond timestamp avoids
 * realistic collisions and makes lexicographic order chronological.
 * Returns the path relative to the project directory (for logs).
 */
export async function writeOutboxMessage(msg: Omit<OutboxMessage, "created">): Promise<string> {
  const now = new Date().toISOString(); // 2026-07-18T12:34:56.789Z
  const stamp = now.replace(/[-:]/g, "").replace(".", "-"); // 20260718T123456-789Z
  const slug =
    msg.subject
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "email";
  const filename = `${stamp}-${slug}.json`;

  const message: OutboxMessage = { ...msg, created: now };
  await mkdir(outboxDir(), { recursive: true });
  await writeFile(outboxFilePath(filename), JSON.stringify(message, null, 2) + "\n", "utf8");
  // POSIX separator on purpose: it is a "repo" relative path (logs, messages,
  // Markdown references), not a filesystem path, and join() would return it
  // with backslashes on Windows.
  return ["logs", "outbox", filename].join("/");
}

/** Lists the .json files in logs/outbox/ in chronological order (empty if it does not exist). */
export async function listOutboxFiles(): Promise<string[]> {
  const files = await readdir(outboxDir()).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith(".json")).sort();
}

/** Reads and validates an outbox message — a malformed one must fail here, not be half-sent. */
export async function readOutboxMessage(filename: string): Promise<OutboxMessage> {
  const raw = await readTextFile(outboxFilePath(filename));
  const parsed = JSON.parse(raw) as Partial<OutboxMessage>;

  const errors: string[] = [];
  for (const field of ["subject", "body", "source", "created"] as const) {
    if (typeof parsed[field] !== "string" || parsed[field].trim() === "") {
      errors.push(`${field} must be a non-empty string; got: ${JSON.stringify(parsed[field])}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`logs/outbox/${filename} malformed:\n- ${errors.join("\n- ")}`);
  }
  return parsed as OutboxMessage;
}

/** Deletes an outbox message once sent successfully. */
export async function deleteOutboxFile(filename: string): Promise<void> {
  await unlink(outboxFilePath(filename));
}
