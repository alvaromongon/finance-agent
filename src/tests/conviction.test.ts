// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeConviction, latestScreening, scoreConviction, setupConviction } from "../utils/conviction.js";
import type { Decision } from "../decisions.js";
import { parseTicker as tk } from "../ticker.js";

describe("scoreConviction", () => {
  const none = { topQuintile: false, regime: "neutral" as const, rewardRisk: undefined, nextCatalyst: null };

  it("without any point the conviction is low", () => {
    assert.deepEqual(scoreConviction(none), { conviction: "low", points: [] });
  });

  it("one point each for top quintile, favorable regime, R:R ≥ 3 and dated catalyst", () => {
    assert.deepEqual(
      scoreConviction({ topQuintile: true, regime: "favorable", rewardRisk: 3, nextCatalyst: "Earnings 6 nov 2026" }),
      {
        conviction: "high",
        points: ["top_quintile", "regime_favorable", "reward_risk", "dated_catalyst"],
      },
    );
  });

  it("high with 3 points, medium with 2, low with 1", () => {
    assert.equal(
      scoreConviction({ ...none, topQuintile: true, regime: "favorable", rewardRisk: 4.2 }).conviction,
      "high",
    );
    assert.equal(scoreConviction({ ...none, topQuintile: true, nextCatalyst: "Earnings" }).conviction, "medium");
    assert.equal(scoreConviction({ ...none, regime: "favorable" }).conviction, "low");
  });

  it("a setup with R:R below 3, a neutral or adverse regime and a regime without data do not score", () => {
    assert.equal(scoreConviction({ ...none, rewardRisk: 2.99 }).points.length, 0);
    assert.equal(scoreConviction({ ...none, regime: "adverso" }).points.length, 0);
    assert.equal(scoreConviction({ ...none, regime: undefined }).points.length, 0);
  });
});

describe("describeConviction", () => {
  it("names the points behind it", () => {
    assert.equal(
      describeConviction({ conviction: "medium", points: ["top_quintile", "reward_risk"] }),
      "medium (quintil superior, R:R ≥ 3)",
    );
    assert.equal(describeConviction({ conviction: "low", points: [] }), "low");
  });
});

const screen = (over: Partial<Decision>): Decision => ({
  id: "x",
  date: "2026-09-26",
  ticker: tk("SNOW"),
  currency: "USD",
  origin: "sistema",
  source: "screening",
  type: "screen_interesting",
  price: 335.94,
  conviction: "high",
  conviction_points: ["top_quintile", "regime_favorable", "dated_catalyst"],
  rules_version: "1.1",
  ...over,
});

describe("latestScreening", () => {
  it("returns the ticker's last interesting one up to the date", () => {
    const history = [
      screen({ id: "a", date: "2026-09-12" }),
      screen({ id: "b", date: "2026-09-26" }),
      screen({ id: "c", date: "2026-10-03" }),
      screen({ id: "d", ticker: tk("AMD"), date: "2026-09-27" }),
      screen({ id: "e", type: "hold", source: "heartbeat", date: "2026-09-27" }),
    ];
    assert.equal(latestScreening(history, tk("SNOW"), "2026-09-29")?.id, "b");
    assert.equal(latestScreening(history, tk("SNOW"), "2026-09-01"), undefined);
  });
});

describe("setupConviction", () => {
  it("inherits the quintile and the catalyst from the screening and recomputes regime and R:R with the day's data", () => {
    // The screening's regime does not count: today it is neutral.
    assert.deepEqual(setupConviction({ screening: screen({}), regime: "neutral", rewardRisk: 3.4 }), {
      conviction: "high",
      points: ["top_quintile", "reward_risk", "dated_catalyst"],
    });
  });

  it("without an engine screening (added by hand or older ones) only regime and R:R score", () => {
    assert.deepEqual(setupConviction({ regime: "favorable", rewardRisk: 3 }), {
      conviction: "medium",
      points: ["regime_favorable", "reward_risk"],
    });
    const llm = screen({ conviction: "medium", conviction_points: undefined, rules_version: "1.0" });
    assert.deepEqual(setupConviction({ screening: llm, regime: "favorable", rewardRisk: 1.5 }), {
      conviction: "low",
      points: ["regime_favorable"],
    });
  });
});
