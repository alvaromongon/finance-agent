// Tests of the heartbeat summary email: a single email per run,
// with one section per kind of alert, and only with what was not sent today.
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { digestKeys, onlyNew, renderHeartbeatDigest, type HeartbeatDigest } from "../utils/heartbeat-digest.js";
import { detectStopBreaches } from "../utils/stop-breach.js";
import { detectTightStops } from "../utils/atr-stop.js";
import { detectNewSetups } from "../utils/setups/index.js";
import { scanSetups } from "../utils/setups/scan.js";
import { extend, uptrend } from "./fixtures/setup-bars.js";
import type { Position, Signal } from "../types.js";
import { parseTicker as tk } from "../ticker.js";

function position(overrides: Partial<Position> = {}): Position {
  return {
    ticker: tk("MSFT"),
    currency: "USD",
    volume: 1,
    avgPrice: 492.01,
    currentPrice: 501.02,
    pl: 9.01,
    stopLoss: 500,
    ...overrides,
  };
}

const breaches = detectStopBreaches(
  [position({ ticker: tk("CAT"), avgPrice: 218, stopLoss: 213 })],
  new Map([["CAT", 210.77]]),
);

const tightStops = detectTightStops(
  [position(), position({ ticker: tk("AVGO"), avgPrice: 200, stopLoss: 366 })],
  new Map([
    ["MSFT", 501.02],
    ["AVGO", 369.53],
  ]),
  new Map([
    ["MSFT", 9.67],
    ["AVGO", 11.2],
  ]),
);

// A fifteen-session base right at the high: armed for the first time (see setups-scan.test.ts).
const run = uptrend(150);
const high = run[run.length - 1].close;
const base = extend(
  run,
  Array.from({ length: 15 }, (_, i) => high + (i % 2 ? 0.5 : -0.5)),
);
const firstArmed = Array.from({ length: 16 }, (_, i) => base.slice(0, run.length + i)).find((bars) =>
  detectNewSetups(bars).some((s) => s.state === "armed"),
)!;
const { notices } = await scanSetups({
  watchlist: [{ ticker: tk("BO"), name: "BO", market: "NYSE", currency: "USD", horizon: "medium", thesis: "t" }],
  portfolio: { currency: "USD", cash: 1000, positions: [], lots: [], syncedAt: "2026-09-24T00:00:00Z" },
  provider: { getHistorical: async () => firstArmed },
  date: "2026-09-24",
  rulesVersion: "0.7",
  benchmark: { ticker: tk("VOO"), price: 800, regime: "favorable" },
  log: () => {},
});

const escalated: Signal[] = [
  { ticker: tk("XOM"), currency: "USD", triggers: ["big_move"], price: 112.4, cash: 0, siloValue: 0 },
];

const digest = (over: Partial<HeartbeatDigest> = {}): HeartbeatDigest => ({
  currency: "USD",
  syncedAt: "2026-09-02T14:10:00Z",
  minAtr: 2,
  breaches: [],
  lotsWarnings: [],
  tickerWarnings: [],
  tightStops: [],
  armed: [],
  escalated: [],
  ...over,
});

describe("renderHeartbeatDigest", () => {
  it("with nothing to report there is no email", () => {
    assert.equal(renderHeartbeatDigest(digest()), null);
  });

  it("with several sections a single email goes out with all of them, in order of urgency", () => {
    const email = renderHeartbeatDigest(digest({ breaches, tightStops, armed: notices, escalated }))!;

    assert.equal(
      email.subject,
      "[Finance Agent] Heartbeat USD — stop cruzado: CAT · stop ceñido: MSFT, AVGO · ruptura armada: BO · a análisis: XOM",
    );
    const order = [
      "## Stops cruzados",
      "## Stops demasiado ceñidos",
      "## Rupturas armadas",
      "## Señales enviadas a análisis",
    ].map((h) => email.body.indexOf(h));
    assert.ok(
      order.every((i) => i >= 0),
      "the four sections are there",
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      "in order of urgency",
    );
  });

  it("with a single section it does not render the others", () => {
    const email = renderHeartbeatDigest(digest({ armed: notices }))!;

    assert.equal(email.subject, "[Finance Agent] Heartbeat USD — ruptura armada: BO");
    assert.match(email.body, /BO: ruptura ARMADA — Buy Stop en/);
    assert.doesNotMatch(email.body, /## Stops|## Señales/);
  });

  it("the crossed stop places the age of the manual sync and the market data", () => {
    const { body } = renderHeartbeatDigest(digest({ breaches }))!;

    assert.match(body, /2026-09-02/, "says since when the account has not been synced");
    assert.match(body, /210,77 USD/, "market price");
    assert.match(body, /213,00/, "recorded stop");
    assert.match(body, /routines\/portfolio-sync\.md/, "links the sync guide");
  });

  it("the tight stop carries multiple, ATR and suggested stop, and the configured threshold", () => {
    const { body } = renderHeartbeatDigest(digest({ tightStops, minAtr: 3 }))!;

    assert.match(body, /\*\*0,1 ATR\*\*/);
    // MSFT reference stop: 501.02 − 3 × 9.67 ≈ 472.01.
    assert.match(body, /472,01/);
    assert.match(body, /\*\*menos de 3 ATR\*\*/);
  });

  it("warns when widening the stop would take it below the buy price, and only then", () => {
    assert.match(renderHeartbeatDigest(digest({ tightStops }))!.body, /debajo del precio medio de compra/);

    const withMargin = detectTightStops(
      [position({ avgPrice: 400 })],
      new Map([["MSFT", 501.02]]),
      new Map([["MSFT", 9.67]]),
    );
    assert.doesNotMatch(
      renderHeartbeatDigest(digest({ tightStops: withMargin }))!.body,
      /debajo del precio medio de compra/,
    );
  });

  it("escalated signals are an informational line, asking for no action", () => {
    const { body } = renderHeartbeatDigest(digest({ escalated }))!;
    assert.match(body, /- XOM: big_move a 112,40 USD/);
    assert.match(body, /solo si el análisis propone operar/);
  });
});

describe("onlyNew / digestKeys", () => {
  const full = digest({ breaches, tightStops, armed: notices, escalated });

  it("what was already sent today is not repeated; the crossed stop is always sent", () => {
    const sent = new Set(digestKeys(full));
    const fresh = onlyNew(full, sent);

    assert.deepEqual(fresh.breaches, breaches);
    assert.deepEqual([fresh.tightStops, fresh.armed, fresh.escalated], [[], [], []]);
  });

  it("a lots warning is never marked as sent: it comes back in every digest while it lasts", () => {
    const lotsWarnings = ["portfolio.md (USD): CAT: Volume 1 is not the sum of the Units of its lots (3)"];
    const withLots = digest({ lotsWarnings });
    assert.deepEqual(digestKeys(withLots), []);
    assert.deepEqual(onlyNew(withLots, new Set(digestKeys(withLots))).lotsWarnings, lotsWarnings);
  });

  it("the lots section says what it covers: the owner-approved label, heading, intro and closing (#69)", () => {
    const email = renderHeartbeatDigest(digest({ lotsWarnings: ["portfolio.md (USD): Lots row 1 skipped"] }))!;

    assert.match(email.subject, /problema con los lotes/);
    assert.doesNotMatch(email.subject, /no cuadran/);
    assert.match(email.body, /## `portfolio\.md`: problema con los lotes/);
    const text = email.body.replace(/\s+/g, " ");
    assert.match(
      text,
      /La tabla `Lots` no se puede leer, falta, o no concuerda con `Positions` o con el registro de decisiones\. El heartbeat sigue/,
    );
    assert.match(
      text,
      /Corrige `Lots` a mano: que exista y se lea, que cada `Volume` sea la suma de las `Units` de sus lotes y cada `Entry id` sea una entrada del registro/,
    );
  });

  it("the crossed stop leaves no key: there is nothing to remember", () => {
    assert.ok(!digestKeys(digest({ breaches })).length);
  });

  it("a tight stop warns again if the stop changes", () => {
    const sent = new Set(digestKeys(digest({ tightStops })));
    const moved = detectTightStops(
      [position({ stopLoss: 499 })],
      new Map([["MSFT", 501.02]]),
      new Map([["MSFT", 9.67]]),
    );

    assert.equal(onlyNew(digest({ tightStops: moved }), sent).tightStops.length, 1);
  });

  it("an escalated signal with other triggers is new", () => {
    const sent = new Set(digestKeys(digest({ escalated })));
    const other: Signal[] = [{ ...escalated[0], triggers: ["big_move", "approaching_stop"] }];

    assert.equal(onlyNew(digest({ escalated: other }), sent).escalated.length, 1);
  });
});
