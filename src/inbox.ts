// CLI of the inbox (#131, spec #124): `inbox:check` validates the batches in `inbox/` against the current
// portfolio and changes nothing. `inbox:ingest` (#132) will apply them.
import { readInbox } from "./inbox-store.js";
import { readPortfolio, requireReadable } from "./portfolio-store.js";
import { checkFiles, renderIssues } from "./utils/inbox-check.js";
import type { InboxState } from "./utils/inbox-handlers.js";

/** The state the batches are checked against: both silos, read through the portfolio port. */
async function currentState(): Promise<InboxState> {
  const [eur, usd] = await Promise.all([readPortfolio("EUR"), readPortfolio("USD")]);
  return { EUR: requireReadable(eur), USD: requireReadable(usd) };
}

/** Checks the inbox and returns what to print and the exit code: 0 for a clean inbox, 1 for any error. */
export async function checkInbox(): Promise<{ lines: string[]; exitCode: number }> {
  const files = await readInbox();
  if (files.length === 0) return { lines: ["Inbox is empty: nothing to check."], exitCode: 0 };
  const checks = checkFiles(await currentState(), files);
  const problems = renderIssues(checks);
  if (problems.length === 0) {
    return { lines: [`Inbox is clean: ${files.length} batch(es) would apply.`], exitCode: 0 };
  }
  const bad = checks.filter((c) => c.issues.length > 0).length;
  return { lines: [...problems, `${problems.length} error(s) in ${bad} of ${files.length} batch(es).`], exitCode: 1 };
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
