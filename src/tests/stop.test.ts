// "No stop" has one definition (#132, found in #151 and #161): `stopOf`. The checks that read a position's stop
// (stop breach, tight stop, approaching stop, the inbox) and the digest's list of positions without one use it.
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { money } from "../money.js";
import { parseTicker as tk } from "../ticker.js";
import type { Position } from "../types.js";
import { positionsWithoutStop, stopOf } from "../utils/stop.js";
import { detectStopBreaches } from "../utils/stop-breach.js";
import { detectTightStops } from "../utils/atr-stop.js";
import { riskTriggers } from "../heartbeat.js";

const position = (stopLoss: number | null, ticker = "CAT"): Position<"USD"> => ({
  ticker: tk(ticker),
  currency: "USD",
  volume: 1,
  avgPrice: 100,
  currentPrice: 100,
  pl: money(0, "USD"),
  stopLoss,
});

describe("stopOf: a stop is a price above zero", () => {
  it("is the price for a stop above zero and null for none, zero or a negative price", () => {
    assert.equal(stopOf(position(95)), 95);
    assert.equal(stopOf(position(0.0001)), 0.0001);
    assert.equal(stopOf(position(null)), null);
    assert.equal(stopOf(position(0)), null);
    assert.equal(stopOf(position(-3)), null);
  });

  it("lists the positions with no stop, in the order of the positions", () => {
    const positions = [position(95, "A"), position(null, "B"), position(0, "C"), position(-1, "D")];
    assert.deepEqual(
      positionsWithoutStop(positions).map((p) => p.ticker),
      ["B", "C", "D"],
    );
  });

  it("is the one definition the stop checks use: a position with a stop of 0 or less has none for each of them", () => {
    for (const stop of [0, -5, null]) {
      const p = position(stop);
      assert.deepEqual(detectStopBreaches([p], new Map([["CAT", 1]])), [], `breach with stop ${stop}`);
      assert.deepEqual(detectTightStops([p], new Map([["CAT", 100]]), new Map([["CAT", 5]]), 2), []);
      assert.deepEqual(
        riskTriggers({ price: 1, position: p, stopProximityPct: 10_000, bigMovePct: 99 }),
        [],
        `approaching stop with stop ${stop}`,
      );
    }
    assert.equal(detectStopBreaches([position(95)], new Map([["CAT", 90]])).length, 1);
    assert.deepEqual(riskTriggers({ price: 96, position: position(95), stopProximityPct: 2, bigMovePct: 99 }), [
      "approaching_stop",
    ]);
  });
});

describe("the rule is written once", () => {
  const SRC = join(import.meta.dirname, "..");
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "tests" ? [] : sources(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    });

  it("no module but utils/stop.ts compares a position's stop with zero or with null itself", () => {
    const own = /\.stopLoss\s*(?:<=|>|!==?|===?)\s*(?:0\b|null)|\bstopLoss\s*(?:<=|>)\s*0\b|\bstopLoss\s*[!=]=\s*null/;
    const offenders = sources(SRC)
      .filter((file) => !file.endsWith(join("utils", "stop.ts")))
      .filter((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .some((line) => !/^\s*(\/\/|\*)/.test(line) && own.test(line)),
      )
      .map((file) => file.slice(SRC.length + 1));
    assert.deepEqual(offenders, []);
  });
});
