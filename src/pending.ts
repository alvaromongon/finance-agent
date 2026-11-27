// CLI to read and record the signals HandoffAnalystProvider leaves in logs/pending/. The Claude Code Routine calls
// these commands through Bash after reasoning about the signal; recordPending() reuses, without duplicating, the same
// validation and writing index.ts uses for the "api" backend, so a signal answered by hand produces exactly the same
// log/email as if the API had answered it.
//
// Closing a pending escalation is not done here (#141): it is a `resolve` command dropped in inbox/ (ADR-0018), the
// only way to change the list. Recording the answer and closing the escalation are two things: the first writes the
// decision log and the email, the second the store.
import { validateRecommendation } from "./claude-analyst.js";
import { siloValue } from "./utils/sizing.js";
import { recordDecision } from "./decision.js";
import { dropStopProposals } from "./stop-proposals.js";
import { readEscalationsToDo } from "./inbox-escalations.js";
import { readPendingSignal, readWatchlistSkippingBadTickers } from "./vault-io.js";
import { ignoringLots, readPortfolio } from "./portfolio-store.js";
import { printable } from "./utils/printable.js";
import type { Signal } from "./types.js";

/** The id of an escalation from what the owner typed: its id, or its file name in `logs/pending/`. */
const idOf = (arg: string): string => (arg.endsWith(".md") ? arg.slice(0, -".md".length) : arg);

export async function listPending(): Promise<void> {
  const ids = await readEscalationsToDo();
  if (ids.length === 0) {
    console.log("No pending signals.");
    return;
  }
  for (const id of ids.sort()) console.log(id);
}

export async function showPending(arg: string): Promise<void> {
  if (!arg) {
    throw new Error("Usage: pending:show -- <id>");
  }
  const { content } = await readPendingSignal(`${idOf(arg)}.md`);
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
    readPortfolio(meta.currency).then(ignoringLots),
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
 * Validates and records the Recommendation for the escalation `arg`, as index.ts does for the "api" backend (shared via
 * decision.ts): blocked ticket -> log with blocked:true and no email; valid ticket -> log + sendAlert. It does not close
 * the escalation: the file stays in logs/pending/ and the escalation in the digest until a `resolve` command closes it,
 * and it says so. An escalation already closed, or already closed by a batch waiting in inbox/, is refused: it would
 * record the decision twice.
 */
export async function recordPending(arg: string, recommendationInput: unknown): Promise<void> {
  const id = idOf(arg);
  if (!(await readEscalationsToDo()).includes(id)) {
    throw new Error(
      `${printable(id)} is not a pending escalation to record: it does not exist in logs/pending/, a resolve command closed it, or one waits in inbox/ (see pending:list)`,
    );
  }
  const filename = `${id}.md`;
  const rec = validateRecommendation(recommendationInput);
  const signal = await buildSignal(filename);

  // The pending file name starts with the detection date (writePendingSignal).
  const proposal = await recordDecision(rec, signal, { logPrefix: "[pending] ", detectedOn: filename.slice(0, 10) });
  // A stop the engine proposes is a set_stop in inbox/, never a write of the state (#136).
  if (proposal) await dropStopProposals([proposal], "pending", undefined, "[pending] ");

  console.log(
    `Recorded: ${id}. Close it with a resolve command in inbox/ (command: resolve, id: ${id}, outcome: resolved); it stays in every digest until then.`,
  );
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
    record: async () => {
      if (!arg) throw new Error("Usage: pending:record -- <id>");
      const stdin = await readStdin();
      await recordPending(arg, JSON.parse(stdin));
    },
  };

  const fn = commands[cmd];
  if (!fn) {
    throw new Error("Usage: pending.ts <list|show|record> [id]");
  }
  fn().catch((err) => {
    console.error("[pending]", err);
    process.exitCode = 1;
  });
}
