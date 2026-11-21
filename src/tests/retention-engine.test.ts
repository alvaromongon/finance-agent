/**
 * The documented quarter-archive program (docs/log-retention.md) against the engine: after a quarter is
 * archived, `inbox:ingest` must record every later sale as it would with the whole history, even when
 * no archive is readable at all (`DECISIONS_ARCHIVE_DIR` unset, or CI without it). The program runs on a
 * log the engine itself wrote; then the same sale is applied on three copies of the vault: never
 * archived, archived and readable, archived and unreadable.
 */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "../decisions.js";
import { lotsSection } from "./fixtures/lots.js";

const ROOT = join(import.meta.dirname, "..", "..");
const RETENTION = join(ROOT, "docs", "log-retention.md");
const TODAY = "2026-09-14";

const WATCHLIST_MD = `---
schema_version: 1
---

# Watchlist

\`\`\`yaml
watchlist:
  - ticker: ADBE
    name: Adobe
    market: NASDAQ
    currency: USD
    horizon: medium
    thesis: "Software."
\`\`\`
`;

const PORTFOLIO_MD = `---
schema_version: 2
last_manual_sync: 2026-09-10T18:00:00Z
account_env: demo
---

${["EUR", "USD"]
  .map(
    (c) => `## ${c} — Cash

| Item | Value |
|---|---|
| Available cash | 1000.00 |

## ${c} — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|

${lotsSection(c as "EUR" | "USD")}`,
  )
  .join("\n")}`;

const NOW = new Date("2026-09-14T09:00:00Z");

/** A batch of commands, one line each; a field of a command is written after a `|`. */
const batch = (...commands: string[]): string =>
  `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;

const cleanEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

/** The ```bash blocks of the "Archiving decision-log quarters" section, in order. */
const archiveBlocks = (md: string): string[] => {
  const section = md.slice(md.indexOf("## Archiving decision-log quarters"), md.indexOf("## Reading the archive back"));
  return [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
};

/** A decision without what differs between runs of the same trade (its id and the ids it cites). */
const shape = (d: Decision) => ({ ...d, id: undefined, related_id: d.related_id ? "lot" : undefined });

describe("after the quarter-archive program, inbox:ingest needs no archive", () => {
  let root: string;
  let vault: string;
  let archive: string;
  let ingestInbox: (now?: Date) => Promise<{ lines: string[]; exitCode: number }>;
  const logOf = async (dir: string) =>
    (await readFile(join(dir, "logs", "decisions.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Decision);

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "finance-agent-retention-engine-"));
    vault = join(root, "brain");
    archive = join(root, "archive");
    await mkdir(join(vault, "logs"), { recursive: true });
    await mkdir(join(vault, "strategies"), { recursive: true });
    await writeFile(join(vault, "strategies", "base.md"), `---\nversion: "0.2"\n---\n`, "utf8");
    await writeFile(join(vault, "watchlist.md"), WATCHLIST_MD, "utf8");
    await writeFile(join(vault, "portfolio.md"), PORTFOLIO_MD, "utf8");
    process.env.VAULT_PROJECT_DIR = vault;
    delete process.env.DECISIONS_ARCHIVE_DIR;
    ({ ingestInbox } = await import("../inbox.js"));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const applyBatch = async (dir: string, name: string, text: string) => {
    await mkdir(join(dir, "inbox"), { recursive: true });
    await writeFile(join(dir, "inbox", name), text, "utf8");
    const result = await ingestInbox(NOW);
    assert.equal(result.exitCode, 0, result.lines.join("\n"));
  };

  it("records the same sale from the live file alone as from the live file plus the archive", async () => {
    // Q2: lot A (10 units, costs 4) and lot B (6 units, costs 3); a sale that uses A up and takes 2 of B,
    // then a second partial sale of B. Both exits of B are partial: they leave B open.
    await applyBatch(
      vault,
      "q2.yaml",
      batch(
        "command: buy\nticker: ADBE\ndate: 2026-04-10\nunits: 10\nprice: 25 USD\ncosts: 4 USD",
        "command: buy\nticker: ADBE\ndate: 2026-04-12\nunits: 6\nprice: 26 USD\ncosts: 3 USD",
        "command: sale\nticker: ADBE\ndate: 2026-05-02\nunits: 12\nprice: 30 USD\ncosts: 2 USD",
        "command: sale\nticker: ADBE\ndate: 2026-05-20\nunits: 1\nprice: 30 USD\ncosts: 1 USD",
      ),
    );
    const before = await logOf(vault);
    assert.equal(before.length, 5);

    const never = join(root, "never-archived");
    await cp(vault, never, { recursive: true });
    const [vars, copy, prune] = archiveBlocks(await readFile(RETENTION, "utf8"));
    const script = [vars, copy, prune].join("\n").replace("/absolute/path/to/archive", archive);
    const out = spawnSync("bash", ["-c", script], { cwd: vault, encoding: "utf8", env: cleanEnv() });
    assert.equal(out.status, 0, out.stderr);

    // Lot A is used up: its entry and exit moved together. Lot B is open: all its lines stayed.
    const archived = (await readFile(join(archive, "decisions-2026-Q2.jsonl"), "utf8")).split("\n").filter(Boolean);
    assert.equal(archived.length, 2, "only lot A (entry and exit) is archived");
    assert.equal((await logOf(vault)).length, 3, "lot B's entry and both its exits stay live");

    const liveOnly = join(root, "live-only");
    await cp(vault, liveOnly, { recursive: true });
    const sale = batch(`command: sale\nticker: ADBE\ndate: ${TODAY}\nunits: 3\nprice: 31 USD\ncosts: 1 USD`);

    const run = async (dir: string, archiveDir: string | undefined) => {
      process.env.VAULT_PROJECT_DIR = dir;
      if (archiveDir) process.env.DECISIONS_ARCHIVE_DIR = archiveDir;
      else delete process.env.DECISIONS_ARCHIVE_DIR;
      await applyBatch(dir, "sale.yaml", sale);
      return (await logOf(dir)).filter((d) => d.type === "exit" && d.date === TODAY).map(shape);
    };
    const truth = await run(never, undefined);
    const full = await run(vault, archive);
    const live = await run(liveOnly, undefined);

    assert.equal(truth.length, 1);
    assert.equal(truth[0].entry_costs, 1.5, "lot B's costs: 3 in all, 1 and 0.5 taken by the first two exits");
    assert.deepEqual(full, truth);
    assert.deepEqual(live, truth);
    assert.equal(
      await readFile(join(liveOnly, "state", "portfolio.json"), "utf8"),
      await readFile(join(never, "state", "portfolio.json"), "utf8"),
    );
  });
});
