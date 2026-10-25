// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { detectBreakout } from "../utils/setups/breakout.js";
import { detectNewSetups, detectSetups, evaluateSetup, describeSetup } from "../utils/setups/index.js";
import { detectPullback } from "../utils/setups/pullback.js";
import { bar, extend, realBars, uptrend } from "./fixtures/setup-bars.js";
import type { WatchlistEntry } from "../types.js";
import { parseTicker as tk } from "../ticker.js";

const { pullback: PULLBACK, breakout: BREAKOUT } = config.framework.setups;

const entry: WatchlistEntry = {
  ticker: tk("TEST"),
  name: "Test",
  market: "NYSE",
  currency: "USD",
  horizon: "medium",
  thesis: "t",
};

// A year rising to 209.5, a four-session pullback touching the SMA20 with a
// low at 203.5 and a bounce closing above it with a higher low.
const up = uptrend(220);
const top = up[up.length - 1].close;
const dip = extend(up, [top - 1.5, top - 3, top - 4.5, [top - 5, { low: top - 6 }]]);
const pullback = extend(dip, [top - 2]);

// Rise to 174.5 and a fifteen-session ±0.5 base right at the high.
const run = uptrend(150);
const high = run[run.length - 1].close;
const base = extend(
  run,
  Array.from({ length: 15 }, (_, i) => high + (i % 2 ? 0.5 : -0.5)),
);
const breakout = extend(base, [[high + 3, { volume: 2000 }]]);

describe("detectPullback (ADR-0013)", () => {
  it("fires when closing above the average after touching it, with a higher low", () => {
    const s = detectPullback(pullback, PULLBACK);
    assert.deepEqual(s, {
      pattern: "pullback",
      state: "triggered",
      date: pullback[pullback.length - 1].date,
      level: 207.5,
      target: 216.1,
    });
  });

  it("the target is the high it pulled back from plus the size of the pullback", () => {
    const swingHigh = Math.max(...pullback.slice(-21, -1).map((b) => b.high));
    const touchLow = Math.min(...pullback.slice(-6, -1).map((b) => b.low));
    assert.equal(detectPullback(pullback, PULLBACK)?.target, Math.round((2 * swingHigh - touchLow) * 100) / 100);
  });

  it("does not fire during the fall: the close is still below the average", () => {
    assert.equal(detectPullback(dip, PULLBACK), null);
  });

  it("does not fire if the bounce makes a lower low", () => {
    assert.equal(detectPullback(extend(dip, [[top - 2, { low: top - 7 }]]), PULLBACK), null);
  });

  it("does not fire in a rise without a pullback: the close is already at highs", () => {
    assert.equal(detectPullback(up, PULLBACK), null);
  });

  it("does not fire below the SMA200", () => {
    const falling = Array.from({ length: 220 }, (_, i) => bar(i, 300 - i * 0.5));
    const last = falling[falling.length - 1].close;
    const bounce = extend(falling, [last - 1, [last - 2, { low: last - 3 }], last + 2]);
    assert.equal(detectPullback(bounce, PULLBACK), null);
  });

  it("without 200 sessions there is no trend to check", () => {
    assert.equal(detectPullback(pullback.slice(-150), PULLBACK), null);
  });
});

describe("detectBreakout (ADR-0013)", () => {
  it("a narrow base right at the high is armed with the Buy Stop at its top", () => {
    const s = detectBreakout(base, BREAKOUT);
    assert.equal(s?.state, "armed");
    assert.equal(s?.level, Math.max(...base.slice(-15).map((b) => b.high)));
  });

  it("a close above the top with volume ≥ 1.5× the average fires the breakout", () => {
    const s = detectBreakout(breakout, BREAKOUT);
    assert.equal(s?.state, "triggered");
    assert.equal(s?.level, breakout[breakout.length - 1].close);
  });

  it("the target is the base top plus the pole", () => {
    const baseHigh = Math.max(...base.slice(-15).map((b) => b.high));
    const poleLow = Math.min(...base.slice(-15 - BREAKOUT.poleSessions, -15).map((b) => b.low));
    assert.equal(detectBreakout(breakout, BREAKOUT)?.target, Math.round((2 * baseHigh - poleLow) * 100) / 100);
  });

  it("without volume there is no confirmed breakout", () => {
    const quiet = extend(base, [[high + 3, { volume: 1200 }]]);
    assert.notEqual(detectBreakout(quiet, BREAKOUT)?.state, "triggered");
    const noData = extend(base, [high + 3]).map((b) => ({ ...b, volume: undefined }));
    assert.notEqual(detectBreakout(noData, BREAKOUT)?.state, "triggered");
  });

  it("a wide base is not a base", () => {
    const wide = extend(
      run,
      Array.from({ length: 15 }, (_, i) => high + (i % 2 ? 4 : -4)),
    );
    assert.equal(detectBreakout(wide, BREAKOUT), null);
  });

  it("a base far from the 52-week high does not count", () => {
    const peak = extend(
      run,
      Array.from({ length: 30 }, (_, i) => high - i * 1.5),
    );
    const low = peak[peak.length - 1].close;
    const far = extend(
      peak,
      Array.from({ length: 15 }, (_, i) => low + (i % 2 ? 0.5 : -0.5)),
    );
    assert.equal(detectBreakout(far, BREAKOUT), null);
  });
});

describe("detectNewSetups", () => {
  it("a base armed several days in a row is only new on the first", () => {
    const armedDays = Array.from({ length: base.length - run.length + 1 }, (_, i) =>
      base.slice(0, run.length + i),
    ).filter((bars) => detectSetups(bars).some((s) => s.state === "armed"));
    assert.ok(armedDays.length > 1, "the base stays armed for several days");
    const newDays = armedDays.filter((bars) => detectNewSetups(bars).some((s) => s.state === "armed"));
    assert.equal(newDays.length, 1);
  });

  it("the breakout of an armed base is new: it changes state", () => {
    assert.deepEqual(
      detectNewSetups(breakout).map((s) => s.state),
      ["triggered"],
    );
  });
});

// The three entries behind ADR-0010, on their dates, with real Yahoo history:
// none is a setup. Neither a confirmed pullback nor a breakout.
describe("historical cases: GE, ADBE and SGO.PA on those dates do not fire", () => {
  for (const [ticker, file] of [
    ["mixed-bias case B (20-ago)", "bars-case-mixed-bias-b-2026-08-20.json"],
    ["mixed-bias case A (19-ago)", "bars-case-mixed-bias-a-2026-08-19.json"],
    ["bearish case (31-ago)", "bars-case-bearish-2026-08-31.json"],
  ]) {
    it(ticker, () => {
      const triggered = detectSetups(realBars(file)).filter((s) => s.state === "triggered");
      assert.deepEqual(triggered, []);
    });
  }
});

describe("evaluateSetup", () => {
  it("a healthy pullback comes out eligible, with the engine stop and the pattern target", () => {
    const setup = detectPullback(pullback, PULLBACK)!;
    const ev = evaluateSetup(setup, { entry, bars: pullback, cash: 1000, siloValue: 1000 });
    assert.deepEqual(ev.reasons, []);
    assert.equal(ev.ticket?.entry, setup.level);
    assert.equal(ev.ticket?.target, setup.target);
    assert.ok(ev.ticket.stop < setup.level);
    assert.ok(ev.ticket.rrNet >= config.framework.minRewardRisk);
    assert.match(describeSetup(ev), /retroceso en tendencia confirmado a 207\.5 USD, objetivo 216\.1 .* — ELEGIBLE$/);
  });

  it("in an adverse regime it is blocked, with the ticket computed anyway", () => {
    const ev = evaluateSetup(detectPullback(pullback, PULLBACK)!, {
      entry,
      bars: pullback,
      regime: "adverso",
      cash: 1000,
      siloValue: 1000,
    });
    assert.deepEqual(ev.reasons, ["regime_adverse"]);
    assert.ok(ev.ticket);
    assert.match(describeSetup(ev), /BLOQUEADO \(regime_adverse\)$/);
  });

  it("without cash for the minimum order it is blocked by the arithmetic", () => {
    const ev = evaluateSetup(detectPullback(pullback, PULLBACK)!, { entry, bars: pullback, cash: 1, siloValue: 1000 });
    assert.ok(ev.reasons.includes("insufficient_cash"));
  });

  it("an armed breakout is sized at the Buy Stop level", () => {
    const setup = detectBreakout(base, BREAKOUT)!;
    const ev = evaluateSetup(setup, { entry, bars: base, cash: 1000, siloValue: 1000 });
    assert.equal(ev.ticket?.entry, setup.level);
    assert.match(describeSetup(ev), /ruptura ARMADA — Buy Stop en/);
  });
});
