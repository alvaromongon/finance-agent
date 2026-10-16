// Generates logs/decisions-evaluation.svg: SLI 1 (proposal quality, ADR-0014)
// as a self-contained chart, next to the evaluation report. It takes the same
// evaluation as decisions:evaluate (decisions-evaluation-run.ts), so plan R is
// not computed a second time. No LLM. It only writes that file.
//
// Usage: npm run decisions:chart
//        (offline on the example brain: MARKET_DATA_PROVIDER=fixtures, see README)
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { loadEvaluationReport } from "./decisions-evaluation-run.js";
import { buildProposalSeries, renderProposalQualitySvg } from "./utils/decisions-chart.js";

async function main(): Promise<void> {
  const report = await loadEvaluationReport("[decisions-chart]");

  const logsDir = join(config.paths.vaultProjectDir, "logs");
  const outPath = join(logsDir, "decisions-evaluation.svg");
  await mkdir(logsDir, { recursive: true });
  await writeFile(outPath, renderProposalQualitySvg(buildProposalSeries(report.evaluations)), "utf8");
  console.log(`[decisions-chart] Saved to ${outPath}`);
}

main().catch((err) => {
  console.error("[decisions-chart] Error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
