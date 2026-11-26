/**
 * The engine's stop proposals as an inbox batch (#136): the batch text, the "not dropped twice" rule and the way the
 * file is dropped in `inbox/`. The flows that propose a stop are tested where they run (heartbeat-run, pending,
 * monday-briefing-flow). VAULT_PROJECT_DIR is set before the first import of config.js.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTicker as tk } from "../ticker.js";
import { newStopProposals, plainPrice, renderStopBatch, type StopProposal } from "../utils/stop-proposals.js";
import { parseBatch } from "../utils/inbox-parse.js";

const SAP: StopProposal = { ticker: tk("SAP.DE"), currency: "EUR", stop: 168.3 };
const MSFT: StopProposal = { ticker: tk("MSFT"), currency: "USD", stop: 471 };
const setStop = (ticker: string, price: string) =>
  `schema_version: 1\ncommands:\n  - command: set_stop\n    ticker: ${ticker}\n    price: ${price}\n`;

describe("plainPrice", () => {
  it("is a plain decimal the inbox reads: no exponent, no trailing zeros", () => {
    assert.equal(plainPrice(168.3), "168.3");
    assert.equal(plainPrice(100), "100");
    assert.equal(plainPrice(1234.56789), "1234.56789");
    assert.equal(plainPrice(0.00000012), "0.00000012");
  });

  it("is nothing for a price that is not above zero", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e-12]) assert.equal(plainPrice(bad), null);
  });
});

describe("renderStopBatch", () => {
  it("is a batch the inbox reads: one set_stop per proposal, in the currency of its silo", () => {
    const parsed = parseBatch(renderStopBatch([SAP, MSFT], "heartbeat-eur", "2026-11-26"));

    assert.deepEqual(parsed.issues, []);
    assert.deepEqual(
      parsed.commands.map((c) => c.command),
      [
        { kind: "set_stop", currency: "EUR", ticker: "SAP.DE", price: 168.3 },
        { kind: "set_stop", currency: "USD", ticker: "MSFT", price: 471 },
      ],
    );
  });

  it("quotes a ticker so no symbol of the ticker pattern is read as YAML", () => {
    for (const t of ["^GSPC", "EURUSD=X", "BRK-B", "1810.HK"]) {
      const parsed = parseBatch(
        renderStopBatch([{ ticker: tk(t), currency: "USD", stop: 5 }], "pending", "2026-11-26"),
      );
      assert.deepEqual(parsed.issues, [], t);
      assert.equal(parsed.commands[0].command.kind === "set_stop" && parsed.commands[0].command.ticker, t);
    }
  });

  it("refuses a stop that cannot be written as a set_stop", () => {
    assert.throws(() => renderStopBatch([{ ...MSFT, stop: 0 }], "pending", "2026-11-26"), /cannot be written/);
  });
});

describe("newStopProposals", () => {
  it("drops a proposal waiting in inbox/ with the same ticker, currency and price, however it is written", () => {
    const { fresh, waiting } = newStopProposals(
      [SAP, MSFT],
      [setStop("sap.de", "168.30 EUR"), setStop("MSFT", "400 USD")],
    );

    assert.deepEqual(waiting, [SAP]);
    assert.deepEqual(fresh, [MSFT], "another price for the same ticker is a new proposal");
  });

  it("does not treat the same price in another currency as waiting", () => {
    assert.deepEqual(newStopProposals([SAP], [setStop("SAP.DE", "168.3 USD")]).fresh, [SAP]);
  });

  it("drops a proposal repeated within the list, and a stop that is not above zero", () => {
    const { fresh } = newStopProposals([SAP, { ...SAP }, { ...MSFT, stop: -3 }], []);
    assert.deepEqual(fresh, [SAP]);
  });

  it("a file that does not read contributes what it did parse", () => {
    const { waiting } = newStopProposals([SAP], ["{ not yaml", `${setStop("SAP.DE", "168.3 EUR")}  - command: nope\n`]);
    assert.deepEqual(waiting, [SAP]);
  });
});

describe("dropStopProposals", () => {
  let vaultDir: string;
  let dropStopProposals: typeof import("../stop-proposals.js").dropStopProposals;

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-stops-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    ({ dropStopProposals } = await import("../stop-proposals.js"));
  });
  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rm(join(vaultDir, "inbox"), { recursive: true, force: true });
  });

  const quietly = async <T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> => {
    const log = mock.method(console, "log", () => {});
    const warn = mock.method(console, "warn", () => {});
    try {
      const result = await fn();
      return { result, warnings: warn.mock.calls.map((c) => String(c.arguments[0])) };
    } finally {
      log.mock.restore();
      warn.mock.restore();
    }
  };

  it("creates inbox/ if it is not there and writes one file named for the day and the flow", async () => {
    const { result } = await quietly(() => dropStopProposals([SAP, MSFT], "monday-briefing", "2026-11-26"));

    assert.equal(result.file, "2026-11-26-monday-briefing-stops.yaml");
    assert.deepEqual(await readdir(join(vaultDir, "inbox")), ["2026-11-26-monday-briefing-stops.yaml"]);
    assert.deepEqual(result.dropped, [SAP, MSFT]);
  });

  it("writes nothing for no proposals, and nothing for the ones already waiting", async () => {
    assert.equal((await quietly(() => dropStopProposals([], "pending", "2026-11-26"))).result.file, null);
    assert.deepEqual(await readdir(vaultDir).then((f) => f.filter((n) => n === "inbox")), []);

    await quietly(() => dropStopProposals([SAP], "pending", "2026-11-26"));
    const again = (await quietly(() => dropStopProposals([SAP], "pending", "2026-11-26"))).result;

    assert.equal(again.file, null);
    assert.deepEqual(again.waiting, [SAP]);
    assert.equal((await readdir(join(vaultDir, "inbox"))).length, 1);
  });

  it("a name that is taken gets a counter and never overwrites the file there", async () => {
    await mkdir(join(vaultDir, "inbox"));
    await writeFile(join(vaultDir, "inbox", "2026-11-26-pending-stops.yaml"), "owner's text", "utf8");

    const { result } = await quietly(() => dropStopProposals([SAP], "pending", "2026-11-26"));

    assert.equal(result.file, "2026-11-26-pending-stops-2.yaml");
    assert.equal(await readFile(join(vaultDir, "inbox", "2026-11-26-pending-stops.yaml"), "utf8"), "owner's text");
  });

  it("never follows a link: a symbolic link as inbox/ is said and nothing is written", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "finance-agent-elsewhere-"));
    await symlink(elsewhere, join(vaultDir, "inbox"));
    try {
      const { result, warnings } = await quietly(() => dropStopProposals([SAP], "pending", "2026-11-26"));

      assert.equal(result.file, null);
      assert.ok(
        warnings.some((w) => w.includes("not dropped in inbox") && w.includes("symbolic link")),
        warnings.join("\n"),
      );
      assert.deepEqual(await readdir(elsewhere), []);
    } finally {
      await rm(join(vaultDir, "inbox"), { force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("never follows a link that has the name of the file: the name counts as taken", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "finance-agent-elsewhere-"));
    await mkdir(join(vaultDir, "inbox"));
    await symlink(join(elsewhere, "victim.yaml"), join(vaultDir, "inbox", "2026-11-26-pending-stops.yaml"));
    try {
      const { result } = await quietly(() => dropStopProposals([SAP], "pending", "2026-11-26"));

      assert.equal(result.file, "2026-11-26-pending-stops-2.yaml");
      assert.deepEqual(await readdir(elsewhere), [], "nothing was written through the link");
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
