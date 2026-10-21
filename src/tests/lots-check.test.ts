import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertLotsMatch, lotsMismatches } from "../utils/lots-check.js";
import { buildDecision, type Decision } from "../decisions.js";
import type { Lot, PortfolioSnapshot, Position } from "../types.js";

const entry = (id: string, ticker: string, currency: "EUR" | "USD" = "USD"): Decision =>
  buildDecision({
    id,
    date: "2026-06-15",
    ticker,
    currency,
    origin: "sistema",
    source: "portfolio-sync",
    type: "entry",
    price: 100,
    amount: 1000,
    rules_version: "1.0",
  });

const position = (ticker: string, volume: number): Position => ({
  ticker,
  currency: "USD",
  volume,
  avgPrice: 100,
  currentPrice: 100,
  pl: 0,
  stopLoss: null,
});

const lot = (entryId: string, units: number): Lot => ({
  entryId,
  date: "2026-06-15",
  units,
  entryUnits: units,
  entryPrice: 100,
  initialStop: 90,
  entryCosts: null,
  origin: "sistema",
  rulesVersion: "1.0",
  rulesViolations: [],
});

const portfolio = (positions: Position[], lots: Lot[]): PortfolioSnapshot => ({
  currency: "USD",
  cash: 0,
  positions,
  lots,
  syncedAt: "2026-10-16T18:00:00.000Z",
});

describe("lotsMismatches", () => {
  const log = [entry("a", "TCK"), entry("b", "TCK"), entry("c", "OTH")];

  it("is empty when every Volume is the sum of the units of its lots", () => {
    const p = portfolio([position("TCK", 15), position("OTH", 5)], [lot("a", 10), lot("b", 5), lot("c", 5)]);
    assert.deepEqual(lotsMismatches(p, log), []);
  });

  it("is empty for an empty silo", () => {
    assert.deepEqual(lotsMismatches(portfolio([], []), []), []);
  });

  it("names the ticker whose Volume is not the sum of its lots", () => {
    const p = portfolio([position("TCK", 7)], [lot("a", 5)]);
    const [message, ...rest] = lotsMismatches(p, log);
    assert.equal(rest.length, 0);
    assert.match(message, /TCK.*Volume 7.*5/);
  });

  it("flags a position with no lots at all", () => {
    const [message] = lotsMismatches(portfolio([position("TCK", 3)], []), log);
    assert.match(message, /TCK.*Volume 3.*0/);
  });

  it("flags lots of a ticker that has no position row", () => {
    const [message] = lotsMismatches(portfolio([], [lot("c", 5)]), log);
    assert.match(message, /OTH.*Volume 0.*5/);
  });

  it("flags a lot whose entry id is not in the decision log, naming the id", () => {
    const messages = lotsMismatches(portfolio([position("TCK", 5)], [lot("a", 5), lot("ghost", 2)]), log);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /ghost.*decision log/);
  });

  it("flags a lot whose id belongs to a decision that is not an entry", () => {
    const sell = buildDecision({
      id: "s",
      date: "2026-06-15",
      ticker: "TCK",
      currency: "USD",
      origin: "sistema",
      source: "portfolio-sync",
      type: "exit",
      price: 100,
      amount: 100,
      rules_version: "1.0",
    });
    const [message] = lotsMismatches(portfolio([position("TCK", 5)], [lot("s", 5)]), [sell]);
    assert.match(message, /s.*not an entry/);
  });

  it("flags a lot whose entry was recorded in the other currency", () => {
    const [message] = lotsMismatches(portfolio([position("TCK", 5)], [lot("e", 5)]), [entry("e", "TCK", "EUR")]);
    assert.match(message, /e.*EUR.*USD/);
  });

  it("tolerates float noise in the sum", () => {
    const p = portfolio([position("TCK", 0.3)], [lot("a", 0.1), lot("b", 0.2)]);
    assert.deepEqual(lotsMismatches(p, log), []);
  });
});

describe("assertLotsMatch", () => {
  it("throws one error naming every problem", () => {
    const p = portfolio([position("TCK", 7)], [lot("ghost", 2)]);
    assert.throws(
      () => assertLotsMatch(p, [entry("a", "TCK")]),
      (err: Error) =>
        err.message.includes("TCK") && err.message.includes("ghost") && err.message.includes("portfolio.md"),
    );
  });

  it("does not throw when everything matches", () => {
    assert.doesNotThrow(() => assertLotsMatch(portfolio([], []), []));
  });
});
