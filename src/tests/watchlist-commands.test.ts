/**
 * The `watch` and `stop_watching` commands (#140, spec #124): how a batch reads them, what the handlers do to the
 * watchlist of the state, and how the runner of the inbox checks them (pure: no vault).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTicker as tk } from "../ticker.js";
import { parseBatch } from "../utils/inbox-parse.js";
import { applyCommand, type BatchContext, type Command, type InboxState } from "../utils/inbox-handlers.js";
import { runFiles, type InboxRun, type RunContext } from "../utils/inbox-check.js";
import { stateOf, watched } from "./fixtures/inbox.js";

const batch = (...commands: string[]): string =>
  `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;

const WATCH = "command: watch\ncurrency: USD\nticker: AMD";

describe("reading watch and stop_watching", () => {
  const read = (text: string) => parseBatch(batch(text));

  it("reads a watch with only its currency and ticker", () => {
    assert.deepEqual(read(WATCH).commands[0].command, { kind: "watch", currency: "USD", ticker: "AMD" });
  });

  it("reads a watch with a note, a date, a horizon and an asset class", () => {
    const { commands, issues } = read(
      `${WATCH}\nnote: Data-center share gains\ndate: 2026-11-20\nhorizon: short\nasset_class: etf`,
    );
    assert.deepEqual(issues, []);
    assert.deepEqual(commands[0].command, {
      kind: "watch",
      currency: "USD",
      ticker: "AMD",
      note: "Data-center share gains",
      date: "2026-11-20",
      horizon: "short",
      assetClass: "etf",
    });
  });

  it("reads a ticker written in lower case as its upper-case value", () => {
    assert.equal(
      (read("command: watch\ncurrency: EUR\nticker: air.pa").commands[0].command as { ticker: string }).ticker,
      "AIR.PA",
    );
  });

  it("reads a stop_watching with a ticker, and with a reason", () => {
    assert.deepEqual(read("command: stop_watching\nticker: AMD").commands[0].command, {
      kind: "stop_watching",
      ticker: "AMD",
    });
    assert.deepEqual(read("command: stop_watching\nticker: AMD\nreason: thesis invalidated").commands[0].command, {
      kind: "stop_watching",
      ticker: "AMD",
      reason: "thesis invalidated",
    });
  });

  it("refuses what does not read, one reason per problem, and never makes a command of it", () => {
    const problems = (text: string): string[] => read(text).issues.map((i) => i.reason);
    assert.match(problems("command: watch\nticker: AMD").join(), /missing field "currency"/);
    assert.match(problems("command: watch\ncurrency: GBP\nticker: AMD").join(), /"currency" must be EUR or USD/);
    assert.match(problems("command: watch\ncurrency: USD").join(), /missing field "ticker"/);
    assert.match(problems("command: watch\ncurrency: USD\nticker: TC|K").join(), /TC\|K/);
    assert.match(problems(`${WATCH}\ndate: 2026-02-30`).join(), /"date" must be a calendar date/);
    assert.match(problems(`${WATCH}\nhorizon: long`).join(), /"horizon" must be short or medium/);
    assert.match(problems(`${WATCH}\nasset_class: bond`).join(), /"asset_class" must be equity, commodity, etf/);
    assert.match(problems(`${WATCH}\nthesis: x`).join(), /unknown field "thesis" for a watch/);
    assert.match(problems("command: stop_watching").join(), /missing field "ticker"/);
    assert.match(problems("command: stop_watching\nticker: AMD\ncurrency: USD").join(), /unknown field "currency"/);
    assert.deepEqual(read(WATCH.replace("USD", "GBP")).commands, []);
  });
});

describe("the handlers of the watchlist", () => {
  const context = (over: Partial<BatchContext> = {}): BatchContext => ({
    opened: new Map(),
    earlierTickers: new Set(),
    newEntryId: () => "x",
    rulesVersion: "1.0",
    entryCostsTaken: new Map(),
    awaiting: new Set(),
    entry: { history: [], cited: new Set(), atr: new Map(), minStopAtr: 2 },
    today: "2026-11-27",
    ...over,
  });
  const apply = (state: InboxState, command: Command) => applyCommand(state, command, context());
  const watch = (extra: Partial<Extract<Command, { kind: "watch" }>> = {}): Command => ({
    kind: "watch",
    currency: "USD",
    ticker: tk("AMD"),
    ...extra,
  });

  it("watch adds the ticker with its note as the thesis and the day of the run when it gives no date", () => {
    const result = apply({ watchlist: [] }, watch({ note: "Share gains" }));
    assert.ok("state" in result);
    assert.deepEqual(result.state.watchlist, [
      { ticker: "AMD", currency: "USD", horizon: "medium", thesis: "Share gains", date: "2026-11-27" },
    ]);
  });

  it("watch keeps the date, the horizon and the asset class it is given, and the entries already on the list", () => {
    const result = apply(
      { watchlist: [watched("KO", "USD")] },
      watch({ date: "2026-11-01", horizon: "short", assetClass: "commodity" }),
    );
    assert.ok("state" in result);
    assert.deepEqual(result.state.watchlist, [
      watched("KO", "USD"),
      {
        ticker: "AMD",
        currency: "USD",
        horizon: "short",
        asset_class: "commodity",
        thesis: "",
        date: "2026-11-01",
      },
    ]);
  });

  it("watch is refused for a ticker that is on the list already, in whichever silo", () => {
    for (const currency of ["USD", "EUR"] as const) {
      const result = apply({ watchlist: [watched("AMD", currency)] }, watch());
      assert.ok("reason" in result);
      assert.match(result.reason, new RegExp(`AMD is already on the watchlist \\(${currency} silo\\)`));
    }
  });

  it("stop_watching takes the ticker off and leaves the others", () => {
    const result = apply(
      { watchlist: [watched("KO", "USD"), watched("AMD", "USD")] },
      { kind: "stop_watching", ticker: tk("AMD"), reason: "thesis invalidated" },
    );
    assert.ok("state" in result);
    assert.deepEqual(result.state.watchlist, [watched("KO", "USD")]);
  });

  it("stop_watching is refused for a ticker that is not on the list, with an empty or no watchlist alike", () => {
    for (const state of [{ watchlist: [watched("KO", "USD")] }, { watchlist: [] }, {}]) {
      const result = apply(state, { kind: "stop_watching", ticker: tk("AMD") });
      assert.ok("reason" in result);
      assert.match(result.reason, /AMD is not on the watchlist/);
    }
  });

  it("changes neither the silos nor the other part of the state", () => {
    const state = stateOf();
    const result = apply(state, watch());
    assert.ok("state" in result);
    assert.equal(result.state.EUR, state.EUR);
    assert.equal(result.state.USD, state.USD);
  });
});

describe("running a batch with watch and stop_watching", () => {
  const run = (state: InboxState, ...files: string[]): InboxRun => {
    const context: RunContext = {
      awaiting: new Set(),
      rulesVersion: "1.0",
      takenIds: new Set(),
      entryCostsTaken: new Map(),
      entry: { history: [], atr: new Map(), minStopAtr: 2 },
      today: "2026-11-27",
    };
    return runFiles(
      state,
      files.map((text, i) => ({ name: `${i + 1}.yaml`, text })),
      context,
    );
  };
  const BUY_AMD = "command: buy\nticker: AMD\ndate: 2026-11-27\nunits: 1\nprice: 100 USD";
  const violations = (result: InboxRun, file = 0): readonly string[] | undefined => {
    const [trade] = result.checks[file].trades;
    return trade?.kind === "buy" ? trade.lot.rulesViolations : undefined;
  };
  const empty = (): InboxState => ({ ...stateOf({}, {}, []), watchlist: [] });

  it("a watch and its buy in one batch are valid: the buy is not flagged as outside the watchlist", () => {
    const result = run(empty(), batch(WATCH, BUY_AMD));
    assert.equal(result.checks[0].clean, true, JSON.stringify(result.checks[0].issues));
    assert.deepEqual(violations(result), ["entry_without_setup", "no_stop"]);
    assert.deepEqual(
      result.state.watchlist?.map((e) => e.ticker),
      ["AMD"],
    );
  });

  it("the buy of a ticker that is not on the list is flagged, and one of an earlier batch's watch is not", () => {
    assert.deepEqual(violations(run(empty(), batch(BUY_AMD))), ["not_in_watchlist", "no_stop"]);
    const later = run(empty(), batch(WATCH), batch(BUY_AMD));
    assert.deepEqual(violations(later, 1), ["entry_without_setup", "no_stop"]);
  });

  it("a stop_watching earlier in the batch makes the buy of the ticker flagged again", () => {
    const state = { ...stateOf({}, {}, []), watchlist: [watched("AMD", "USD")] };
    const result = run(state, batch("command: stop_watching\nticker: AMD", BUY_AMD));
    assert.deepEqual(violations(result), ["not_in_watchlist", "no_stop"]);
  });

  it("a watch in the silo of the buy only: the same ticker watched in the other silo does not count", () => {
    const state = { ...stateOf({}, {}, []), watchlist: [watched("AMD", "EUR")] };
    assert.deepEqual(violations(run(state, batch(BUY_AMD))), ["not_in_watchlist", "no_stop"]);
  });

  it("a refused watch or stop_watching is an error of its command and a batch with one changes nothing", () => {
    const state = { ...empty(), watchlist: [watched("AMD", "USD")] };
    const result = run(state, batch("command: deposit\namount: 10 EUR", WATCH));
    const [check] = result.checks;
    assert.equal(check.clean, false);
    assert.deepEqual(
      check.issues.map((i) => [i.command, i.reason]),
      [[2, "AMD is already on the watchlist (USD silo): a ticker is watched once"]],
    );
    assert.equal(result.state, state, "a batch with an error contributes nothing");
    const stop = run(empty(), batch("command: stop_watching\nticker: AMD"));
    assert.match(stop.checks[0].issues[0].reason, /AMD is not on the watchlist/);
  });

  it("a refused cash or lot command leaves a watch after it checked, and a refused watch leaves the cash commands after it checked", () => {
    const overdraw = "command: withdrawal\namount: 99999 USD";
    const first = run(empty(), batch(overdraw, WATCH));
    assert.deepEqual(
      first.checks[0].issues.map((i) => i.command),
      [1],
    );
    assert.deepEqual(first.checks[0].notChecked, [], "the watch does not depend on the cash");
    const second = run(
      { ...empty(), watchlist: [watched("AMD", "USD")] },
      batch(WATCH, "command: deposit\namount: 10 USD", BUY_AMD),
    );
    assert.deepEqual(
      second.checks[0].issues.map((i) => i.command),
      [1],
    );
    assert.deepEqual(second.checks[0].notChecked, [], "nothing after a refused watch is unknown");
  });

  it("a batch with a watch and nothing else is clean and makes no trade", () => {
    const result = run(empty(), batch(WATCH, "command: watch\ncurrency: EUR\nticker: AIR.PA\nnote: Backlog"));
    assert.equal(result.checks[0].clean, true);
    assert.deepEqual(result.checks[0].trades, []);
    assert.deepEqual(result.checks[0].warnings, []);
    assert.deepEqual(
      result.state.watchlist?.map((e) => [e.ticker, e.currency, e.thesis]),
      [
        ["AMD", "USD", ""],
        ["AIR.PA", "EUR", "Backlog"],
      ],
    );
  });
});
