import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLastLog, shouldSkipReanalysis } from "../utils/cooldown.js";
import type { TriggerKind } from "../types.js";

describe("parseLastLog", () => {
  it("extracts price and triggers from the frontmatter", () => {
    const content = [
      "---",
      "id: 20260702-xom",
      'title: "BUY XOM — 2026-07-02"',
      "price: 137.5",
      "triggers: [buy_zone, big_move]",
      "---",
      "",
      "## Decisión",
    ].join("\n");

    const parsed = parseLastLog(content);
    assert.deepEqual(parsed, { price: 137.5, triggers: ["buy_zone", "big_move"] });
  });

  it("does not read the triggers from the body table: it is localized output", () => {
    const content = ["---", "id: x", "price: 10", "---", "", "| Disparos | buy_zone |"].join("\n");
    assert.deepEqual(parseLastLog(content), { price: 10, triggers: [] });
  });

  it("without a price field in the frontmatter returns null", () => {
    const content = ["---", "id: x", "triggers: [buy_zone]", "---"].join("\n");
    assert.equal(parseLastLog(content), null);
  });

  it("without frontmatter returns null", () => {
    assert.equal(parseLastLog("| Disparos | buy_zone |"), null);
  });

  it("price: 0 (HOLD log without a real price) returns null (avoids a division by zero downstream)", () => {
    const content = ["---", "id: x", "price: 0", "triggers: [buy_zone]", "---"].join("\n");
    assert.equal(parseLastLog(content), null);
  });

  it("a negative price returns null", () => {
    const content = ["---", "id: x", "price: -5", "triggers: [buy_zone]", "---"].join("\n");
    assert.equal(parseLastLog(content), null);
  });
});

describe("shouldSkipReanalysis", () => {
  it("without lastLog: no cooldown, it is analyzed", () => {
    const skip = shouldSkipReanalysis({
      currentTriggers: ["big_move"],
      currentPrice: 100,
      lastLog: null,
      reanalysisPriceDeltaPct: 3,
    });
    assert.equal(skip, false);
  });

  it("Δ price 1% (< default 3%): cooldown active, skipped", () => {
    const skip = shouldSkipReanalysis({
      currentTriggers: ["big_move"],
      currentPrice: 101,
      lastLog: { price: 100, triggers: ["big_move"] },
      reanalysisPriceDeltaPct: 3,
    });
    assert.equal(skip, true);
  });

  it("Δ price 4% (>= default 3%): cooldown passed, it is analyzed", () => {
    const skip = shouldSkipReanalysis({
      currentTriggers: ["big_move"],
      currentPrice: 104,
      lastLog: { price: 100, triggers: ["big_move"] },
      reanalysisPriceDeltaPct: 3,
    });
    assert.equal(skip, false);
  });

  it("triggers without overlap: no cooldown even if the price does not move", () => {
    const skip = shouldSkipReanalysis({
      currentTriggers: ["big_move"],
      currentPrice: 100,
      lastLog: { price: 100, triggers: ["approaching_stop"] },
      reanalysisPriceDeltaPct: 3,
    });
    assert.equal(skip, false);
  });

  it("Δ exactly at the threshold (3%): considered passed (no cooldown)", () => {
    const skip = shouldSkipReanalysis({
      currentTriggers: ["approaching_stop"],
      currentPrice: 103,
      lastLog: { price: 100, triggers: ["approaching_stop"] },
      reanalysisPriceDeltaPct: 3,
    });
    assert.equal(skip, false);
  });

  it("setup confirmed again at the same price: cooldown, it was already analyzed", () => {
    const skip = shouldSkipReanalysis({
      currentTriggers: ["setup"],
      currentPrice: 101,
      lastLog: { price: 100, triggers: ["setup"] },
      reanalysisPriceDeltaPct: 3,
    });
    assert.equal(skip, true);
  });

  it("triggers removed in old logs do not block the current ones", () => {
    const skip = shouldSkipReanalysis({
      currentTriggers: ["setup"],
      currentPrice: 100,
      lastLog: { price: 100, triggers: ["big_move", "buy_zone"] as unknown as TriggerKind[] },
      reanalysisPriceDeltaPct: 3,
    });
    assert.equal(skip, false);
  });
});
