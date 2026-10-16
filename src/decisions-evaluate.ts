// Generates logs/decisions-evaluation.md: the cutoff criterion
// table (ADR-0009 §4) and what happened after each decision in the log
// (ADR-0006). No LLM. It is step 1 of the Monday Briefing: prepare puts the
// table in the prompt. Replaces outcomes.ts.
//
// It only writes that file: it does not touch the decision log, portfolio.md
// or the watchlist.
//
// Usage: npm run decisions:evaluate
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { loadEvaluationReport } from "./decisions-evaluation-run.js";
import { renderDecisionsEvaluation } from "./utils/decisions-evaluation-render.js";

async function main(): Promise<void> {
  const report = await loadEvaluationReport("[decisions-evaluate]");

  const outPath = join(config.paths.vaultProjectDir, "logs", "decisions-evaluation.md");
  await writeFile(outPath, renderDecisionsEvaluation(report), "utf8");
  console.log(`[decisions-evaluate] Saved to ${outPath}`);
}

main().catch((err) => {
  console.error("[decisions-evaluate] Error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
