/**
 * Tests of the fixtures market data provider: it serves daily bars
 * saved as JSON so the engine runs without network — the demo and anyone
 * trying the engine without a market data account.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FixturesProvider } from "../providers/fixtures.js";

const bars = (closes: number[]) =>
  closes.map((close, i) => ({ date: `2026-10-0${i + 1}`, close, high: close + 1, low: close - 1, volume: 1000 }));

describe("FixturesProvider", () => {
  let dir: string;
  let provider: FixturesProvider;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "finance-agent-fixtures-"));
    await writeFile(join(dir, "SAP.DE.json"), JSON.stringify(bars([100, 102, 105])), "utf8");
    await writeFile(join(dir, "KO.json"), JSON.stringify(bars([60])), "utf8");
    provider = new FixturesProvider(dir);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prices are the last close; tickers without a file are left out", async () => {
    const prices = await provider.getPrices(["SAP.DE", "KO", "MISSING"]);
    assert.deepEqual(
      [...prices],
      [
        ["SAP.DE", 105],
        ["KO", 60],
      ],
    );
  });

  it("the previous close is the one before the last, when there is one", async () => {
    const closes = await provider.getPreviousCloses(["SAP.DE", "KO"]);
    assert.deepEqual([...closes], [["SAP.DE", 102]]);
  });

  it("history is the whole saved series; without a file, empty", async () => {
    assert.deepEqual(
      (await provider.getHistorical("SAP.DE")).map((b) => b.close),
      [100, 102, 105],
    );
    assert.deepEqual(await provider.getHistorical("MISSING"), []);
  });

  it("is registered as MARKET_DATA_PROVIDER=fixtures", async () => {
    process.env.MARKET_DATA_PROVIDER = "fixtures";
    process.env.MARKET_FIXTURES_DIR = dir;
    const { createMarketDataProvider } = await import("../providers/factory.js");
    assert.ok(createMarketDataProvider() instanceof FixturesProvider);
  });
});
