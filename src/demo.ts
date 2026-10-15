// Demo: one heartbeat against the example brain, from a clean clone and
// without configuring anything.
//
//   npm run demo -- --currency EUR     (or USD)
//
// It copies examples/brain/ to a temporary directory — the heartbeat writes
// logs and prices, and the example must stay clean — and runs with synthetic
// prices from examples/market/ (fixtures provider), the handoff analyst (the
// escalations stay as files in logs/pending/, no Claude) and the outbox mail
// transport (the email stays as a file in logs/outbox/, no SMTP). Nothing
// leaves the machine. The environment is set here, before config.js loads,
// and the local .env is not loaded, so it cannot point the demo at real data,
// send real mail or change its thresholds.
import { cp, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Currency } from "./types.js";

const EXAMPLES = join(import.meta.dirname, "..", "examples");

export interface DemoResult {
  /** Temporary copy of the brain the run wrote to. */
  dir: string;
  /** Body of each email the run queued. */
  emails: string[];
  /** Escalations left for the reasoner, by file name. */
  pending: string[];
}

export async function runDemo(currency: Currency): Promise<DemoResult> {
  const dir = await mkdtemp(join(tmpdir(), "finance-agent-demo-"));
  await cp(join(EXAMPLES, "brain"), dir, { recursive: true });

  // The copy is "synced" today, so the demo does not warn of a stale portfolio.
  const portfolioPath = join(dir, "portfolio.md");
  const portfolio = await readFile(portfolioPath, "utf8");
  await writeFile(
    portfolioPath,
    portfolio.replace(/^last_manual_sync: .*$/m, `last_manual_sync: ${new Date().toISOString()}`),
    "utf8",
  );

  Object.assign(process.env, {
    // No local .env: its thresholds would change what the demo shows.
    DOTENV_CONFIG_PATH: join(dir, ".env-none"),
    VAULT_PROJECT_DIR: dir,
    DECISIONS_ARCHIVE_DIR: "",
    MARKET_DATA_PROVIDER: "fixtures",
    MARKET_FIXTURES_DIR: join(EXAMPLES, "market"),
    // The reference ETFs of the example brain, which has bars for them.
    REFERENCE_TICKER_EUR: "EXSA.DE",
    REFERENCE_TICKER_USD: "VOO",
    ANALYST_PROVIDER: "handoff",
    MAIL_TRANSPORT: "outbox",
    MAIL_REQUIRE_DELIVERY: "false",
  });

  const { runHeartbeat } = await import("./heartbeat-run.js");
  const { createMarketDataProvider } = await import("./providers/factory.js");
  const { createAnalystProvider } = await import("./analyst/factory.js");
  await runHeartbeat(currency, {
    provider: createMarketDataProvider(),
    analyst: createAnalystProvider(),
    headlines: () => Promise.resolve([]),
  });

  const list = (sub: string) =>
    readdir(join(dir, "logs", sub)).then(
      (f) => f.sort(),
      () => [] as string[],
    );
  const emails = await Promise.all(
    (await list("outbox")).map(
      async (f) => (JSON.parse(await readFile(join(dir, "logs", "outbox", f), "utf8")) as { body: string }).body,
    ),
  );
  return { dir, emails, pending: await list("pending") };
}

if (process.argv[1] === import.meta.filename) {
  const i = process.argv.indexOf("--currency");
  const currency = process.argv[i + 1] ?? "EUR";
  if (i < 0 || (currency !== "EUR" && currency !== "USD")) {
    console.error("Usage: npm run demo -- --currency <EUR|USD>");
    process.exitCode = 1;
  } else {
    runDemo(currency)
      .then(({ dir, emails, pending }) => {
        for (const body of emails) console.log(`\n=== Email ===\n${body}`);
        console.log(`\n[demo] Brain copy: ${dir}`);
        console.log(`[demo] Escalations for the reasoner (logs/pending/): ${pending.join(", ") || "none"}`);
      })
      .catch((err) => {
        console.error("[demo] Run aborted:", err);
        process.exitCode = 1;
      });
  }
}
