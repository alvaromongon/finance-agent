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

  // The copy starts the way a data repository does: a deposit batch in `inbox/` (examples/brain/inbox/) and no
  // portfolio.md, so the first deposit of each currency creates its silo (#196). Applied now, then a snapshot of what the
  // broker would show today (the same cash and positions), so the demo does not warn of a stale portfolio.
  const { ingestInbox } = await import("./inbox.js");
  const { asNumber } = await import("./money.js");
  const { readBothPortfolios, requireReadable } = await import("./portfolio-store.js");
  const now = new Date();
  const start = await ingestInbox(now);
  if (start.exitCode !== 0) throw new Error(`The example batch was not applied:\n${start.lines.join("\n")}`);
  const silos = await readBothPortfolios();
  const snapshot = [silos.EUR, silos.USD].flatMap((read) => {
    if (read === undefined) return [];
    const { currency, cash, positions } = requireReadable(read);
    const held = positions.map((p) => `\n      - ticker: ${p.ticker}\n        units: ${p.volume}`).join("");
    return [
      `  - command: snapshot\n    date: ${now.toISOString().slice(0, 10)}\n    cash: ${asNumber(cash)} ${currency}\n    positions:${held || " []"}`,
    ];
  });
  await writeFile(
    join(dir, "inbox", "snapshot.yaml"),
    `schema_version: 1\ncommands:\n${snapshot.join("\n")}\n`,
    "utf8",
  );
  const reconciled = await ingestInbox(now);
  if (reconciled.exitCode !== 0) throw new Error(`The snapshot was not applied:\n${reconciled.lines.join("\n")}`);

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
