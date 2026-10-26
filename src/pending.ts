// CLI to read and resolve the signals HandoffAnalystProvider leaves in
// logs/pending/. The Claude Code Routine calls these
// commands through Bash after reasoning about the signal; resolvePending()
// reuses, without duplicating, the same validation and writing index.ts uses
// for the "api" backend, so a signal resolved by hand produces exactly the
// same log/email as if the API had resolved it.
import { validateRecommendation } from "./claude-analyst.js";
import { siloValue } from "./utils/sizing.js";
import { recordDecision } from "./decision.js";
import {
  listPendingFiles,
  readPendingSignal,
  deletePendingFile,
  readWatchlistSkippingBadTickers,
  readPortfolioIgnoringLots,
} from "./vault-io.js";
import type { Signal } from "./types.js";

export async function listPending(): Promise<void> {
  const files = await listPendingFiles();
  if (files.length === 0) {
    console.log("No pending signals.");
    return;
  }
  for (const f of files.sort()) console.log(f);
}

export async function showPending(filename: string): Promise<void> {
  if (!filename) {
    throw new Error("Usage: pending:show -- <file>");
  }
  const { content } = await readPendingSignal(filename);
  console.log(content);
}

/**
 * Rebuilds the real Signal from the pending file's frontmatter + the current
 * vault state (watchlist.md, portfolio.md) — not from the state when the
 * signal was detected, which may have changed.
 *
 * ADR-0007: The ticker may have no watchlist.md entry if the
 * signal came from an open position without an entry thesis — then `entry`
 * stays undefined and only the position needs to exist.
 */
async function buildSignal(filename: string): Promise<Signal> {
  const { meta } = await readPendingSignal(filename);
  const [watchlist, portfolio] = await Promise.all([
    readWatchlistSkippingBadTickers(meta.currency),
    readPortfolioIgnoringLots(meta.currency),
  ]);

  const entry = watchlist.find((e) => e.ticker === meta.ticker);
  const position = portfolio.positions.find((p) => p.ticker === meta.ticker);
  if (!entry && !position) {
    throw new Error(`${meta.ticker} is in neither watchlist.md nor portfolio.md (${meta.currency}) — cannot resolve`);
  }

  return {
    ticker: meta.ticker,
    currency: meta.currency,
    triggers: meta.triggers,
    price: meta.price,
    entry,
    position,
    cash: portfolio.cash,
    // The silo is valued at resolve time: the size is computed on the current state.
    siloValue: siloValue(portfolio),
    // Snapshot from the detection date (ADR-0006), not from resolve time.
    strength: meta.strength,
    benchmark: meta.benchmark,
    setup: meta.setup,
    conviction: meta.conviction,
  };
}

/**
 * Validates and records the resolved Recommendation for `filename`, as
 * index.ts does for the "api" backend (shared via decision.ts): blocked
 * ticket -> log with blocked:true and no email; valid ticket -> log +
 * sendAlert. Deletes the pending file in both cases (it is already in logs/,
 * it must not be processed again).
 */
export async function resolvePending(filename: string, recommendationInput: unknown): Promise<void> {
  const rec = validateRecommendation(recommendationInput);
  const signal = await buildSignal(filename);

  // The pending file name starts with the detection date (writePendingSignal).
  await recordDecision(rec, signal, { logPrefix: "[pending] ", detectedOn: filename.slice(0, 10) });

  await deletePendingFile(filename);
  console.log(`Resolved and deleted: ${filename}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// CLI dispatch only when the file runs directly (tsx src/pending.ts ...) —
// not when the tests import it. import.meta.filename (Node >= 20.11) compares
// file paths directly, without hand-building a file:// URL that might not
// match the real escaping of import.meta.url.
const isMain = process.argv[1] != null && import.meta.filename === process.argv[1];
if (isMain) {
  const [cmd, arg] = process.argv.slice(2);
  const commands: Record<string, () => Promise<void>> = {
    list: listPending,
    show: () => showPending(arg),
    resolve: async () => {
      if (!arg) throw new Error("Usage: pending:resolve -- <file>");
      const stdin = await readStdin();
      await resolvePending(arg, JSON.parse(stdin));
    },
  };

  const fn = commands[cmd];
  if (!fn) {
    throw new Error("Usage: pending.ts <list|show|resolve> [file]");
  }
  fn().catch((err) => {
    console.error("[pending]", err);
    process.exitCode = 1;
  });
}
