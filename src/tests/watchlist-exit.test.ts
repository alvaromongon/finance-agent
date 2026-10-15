// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mechanicalExits, type WatchlistExitInput } from "../utils/watchlist-exit.js";
import { extend, uptrend } from "./fixtures/setup-bars.js";
import type { RankableTicker, RankedTicker } from "../screening-ranking.js";
import type { HistoricalBar } from "../providers/types.js";
import type { Currency, WatchlistEntry } from "../types.js";
import { en } from "../i18n/en.js";
import { describeExit, describeExitDetail } from "../utils/screening-helpers.js";

const entry = (ticker: string, currency: Currency = "USD"): WatchlistEntry => ({
  ticker,
  name: ticker,
  market: currency === "USD" ? "NYSE" : "Xetra",
  currency,
  horizon: "medium",
  thesis: "t",
});

// Linear rise without pullbacks or bases: no detector fires (ADR-0013).
const flat = uptrend(260);
// Pullback to the SMA20 and bounce on the last session: pullback confirmed.
const top = flat[flat.length - 1].close;
const withSetup = extend(flat, [top - 1.5, top - 3, top - 4.5, [top - 5, { low: top - 6 }], top - 2]);
const lastDate = (bars: HistoricalBar[]) => bars[bars.length - 1].date;

const ranked = (
  ticker: string,
  rank: number,
  bars: HistoricalBar[] = flat,
  currency: Currency = "USD",
): RankedTicker<RankableTicker> => ({
  item: { ticker, currency },
  rank,
  score: 0.5,
  proximity: 1,
  relativeStrength: 0,
  bars,
});

/** USD silo of 10 eligibles: the first 5 are the top half. */
function input(over: Partial<WatchlistExitInput> = {}): WatchlistExitInput {
  const usd = Array.from({ length: 10 }, (_, i) => ranked(`R${i + 1}`, i + 1));
  return {
    watchlist: [],
    held: new Set(),
    universe: new Set(usd.map((r) => r.item.ticker)),
    ranking: { bySilo: { EUR: [], USD: usd }, excluded: [] },
    addedOn: new Map(),
    today: lastDate(flat),
    ...over,
  };
}

describe("mechanicalExits", () => {
  it("keeps what stays in the top half of its silo", () => {
    assert.deepEqual(mechanicalExits(input({ watchlist: [entry("R1"), entry("R5")] })), []);
  });

  it("removes what falls out of the silo's top half, with the rank", () => {
    const exits = mechanicalExits(input({ watchlist: [entry("R6")] }));
    assert.deepEqual(exits, [{ ticker: "R6", reason: "out_of_top", rank: 6, of: 10, currency: "USD" }]);
    assert.equal(describeExitDetail(exits[0]), "puesto 6 de 10 en el silo USD");
  });

  it("in English", () => {
    const exits = mechanicalExits(input({ watchlist: [entry("R6"), entry("GONE")] }));
    assert.deepEqual(
      exits.map((e) => describeExitDetail(e, en)),
      ["rank 6 of 10 in the USD silo", "not in screening-universe.md"],
    );
    assert.equal(describeExit(exits[0], en), "out of the top half of the ranking: rank 6 of 10 in the USD silo");
  });

  it("removes what breaks filter 0 because of the security itself, not a data failure", () => {
    const base = input();
    const exits = mechanicalExits({
      ...base,
      watchlist: [entry("LOW"), entry("THIN"), entry("YOUNG"), entry("GAP"), entry("OLD")],
      universe: new Set([...base.universe, "LOW", "THIN", "YOUNG", "GAP", "OLD"]),
      ranking: {
        ...base.ranking,
        excluded: [
          { ticker: "LOW", reason: "below_sma200" },
          { ticker: "THIN", reason: "illiquid" },
          { ticker: "YOUNG", reason: "short_history" },
          { ticker: "GAP", reason: "no_data" },
          { ticker: "OLD", reason: "stale" },
        ],
      },
    });
    assert.deepEqual(
      exits.map((e) => [e.ticker, e.reason, describeExitDetail(e)]),
      [
        ["LOW", "filter_zero", "below_sma200"],
        ["THIN", "filter_zero", "illiquid"],
        ["YOUNG", "filter_zero", "short_history"],
      ],
    );
  });

  it("removes what is outside the universe: the ranking cannot back it", () => {
    assert.deepEqual(mechanicalExits(input({ watchlist: [entry("UNH")] })), [
      { ticker: "UNH", reason: "out_of_universe" },
    ]);
  });

  it("removes what has spent 4 weeks or more in the watchlist without any setup in that time", () => {
    const addedOn = new Map([["R1", "2025-08-01"]]);
    assert.deepEqual(mechanicalExits(input({ watchlist: [entry("R1")], addedOn })), [
      { ticker: "R1", reason: "no_setup", weeks: 4 },
    ]);
    assert.equal(
      describeExitDetail({ ticker: "R1", reason: "no_setup", weeks: 4 }),
      "sin setup en las últimas 4 semanas",
    );
  });

  it("does not remove for lack of a setup one with less than 4 weeks or without a date added", () => {
    const today = lastDate(flat);
    const threeWeeksAgo = new Date(Date.parse(today) - 21 * 86_400_000).toISOString().slice(0, 10);
    const addedOn = new Map([["R1", threeWeeksAgo]]);
    assert.deepEqual(mechanicalExits(input({ watchlist: [entry("R1"), entry("R2")], addedOn })), []);
  });

  it("a setup in the last 4 weeks keeps it, eligible or not", () => {
    const base = input();
    const usd = base.ranking.bySilo.USD.map((r) => (r.item.ticker === "R1" ? ranked("R1", 1, withSetup) : r));
    const exits = mechanicalExits({
      ...base,
      watchlist: [entry("R1")],
      ranking: { ...base.ranking, bySilo: { ...base.ranking.bySilo, USD: usd } },
      addedOn: new Map([["R1", "2025-01-01"]]),
      today: lastDate(withSetup),
    });
    assert.deepEqual(exits, []);
  });

  it("never removes a security with an open position", () => {
    const exits = mechanicalExits(input({ watchlist: [entry("R6"), entry("UNH")], held: new Set(["R6", "UNH"]) }));
    assert.deepEqual(exits, []);
  });

  it("measures the cutoff within each silo", () => {
    const base = input();
    const eur = ["E1", "E2", "E3", "E4"].map((t, i) => ranked(t, i + 1, flat, "EUR"));
    const exits = mechanicalExits({
      ...base,
      watchlist: [entry("E2", "EUR"), entry("E3", "EUR")],
      universe: new Set([...base.universe, "E1", "E2", "E3", "E4"]),
      ranking: { ...base.ranking, bySilo: { ...base.ranking.bySilo, EUR: eur } },
    });
    assert.deepEqual(
      exits.map((e) => [e.ticker, describeExitDetail(e)]),
      [["E3", "puesto 3 de 4 en el silo EUR"]],
    );
  });
});
