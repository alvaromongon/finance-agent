// CLI of the inbox (#131, spec #124): `inbox:check` validates the batches in `inbox/` against the current
// portfolio and changes nothing. `inbox:ingest` (#132) will apply them.
import { readInbox } from "./inbox-store.js";
import { readBothPortfolios, requireReadable, type PortfolioRead } from "./portfolio-store.js";
import type { Currency, PortfolioSnapshot } from "./types.js";
import { volumeMismatches } from "./utils/lots-check.js";
import { checkFiles, renderIssues, renderWarnings } from "./utils/inbox-check.js";
import type { InboxState } from "./utils/inbox-handlers.js";

/**
 * The silo as the batches are checked against it: refused, naming what is wrong, unless it reads whole. What
 * `decision:record` refuses (`requireReadable`, then `assertLotsMatch`'s checks that need no decision log:
 * rows of `Lots` that do not read, a `Volume` that is not the sum of its lots) and the cells too large to
 * count, which read as 0: a state with a guessed cash would give the owner a wrong "clean".
 */
function requireWhole<C extends Currency>(read: PortfolioRead<C>): PortfolioSnapshot<C> {
  const portfolio = requireReadable(read);
  const problems = [...read.unreadableCells, ...volumeMismatches(portfolio)];
  if (problems.length > 0) {
    throw new Error(
      `${problems.join("\n")}\nFix portfolio.md by hand before checking the inbox (see docs/input-format.md)`,
    );
  }
  return portfolio;
}

/** The state the batches are checked against: each silo the portfolio has, read through the portfolio port. */
async function currentState(): Promise<InboxState> {
  const { EUR: eur, USD: usd } = await readBothPortfolios();
  return {
    ...(eur ? { EUR: requireWhole(eur) } : {}),
    ...(usd ? { USD: requireWhole(usd) } : {}),
  };
}

/** Checks the inbox and returns what to print and the exit code: 0 for a clean inbox, 1 for any error. */
export async function checkInbox(): Promise<{ lines: string[]; exitCode: number }> {
  const files = await readInbox();
  if (files.length === 0) return { lines: ["Inbox is empty: nothing to check."], exitCode: 0 };
  const checks = checkFiles(await currentState(), files);
  const problems = renderIssues(checks);
  // Warnings never change the exit code: a position without a stop is for the owner to know, not a rejected batch.
  const warnings = renderWarnings(checks);
  if (problems.length === 0) {
    return { lines: [`Inbox is clean: ${files.length} batch(es) would apply.`, ...warnings], exitCode: 0 };
  }
  const errors = checks.reduce((sum, c) => sum + c.issues.length, 0);
  const skipped = checks.reduce((sum, c) => sum + c.notChecked.length, 0);
  const bad = checks.filter((c) => c.issues.length > 0).length;
  const summary = `${errors} error(s) in ${bad} of ${files.length} batch(es)`;
  return {
    lines: [...problems, ...warnings, `${summary}${skipped > 0 ? `; ${skipped} command(s) not checked` : ""}.`],
    exitCode: 1,
  };
}

const isMain = process.argv[1] != null && import.meta.filename === process.argv[1];
if (isMain) {
  const [cmd] = process.argv.slice(2);
  if (cmd !== "check") {
    console.error("Usage: inbox.ts check");
    process.exitCode = 2;
  } else {
    checkInbox()
      .then(({ lines, exitCode }) => {
        for (const line of lines) (exitCode === 0 ? console.log : console.error)(line);
        process.exitCode = exitCode;
      })
      .catch((err) => {
        console.error("[inbox]", err);
        process.exitCode = 1;
      });
  }
}
