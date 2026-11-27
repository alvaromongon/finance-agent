/**
 * `inbox:ingest` as a compare-and-swap (#134, spec #124, ADR-0018): two runs that write the state at the same time
 * never lose a write. The remote is a stand-in (`TestDoubles/directory-remote.ts`), never the real one; the race is
 * another run's commit made just before this run publishes.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { portfolioMd, watchlistMd } from "./fixtures/inbox.js";
import { DirectoryStateRemote } from "./TestDoubles/directory-remote.js";
import type { StateRemote } from "../state-commit.js";

const batch = (...commands: string[]): string =>
  `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;
const DEPOSIT = (amount: number) => `command: deposit\namount: ${amount}.00 EUR`;
const WITHDRAWAL = (amount: number) => `command: withdrawal\namount: ${amount}.00 EUR`;
const BUY = "command: buy\nticker: SAP.DE\ndate: 2026-09-15\nunits: 2\nprice: 100 EUR";
const NOW = new Date("2026-11-12T09:00:00Z");
const STOP = "command: set_stop\nticker: SAP.DE\nprice: 90 EUR";

describe("inbox:ingest as a compare-and-swap", () => {
  let work: string;
  let remoteDir: string;
  let inbox: typeof import("../inbox.js");
  let remote: DirectoryStateRemote;
  const inRemote = (...parts: string[]) => join(remoteDir, ...parts);
  const eurCash = async () =>
    (JSON.parse(await readFile(inRemote("state", "portfolio.json"), "utf8")) as Doc).silos.EUR.cash;
  const ls = (...parts: string[]) =>
    readdir(inRemote(...parts)).then(
      (names) => names.sort(),
      () => [] as string[],
    );

  interface Doc {
    silos: { EUR: { cash: string } };
  }

  /** Another run's commit: it moved the EUR cash to `cash`. */
  const setCash = (cash: string) => async (dir: string) => {
    const path = join(dir, "state", "portfolio.json");
    const doc = JSON.parse(await readFile(path, "utf8")) as Doc;
    doc.silos.EUR.cash = cash;
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  };

  before(async () => {
    work = await mkdtemp(join(tmpdir(), "finance-agent-race-work-"));
    remoteDir = await mkdtemp(join(tmpdir(), "finance-agent-race-remote-"));
    process.env.VAULT_PROJECT_DIR = work;
    mock.method(console, "warn", () => {});
    mock.method(console, "log", () => {});
    inbox = await import("../inbox.js");
  });
  after(async () => {
    mock.restoreAll();
    await rm(work, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  });

  /** The remote at its start: the portfolio as a store (1000.00 EUR, 500.00 USD) and the batch the owner dropped. */
  async function start(name: string, text: string): Promise<void> {
    for (const dir of [work, remoteDir]) {
      for (const entry of await readdir(dir)) await rm(join(dir, entry), { recursive: true, force: true });
    }
    await mkdir(join(work, "strategies"), { recursive: true });
    await writeFile(join(work, "strategies", "base.md"), `---\nversion: "1.4"\n---\n`, "utf8");
    await writeFile(join(work, "portfolio.md"), portfolioMd(), "utf8");
    await writeFile(join(work, "watchlist.md"), watchlistMd([["SAP.DE", "EUR"]]), "utf8");
    await (await import("../portfolio-store.js")).seedStore(new Date("2026-11-01T00:00:00Z"));
    await mkdir(join(work, "inbox"), { recursive: true });
    await writeFile(join(work, "inbox", name), text, "utf8");
    await cp(work, remoteDir, { recursive: true });
    remote = new DirectoryStateRemote(work, remoteDir);
  }

  beforeEach(async () => {
    await start("a.yaml", batch(DEPOSIT(100)));
  });

  it("a run that wins the race commits once, and what it commits is the remote's state plus its batch", async () => {
    const result = await inbox.ingestCommitted(remote, 3, new Date("2026-11-12T09:00:00Z"));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(remote.published, ["chore(state): apply inbox 2026-11-12"]);
    assert.equal(await eurCash(), "1100.00 EUR");
    assert.deepEqual(await ls("inbox"), ["applied"]);
    assert.deepEqual(await ls("inbox", "applied"), ["a.yaml"]);
  });

  it("a run that loses the race re-reads the state and applies its batch over it: no write is lost", async () => {
    remote.raceOnce(setCash("1300.00 EUR")); // another run committed 300.00 EUR more cash first
    const result = await inbox.ingestCommitted(remote, 3);
    assert.equal(result.exitCode, 0);
    assert.match(result.lines.join("\n"), /Applied 1 batch\(es\): inbox\/a\.yaml/);
    assert.equal(await eurCash(), "1400.00 EUR", "the other run's cash and this run's deposit");
    assert.equal(remote.published.length, 1, "the lost attempt published nothing");
    assert.equal(remote.reads, 2, "the state was read again after the loss");
    assert.deepEqual(await ls("inbox", "applied"), ["a.yaml"]);
  });

  it("a run that keeps losing applies nothing and rejects nothing: the batch stays in inbox/ for the next run", async () => {
    for (let i = 0; i < 3; i++) remote.raceOnce(setCash(`${1300 + i}.00 EUR`));
    const result = await inbox.ingestCommitted(remote, 3);
    assert.equal(result.exitCode, 0, "a delay is not a failure of the batch");
    assert.match(result.lines.join("\n"), /State not committed: another run committed state 3 time\(s\)/);
    assert.deepEqual(remote.published, []);
    assert.equal(await eurCash(), "1302.00 EUR", "only the other runs' writes");
    assert.deepEqual(await ls("inbox"), ["a.yaml"], "not moved to applied/ and not to rejected/");
    assert.deepEqual(await ls("inbox", "rejected"), []);

    // The next run, over the state as it is, applies it.
    assert.equal((await inbox.ingestCommitted(remote, 3)).exitCode, 0);
    assert.equal(await eurCash(), "1402.00 EUR");
    assert.deepEqual(await ls("inbox", "applied"), ["a.yaml"]);
  });

  it("a retried batch is judged against the state it now meets: valid before and invalid after is a normal rejection", async () => {
    await start("a.yaml", batch(WITHDRAWAL(900))); // valid over 1000.00 EUR
    remote.raceOnce(setCash("300.00 EUR")); // ... and not over 300.00 EUR
    const result = await inbox.ingestCommitted(remote, 3);
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join("\n"), /Rejected 1 batch\(es\), moved to inbox\/rejected\//);
    assert.deepEqual(await ls("inbox", "rejected"), ["a.yaml", "a.yaml.errors.txt"]);
    assert.equal(await eurCash(), "300.00 EUR");
    assert.equal(remote.published.length, 1, "the rejection is committed: the file is in rejected/ for the digest");
  });

  it("a retry judges a batch against the watchlist the other run left: the watchlist comes with the store (#140)", async () => {
    await start("a.yaml", batch("command: watch\ncurrency: USD\nticker: AMD"));
    // Another run's commit watched AMD first.
    remote.raceOnce(async (dir) => {
      const path = join(dir, "state", "portfolio.json");
      const doc = JSON.parse(await readFile(path, "utf8")) as { watchlist: object[] };
      doc.watchlist.push({ ticker: "AMD", currency: "USD", horizon: "medium", thesis: "" });
      await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    });
    const result = await inbox.ingestCommitted(remote, 3);
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join("\n"), /AMD is already on the watchlist \(USD silo\)/);
    assert.deepEqual(await ls("inbox", "rejected"), ["a.yaml", "a.yaml.errors.txt"]);
    assert.equal(remote.reads, 2, "the state, the watchlist with it, was read again after the loss");
  });

  it("the result of a retry equals that of a fresh run over the same state", async () => {
    remote.raceOnce(setCash("1300.00 EUR"));
    await inbox.ingestCommitted(remote, 3, NOW);
    const retried = await remote.snapshot();

    await start("a.yaml", batch(DEPOSIT(100)));
    await remote.commit(setCash("1300.00 EUR")); // the same state, but there before the run started
    await inbox.ingestCommitted(remote, 3, NOW);
    assert.deepEqual(await remote.snapshot(), retried);
  });

  it("asks for the history of a ticker once, however many times the run is retried", async () => {
    await start("a.yaml", batch(BUY, STOP));
    remote.raceOnce(setCash("1300.00 EUR"));
    let asked = 0;
    const source = {
      getPrices: async () => new Map<string, number>(),
      getHistorical: async () => {
        asked++;
        return [];
      },
    };
    const result = await inbox.ingestCommitted(remote, 3, new Date(), source);
    assert.equal(result.exitCode, 0);
    assert.equal(remote.reads, 2, "it was retried");
    assert.equal(asked, 1, "the retry used what the first attempt asked for");
  });

  it("a failure that is not a lost race is not retried and publishes nothing", async () => {
    const failing: StateRemote = {
      begin: () => remote.begin(),
      refresh: () => remote.refresh(),
      publish: async () => {
        throw new Error("network down");
      },
    };
    await assert.rejects(inbox.ingestCommitted(failing, 3), /network down/);
    assert.equal(remote.reads, 1, "one attempt");
    assert.deepEqual(await ls("inbox"), ["a.yaml"]);
  });

  it("an empty inbox publishes nothing", async () => {
    await rm(inRemote("inbox", "a.yaml"));
    const result = await inbox.ingestCommitted(remote, 3);
    assert.deepEqual(result, { lines: ["Inbox is empty: nothing to apply."], exitCode: 0 });
    assert.deepEqual(remote.published, []);
  });

  it("without a remote it is the plain ingest: the files are left in the working folder", async () => {
    const result = await inbox.ingestCommitted(null, 3);
    assert.equal(result.exitCode, 0);
    assert.deepEqual((await readdir(join(work, "inbox", "applied"))).sort(), ["a.yaml"]);
    assert.deepEqual(await ls("inbox"), ["a.yaml"], "the remote is untouched");
  });
  it("risk watch never waits: while a run keeps losing, every stop check reads the last commit and finds the breach", async () => {
    // The remote holds a position of 2 SAP.DE with its stop at 90, and a batch waiting in inbox/.
    await start("a.yaml", batch(BUY, STOP));
    await inbox.ingestCommitted(null, 3);
    await rm(join(work, "inbox", "applied"), { recursive: true });
    await writeFile(join(work, "inbox", "b.yaml"), batch(DEPOSIT(100)), "utf8");
    await rm(remoteDir, { recursive: true });
    await cp(work, remoteDir, { recursive: true });
    await remote.begin();

    // What the heartbeat does at its start, over the checkout it was given (the remote's last commit, never the
    // folder this run is writing in): read the state and compare the market price with each stop.
    const { readPortfolio } = await import("../portfolio-store.js");
    const { detectStopBreaches } = await import("../utils/stop-breach.js");
    const stopChecks: string[][] = [];
    const checkStops = async () => {
      process.env.VAULT_PROJECT_DIR = remoteDir;
      try {
        const { portfolio } = await readPortfolio("EUR");
        stopChecks.push(detectStopBreaches(portfolio.positions, new Map([["SAP.DE", 85]])).map((b) => b.ticker));
      } finally {
        process.env.VAULT_PROJECT_DIR = work;
      }
    };
    const losing: StateRemote = {
      begin: () => remote.begin(),
      refresh: () => remote.refresh(),
      publish: async (message) => {
        await checkStops(); // a stop check, in the middle of the write that loses
        remote.raceOnce(setCash("1300.00 EUR"));
        return remote.publish(message);
      },
    };
    const result = await inbox.ingestCommitted(losing, 3);

    assert.match(result.lines.join("\n"), /State not committed/, "the state write is delayed");
    assert.deepEqual(stopChecks, [["SAP.DE"], ["SAP.DE"], ["SAP.DE"]], "no stop check was skipped or held back");
  });

  it("the heartbeat takes no part in the write: nothing it runs imports the commit", async () => {
    const { readFileSync } = await import("node:fs");
    const src = join(import.meta.dirname, "..");
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(join(src, file), "utf8");
      for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)\.js["']/gm)) {
        walk(join(file, "..", `${m[1]}.ts`).replace(/^(\.\/)+/, ""));
      }
    };
    for (const entry of ["index.ts", "heartbeat-run.ts", "heartbeat.ts"]) walk(entry);
    assert.ok(seen.has("heartbeat-run.ts") && seen.size > 10, `walked the heartbeat's imports (${seen.size} modules)`);
    assert.equal(seen.has("state-commit.ts"), false, "stop detection takes no lock and waits for no write");
  });

  describe("decision:record, the other command that moves the store's cash", () => {
    const provider = { getPrices: async () => new Map<string, number>(), getHistorical: async () => [] };
    const deposit = { type: "deposit", currency: "EUR", amount: 50, date: "2026-11-12" };
    const lines = async () => (await readFile(inRemote("logs", "decisions.jsonl"), "utf8")).trim().split("\n");

    it("a deposit that loses the race is recorded over the new state: both cash movements stand, one log line", async () => {
      const { recordCommitted } = await import("../decision-record.js");
      remote.raceOnce(setCash("1300.00 EUR"));
      const [decision] = await recordCommitted(deposit, remote, 3, provider);
      assert.equal(decision.type, "deposit");
      assert.equal(await eurCash(), "1350.00 EUR");
      assert.equal((await lines()).length, 1, "the lost attempt's log line was thrown away with it");
      assert.equal(remote.published.length, 1);
    });

    it("that keeps losing records nothing and says so: the owner says it again", async () => {
      const { recordCommitted } = await import("../decision-record.js");
      for (let i = 0; i < 2; i++) remote.raceOnce(setCash("1300.00 EUR"));
      await assert.rejects(recordCommitted(deposit, remote, 2, provider), /Nothing was recorded.*Say it again/);
      assert.equal(await eurCash(), "1300.00 EUR");
      await assert.rejects(lines(), /ENOENT/);
    });
  });
});
