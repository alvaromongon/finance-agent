/**
 * The format of an inbox file (#131, docs/input-format.md › `inbox/`): YAML text into commands, with the line
 * and the reason of everything that does not read. Pure: no vault.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBatch } from "../utils/inbox-parse.js";

const batch = (...commands: string[]): string =>
  `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;

const issuesOf = (text: string) => parseBatch(text).issues.map((i) => [i.command, i.line, i.reason] as const);
/** The one problem of a batch with one bad command. */
const problem = (command: string): string => {
  const { issues } = parseBatch(batch(command));
  assert.equal(issues.length, 1, JSON.stringify(issues));
  return issues[0].reason;
};

describe("inbox format", () => {
  it("reads a deposit's optional date, as a conversion's, and refuses a withdrawal's (#202)", () => {
    const { commands, issues } = parseBatch(batch("command: deposit\namount: 5 EUR\ndate: 2026-09-01"));
    assert.deepEqual(issues, []);
    assert.deepEqual(commands[0].command, { kind: "deposit", currency: "EUR", amount: 5, date: "2026-09-01" });
    assert.match(problem("command: deposit\namount: 5 EUR\ndate: 2026-02-30"), /"date" must be a calendar date/);
    assert.match(problem("command: withdrawal\namount: 5 EUR\ndate: 2026-09-01"), /date/);
  });

  it("reads the commands with their amounts, currency and optional fields", () => {
    const { commands, issues } = parseBatch(
      batch(
        "command: deposit\namount: 1000.50 EUR",
        "command: withdrawal\namount: 200 USD",
        "command: buy\nticker: sap.de\ndate: 2026-09-15\nunits: 2\nprice: 180.25 EUR\ncosts: 1.50 EUR",
        "command: set_stop\nticker: sap.de\nprice: 168 EUR\ndate: 2026-09-15",
        "command: clear_stop\nticker: SAP.DE",
        "command: sale\nticker: SAP.DE\ndate: 2026-09-20\nunits: 1.5\nprice: 190 EUR\nlot: lot-1\nstop_executed: true",
      ),
    );
    assert.deepEqual(issues, []);
    assert.deepEqual(
      commands.map(({ position, line, command }) => [position, line, command]),
      [
        [1, 3, { kind: "deposit", currency: "EUR", amount: 1000.5 }],
        [2, 5, { kind: "withdrawal", currency: "USD", amount: 200 }],
        [
          3,
          7,
          {
            kind: "buy",
            currency: "EUR",
            ticker: "SAP.DE",
            date: "2026-09-15",
            units: 2,
            price: 180.25,
            costs: 1.5,
          },
        ],
        [4, 13, { kind: "set_stop", currency: "EUR", ticker: "SAP.DE", price: 168, date: "2026-09-15" }],
        [5, 17, { kind: "clear_stop", ticker: "SAP.DE" }],
        [
          6,
          19,
          {
            kind: "sale",
            currency: "EUR",
            ticker: "SAP.DE",
            date: "2026-09-20",
            units: 1.5,
            price: 190,
            lot: "lot-1",
            stopExecuted: true,
          },
        ],
      ],
    );
  });

  describe("amounts: plain decimal notation with a currency", () => {
    for (const written of [
      "1e3 EUR",
      "1,000.50 EUR",
      "1.000,50 EUR",
      "-5 EUR",
      "+5 EUR",
      ".5 EUR",
      "5. EUR",
      "0x10 EUR",
      "1_000 EUR",
      "€100",
    ]) {
      it(`refuses ${written}`, () => {
        assert.match(
          problem(`command: deposit\namount: "${written}"`),
          /plain decimal|must be a plain decimal number and its currency/,
        );
      });
    }

    it("refuses an amount without a currency, written as a number or as text", () => {
      assert.match(problem("command: deposit\namount: 100"), /"amount" needs its currency/);
      assert.match(problem('command: deposit\namount: "100.5"'), /"amount" needs its currency/);
    });

    it("refuses an unknown currency", () => {
      assert.match(problem("command: deposit\namount: 100 GBP"), /unknown currency "GBP" \(EUR or USD\)/);
      assert.match(problem("command: deposit\namount: 100 eur"), /unknown currency "eur"/);
    });

    it("refuses zero, more than two decimals for money, and a number too large to count", () => {
      assert.match(problem("command: deposit\namount: 0 EUR"), /greater than zero/);
      assert.match(problem("command: deposit\namount: 10.005 EUR"), /more than two decimals/);
      assert.match(problem(`command: deposit\namount: ${"9".repeat(320)} EUR`), /too large/);
    });

    it("lets a price have more decimals than a cent", () => {
      const { commands, issues } = parseBatch(
        batch("command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 3\nprice: 0.00432 USD"),
      );
      assert.deepEqual(issues, []);
      assert.equal(commands[0].command.kind === "buy" && commands[0].command.price, 0.00432);
    });

    it("refuses the units in another notation", () => {
      assert.match(
        problem("command: sale\nticker: TCK\ndate: 2026-09-15\nunits: 1e2\nprice: 1 USD"),
        /"units" must be a plain decimal/,
      );
      assert.match(
        problem("command: sale\nticker: TCK\ndate: 2026-09-15\nunits: 1,5\nprice: 1 USD"),
        /"units" must be a plain decimal/,
      );
      assert.match(
        problem("command: sale\nticker: TCK\ndate: 2026-09-15\nunits: 0\nprice: 1 USD"),
        /"units" must be greater than zero/,
      );
    });

    it("refuses one command in two currencies", () => {
      assert.match(
        problem("command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 1\nprice: 10 USD\ncosts: 1 EUR"),
        /"costs" is in EUR but "price" is in USD/,
      );
      assert.match(
        problem("command: set_stop\nticker: TCK\nprice: 9 EUR\ndate: 2026-09-15\ncosts: 1 USD"),
        /unknown field "costs" for a set_stop/,
      );
    });
  });

  describe("a split (#137)", () => {
    it("reads the ticker, the date and the ratio as two plain decimals: new units for old", () => {
      const { commands, issues } = parseBatch(
        batch(
          "command: split\nticker: NVDA\ndate: 2026-06-10\nratio: 4 for 1",
          "command: split\nticker: sap.de\ndate: 2026-06-10\nratio: 1 for 10",
          "command: split\nticker: KO\ndate: 2026-06-10\nratio: 3 for 2",
          "command: split\nticker: KO\ndate: 2026-06-10\nratio:   1.5   for   1.0 ",
        ),
      );
      assert.deepEqual(issues, []);
      assert.deepEqual(
        commands.map(({ command }) => command),
        [
          { kind: "split", ticker: "NVDA", date: "2026-06-10", ratio: { new: 4, old: 1 } },
          { kind: "split", ticker: "SAP.DE", date: "2026-06-10", ratio: { new: 1, old: 10 } },
          { kind: "split", ticker: "KO", date: "2026-06-10", ratio: { new: 3, old: 2 } },
          { kind: "split", ticker: "KO", date: "2026-06-10", ratio: { new: 1.5, old: 1 } },
        ],
      );
    });

    it("needs the ticker, the date and the ratio", () => {
      assert.match(problem("command: split\ndate: 2026-06-10\nratio: 4 for 1"), /missing field "ticker"/);
      assert.match(problem("command: split\nticker: NVDA\nratio: 4 for 1"), /missing field "date"/);
      assert.match(problem("command: split\nticker: NVDA\ndate: 2026-06-10"), /missing field "ratio"/);
      assert.match(
        problem("command: split\nticker: NVDA\ndate: 2026-6-10\nratio: 4 for 1"),
        /"date" must be a calendar date/,
      );
    });

    it("writes the ratio as <new> for <old>, each a plain decimal number greater than zero", () => {
      const bad = (ratio: string) => problem(`command: split\nticker: NVDA\ndate: 2026-06-10\nratio: ${ratio}`);
      for (const ratio of ["4", "4:1", "4 to 1", "4 for", "for 1", "4 for 1 for 2", "4 For 1"]) {
        assert.match(bad(ratio), /"ratio" must be written as <new> for <old>, such as 4 for 1 or 1 for 10/, ratio);
      }
      assert.match(bad("-4 for 1"), /"ratio" must be a plain decimal number/);
      assert.match(bad("4 for -1"), /"ratio" must be a plain decimal number/);
      assert.match(bad("1e1 for 1"), /"ratio" must be a plain decimal number/);
      assert.match(bad("0 for 1"), /"ratio" must be greater than zero/);
      assert.match(bad("4 for 0"), /"ratio" must be greater than zero/);
    });

    it("reads a ratio of 1 and leaves refusing it to the handler, with the command's position", () => {
      const { commands, issues } = parseBatch(batch("command: split\nticker: KO\ndate: 2026-06-10\nratio: 2 for 2"));
      assert.deepEqual(issues, []);
      assert.deepEqual(commands[0].command, {
        kind: "split",
        ticker: "KO",
        date: "2026-06-10",
        ratio: { new: 2, old: 2 },
      });
    });

    it("takes no currency, amount or other field of another command", () => {
      assert.match(
        problem("command: split\nticker: KO\ndate: 2026-06-10\nratio: 2 for 1\nprice: 5 USD"),
        /unknown field "price" for a split/,
      );
    });

    it("a split that does not read is listed as unread with its ticker, with no currency", () => {
      const { unread } = parseBatch(batch("command: split\nticker: KO\ndate: 2026-06-10\nratio: nope"));
      assert.deepEqual(unread, [{ position: 1, currencies: [], kind: "split", ticker: "KO" }]);
    });
  });

  describe("a snapshot of the broker (#138)", () => {
    const snap = (extra = "positions:\n  - ticker: sap.de\n    units: 10\n  - ticker: KO\n    units: 2.5") =>
      `command: snapshot\ndate: 2026-11-20\ncash: 1234.56 EUR${extra === "" ? "" : `\n${extra}`}`;

    it("reads the date, the cash with its currency and the positions as ticker and units", () => {
      const { commands, issues } = parseBatch(batch(snap()));
      assert.deepEqual(issues, []);
      assert.deepEqual(commands[0].command, {
        kind: "snapshot",
        currency: "EUR",
        date: "2026-11-20",
        cash: 1234.56,
        positions: [
          { ticker: "SAP.DE", units: 10 },
          { ticker: "KO", units: 2.5 },
        ],
      });
    });

    it("reads a broker that holds nothing: no positions, and zero cash", () => {
      const { commands, issues } = parseBatch(batch("command: snapshot\ndate: 2026-11-20\ncash: 0 USD\npositions: []"));
      assert.deepEqual(issues, []);
      assert.deepEqual(commands[0].command, {
        kind: "snapshot",
        currency: "USD",
        date: "2026-11-20",
        cash: 0,
        positions: [],
      });
    });

    it("needs the date, the cash and the list of positions", () => {
      assert.match(problem("command: snapshot\ncash: 1 EUR\npositions: []"), /missing field "date"/);
      assert.match(problem("command: snapshot\ndate: 2026-11-20\npositions: []"), /missing field "cash"/);
      assert.match(problem("command: snapshot\ndate: 2026-11-20\ncash: 1 EUR"), /missing field "positions"/);
      assert.match(problem("command: snapshot\ndate: 2026-11-20\ncash: 1 EUR\npositions:"), /"positions" is empty/);
      assert.match(
        problem("command: snapshot\ndate: 2026-11-20\ncash: 1 EUR\npositions: SAP.DE"),
        /"positions" must be a list/,
      );
    });

    it("needs the currency of the cash, the one of the silo", () => {
      assert.match(
        problem("command: snapshot\ndate: 2026-11-20\ncash: 10\npositions: []"),
        /"cash" needs its currency/,
      );
      assert.match(
        problem("command: snapshot\ndate: 2026-11-20\ncash: 1.234 EUR\npositions: []"),
        /"cash" must not have more than two decimals/,
      );
    });

    it("refuses a ticker that repeats, naming it", () => {
      assert.match(
        problem(snap("positions:\n  - ticker: KO\n    units: 1\n  - ticker: ko\n    units: 2")),
        /position 2: "KO" is listed twice/,
      );
    });

    it("refuses a position that is not a ticker and plain units greater than zero, naming its place in the list", () => {
      const bad = (item: string) => problem(snap(`positions:\n  - ${item.replace(/\n/g, "\n    ")}`));
      assert.match(bad("units: 1"), /position 1: missing field "ticker"/);
      assert.match(bad("ticker: KO"), /position 1: missing field "units"/);
      assert.match(bad("ticker: KO\nunits: -1"), /position 1: "units" must be a plain decimal number/);
      assert.match(bad("ticker: KO\nunits: 0"), /position 1: "units" must be greater than zero/);
      assert.match(bad("ticker: KO\nunits: 1\nprice: 5 USD"), /position 1: unknown field "price"/);
      assert.match(bad("ticker: ..\nunits: 1"), /position 1: /);
      assert.match(problem(snap("positions:\n  - KO")), /position 1: must be a mapping of ticker and units/);
    });

    it("takes no other field of another command", () => {
      assert.match(problem(`${snap()}\nprice: 5 EUR`), /unknown field "price" for a snapshot/);
    });

    it("a snapshot that does not read is listed as unread with its currency and no ticker", () => {
      const { unread } = parseBatch(batch("command: snapshot\ndate: nope\ncash: 1 USD\npositions: []"));
      assert.deepEqual(unread, [{ position: 1, currencies: ["USD"], kind: "snapshot", ticker: undefined }]);
    });
  });

  describe("a conversion between the silos (#135)", () => {
    it("reads the amount taken out and what arrived, or the rate, with optional costs and date", () => {
      const { commands, issues } = parseBatch(
        batch(
          "command: convert\namount: 1000 EUR\nreceived: 1160.50 USD\ncosts: 5 EUR\ndate: 2026-09-15",
          "command: convert\namount: 200 USD\nrate: 0.9",
        ),
      );
      assert.deepEqual(issues, []);
      assert.deepEqual(
        commands.map(({ command }) => command),
        [
          { kind: "convert", from: "EUR", to: "USD", amount: 1000, received: 1160.5, costs: 5, date: "2026-09-15" },
          { kind: "convert", from: "USD", to: "EUR", amount: 200, rate: 0.9 },
        ],
      );
    });

    it("needs the amount with its currency, and received or rate, one of the two", () => {
      assert.match(problem("command: convert\namount: 100 EUR"), /"received".*"rate": one of the two/);
      assert.match(problem("command: convert\namount: 100 EUR\nreceived: 116 USD\nrate: 1.16"), /not both/);
      assert.match(problem("command: convert\nreceived: 116 USD"), /missing field "amount"/);
      assert.match(problem("command: convert\namount: 100\nrate: 1.1"), /needs its currency/);
    });

    it("writes every number in plain decimal notation, greater than zero", () => {
      assert.match(problem("command: convert\namount: 100 EUR\nrate: 1e0"), /"rate" must be a plain decimal number/);
      assert.match(problem("command: convert\namount: 100 EUR\nrate: 0"), /"rate" must be greater than zero/);
      assert.match(problem("command: convert\namount: 100 EUR\nrate: -1.1"), /"rate" must be a plain decimal number/);
      assert.match(problem("command: convert\namount: 0 EUR\nreceived: 5 USD"), /"amount" must be greater than zero/);
      assert.match(problem("command: convert\namount: 5 EUR\nreceived: 0 USD"), /"received" must be greater than zero/);
      assert.match(
        problem("command: convert\namount: 100 EUR\nrate: 1.1\ncosts: 0 EUR"),
        /"costs" must be greater than zero/,
      );
    });

    it("takes the costs in the currency of the amount, and refuses fields of other commands", () => {
      assert.match(
        problem("command: convert\namount: 100 EUR\nrate: 1.1\ncosts: 1 USD"),
        /"costs" is in USD but "amount" is in EUR: one command, one currency/,
      );
      assert.match(
        problem("command: convert\namount: 100 EUR\nrate: 1.1\nticker: KO"),
        /unknown field "ticker" for a convert/,
      );
    });

    it("reads the same currency on both sides: the handler refuses it, with the command's position", () => {
      const { commands, issues } = parseBatch(batch("command: convert\namount: 100 EUR\nreceived: 100 EUR"));
      assert.deepEqual(issues, []);
      assert.deepEqual(commands[0].command, { kind: "convert", from: "EUR", to: "EUR", amount: 100, received: 100 });
    });
  });

  describe("stops are their own commands", () => {
    it("tells a field named like an Object property from a removed one: it is an unknown field", () => {
      for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        const reason = problem(`command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 1\nprice: 10 USD\n"${name}": 1`);
        assert.equal(reason, `unknown field "${name}" for a buy`);
      }
    });

    it("refuses a stop on a buy, and says which command sets it", () => {
      assert.match(
        problem("command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 1\nprice: 10 USD\nstop: 9 USD"),
        /a buy carries no "stop": set it with a set_stop command/,
      );
    });

    it("needs a price with its currency on set_stop, greater than zero, and a real date when one is given", () => {
      assert.match(problem("command: set_stop\nticker: TCK"), /missing field "price"/);
      assert.match(problem("command: set_stop\nticker: TCK\nprice: 9"), /needs its currency/);
      assert.match(problem("command: set_stop\nticker: TCK\nprice: 0 USD"), /"price" must be greater than zero/);
      assert.match(
        problem("command: set_stop\nticker: TCK\nprice: 9 USD\ndate: 2026-02-30"),
        /"date" must be a calendar date/,
      );
      assert.equal(parseBatch(batch("command: set_stop\nticker: TCK\nprice: 9 USD")).issues.length, 0);
    });

    it("clear_stop takes a ticker and an optional date only", () => {
      assert.match(problem("command: clear_stop"), /missing field "ticker"/);
      assert.match(problem("command: clear_stop\nticker: TCK\nprice: 9 USD"), /unknown field "price" for a clear_stop/);
      assert.match(problem("command: clear_stop\nticker: TCK\ndate: tomorrow"), /"date" must be a calendar date/);
    });
  });

  describe("fields", () => {
    it("reports a missing field, an unknown field, an unknown command and a command that is not a mapping", () => {
      assert.match(problem("command: deposit"), /missing field "amount"/);
      assert.match(problem("command: deposit\namount: 1 EUR\nnote: x"), /unknown field "note" for a deposit/);
      assert.match(problem("command: transfer\namount: 1 EUR"), /unknown command "transfer"/);
      assert.match(problem("amount: 1 EUR"), /missing field "command"/);
      assert.match(problem("just text"), /must be a mapping/);
    });

    it("reports a field that is a list or empty", () => {
      assert.match(problem("command: deposit\namount: [1, EUR]"), /field "amount" must be a value/);
      assert.match(problem('command: deposit\namount: ""'), /field "amount" is empty/);
    });

    it("says an empty field is empty, and refuses zero costs", () => {
      assert.match(problem('command: deposit\namount: ""'), /field "amount" is empty/);
      assert.match(problem("command: deposit\namount: [1, EUR]"), /must be a value, not a list or a mapping/);
      const buy = (costs: string) =>
        `command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 1\nprice: 10 USD\ncosts: ${costs}`;
      assert.match(problem(buy("0 USD")), /"costs" must be greater than zero/);
      assert.equal(parseBatch(batch(buy("0.5 USD"))).issues.length, 0);
    });

    it("reads a date as text and checks that it is a calendar date", () => {
      const sale = (date: string) => `command: sale\nticker: TCK\ndate: ${date}\nunits: 1\nprice: 1 USD`;
      assert.match(problem(sale("2026-02-30")), /"date" must be a calendar date/);
      assert.match(problem(sale("15/09/2026")), /"date" must be a calendar date/);
      assert.match(problem("command: sale\nticker: TCK\nunits: 1\nprice: 1 USD"), /missing field "date"/);
    });

    it("reads stop_executed as true or false only", () => {
      assert.match(
        problem("command: sale\nticker: TCK\ndate: 2026-09-15\nunits: 1\nprice: 1 USD\nstop_executed: yes"),
        /"stop_executed" must be true or false/,
      );
    });
  });

  describe("the ticker rule of docs/input-format.md (#93), applied here and nowhere else", () => {
    const withTicker = (ticker: string) =>
      `command: buy\nticker: "${ticker}"\ndate: 2026-09-15\nunits: 1\nprice: 1 USD`;

    it("reads a ticker case-insensitively and writes it in upper case", () => {
      const { commands } = parseBatch(batch(withTicker("brk-b")));
      assert.equal(commands[0].command.kind === "buy" && commands[0].command.ticker, "BRK-B");
    });

    for (const bad of ["TC|K", "M&M.NS", "A..B", "..A", ".A", "A B", "..."]) {
      it(`refuses ${bad}`, () => {
        assert.match(problem(withTicker(bad)), /a ticker/);
      });
    }

    it("refuses a ticker that YAML would read as another type", () => {
      // FAILSAFE reads `1234` as the text "1234", a valid ticker; a list is not one.
      assert.match(
        problem("command: buy\nticker: [A]\ndate: 2026-09-15\nunits: 1\nprice: 1 USD"),
        /field "ticker" must be a value/,
      );
    });
  });

  describe("the file", () => {
    it("reports every problem of every command, each with its position and line", () => {
      const text = batch(
        "command: deposit\namount: 5",
        "command: deposit\namount: 5 EUR",
        "command: withdrawal\namount: 1 GBP\nnote: x",
      );
      assert.deepEqual(issuesOf(text), [
        [1, 3, '"amount" needs its currency: write it as "5 EUR" or "5 USD"; got: "5"'],
        [3, 7, 'unknown field "note" for a withdrawal'],
        [3, 7, '"amount" has an unknown currency "GBP" (EUR or USD)'],
      ]);
    });

    it("refuses a file without schema_version or with another one, and unknown top-level fields", () => {
      assert.match(issuesOf("commands:\n  - command: deposit\n    amount: 1 EUR\n")[0][2], /missing schema_version/);
      assert.match(
        issuesOf("schema_version: 2\ncommands:\n  - command: deposit\n    amount: 1 EUR\n")[0][2],
        /schema_version "2" is not the version/,
      );
      assert.match(
        issuesOf("schema_version: 1\nnote: x\ncommands:\n  - command: deposit\n    amount: 1 EUR\n")[0][2],
        /unknown field "note"/,
      );
    });

    it("reads no further than a wrong or missing schema_version: one error", () => {
      const bad = "command: deposit\n    amount: 0 EUR\n  - nonsense";
      assert.equal(issuesOf(`commands:\n  - ${bad}\n`).length, 1);
      assert.equal(issuesOf(`schema_version: 2\nnote: x\ncommands:\n  - ${bad}\n`).length, 1);
      assert.deepEqual(
        parseBatch(`schema_version: 2\ncommands:\n  - command: deposit\n    amount: 1 EUR\n`).commands,
        [],
      );
    });

    it("points a scalar or null command at its own line", () => {
      const text = "schema_version: 1\ncommands:\n  - command: deposit\n    amount: 1 EUR\n  - just text\n  -\n";
      assert.deepEqual(
        issuesOf(text).map(([c, l]) => [c, l]),
        [
          [2, 5],
          [3, 6],
        ],
      );
    });

    it("refuses an empty file and an empty list of commands", () => {
      assert.match(issuesOf("")[0][2], /file is empty/);
      assert.match(issuesOf("schema_version: 1\ncommands: []\n")[0][2], /"commands" must be a list/);
      assert.match(issuesOf("schema_version: 1\n")[0][2], /"commands" must be a list/);
      assert.match(issuesOf("- a\n- b\n")[0][2], /must be a mapping/);
    });

    it("reports a file that is not YAML as one issue with its line, not a crash", () => {
      const issues = issuesOf("schema_version: 1\ncommands: [oops\n  - x: : :\n");
      assert.equal(issues.length, 1);
      assert.equal(issues[0][0], null);
      assert.match(issues[0][2], /^not valid YAML/);
      assert.equal(typeof issues[0][1], "number");
    });

    it("reports a duplicated key as one issue", () => {
      const issues = issuesOf("schema_version: 1\nschema_version: 1\ncommands: []\n");
      assert.equal(issues.length, 1);
      assert.match(issues[0][2], /^not valid YAML/);
    });

    it("says an empty or missing value is empty, not a list or a mapping (N3)", () => {
      assert.match(problem("command: deposit\namount:"), /field "amount" is empty/);
      assert.match(problem("command: deposit\namount: ~ "), /must be a plain decimal number and its currency/);
      assert.match(
        problem("command: buy\nticker:\ndate: 2026-09-15\nunits: 1\nprice: 1 USD"),
        /field "ticker" is empty/,
      );
    });

    it("finds the line of every command item, also after a comment at column 0 (N4)", () => {
      const text =
        "schema_version: 1\ncommands:\n  - command: deposit\n    amount: 1 EUR\n# a note at column 0\n  - just text\n\n# another\n  -\n  - 5\n";
      assert.deepEqual(
        issuesOf(text).map(([c, l]) => [c, l]),
        [
          [2, 6],
          [3, 9],
          [4, 10],
        ],
      );
    });

    it("reads the list written at the indentation of `commands:` too", () => {
      const text = "schema_version: 1\ncommands:\n- command: deposit\n  amount: 1 EUR\n- just text\n";
      assert.deepEqual(
        issuesOf(text).map(([c, l]) => [c, l]),
        [[2, 5]],
      );
    });
  });

  describe("what did not read, for the commands after it (N8)", () => {
    it("names the commands that did not parse, with the currency they were written in when it is known", () => {
      const { unread, commands } = parseBatch(
        batch(
          "command: deposit\namount: 1 EUR",
          "command: buy\nticker: ???\ndate: 2026-09-15\nunits: 1\nprice: 10 USD", // currency known
          "command: withdrawal\namount: 5", // no currency written
          "just text",
          "command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 1\nprice: 10 USD\ncosts: 1 EUR", // two currencies
        ),
      );
      assert.deepEqual(
        commands.map((c) => c.position),
        [1],
      );
      assert.deepEqual(unread, [
        { position: 2, currencies: ["USD"], kind: "buy", ticker: undefined },
        { position: 3, currencies: [], kind: "withdrawal", ticker: undefined },
        { position: 4, currencies: [], kind: undefined, ticker: undefined },
        { position: 5, currencies: ["USD", "EUR"], kind: "buy", ticker: "TCK" },
      ]);
    });
  });

  describe("what the YAML reader is pinned to (S3)", () => {
    it("reads every scalar as text: 1e3, a date, true and a number are the notation rules' to judge, not YAML's", () => {
      // With the default YAML schema these would arrive as a float, a Date, a boolean and an int.
      const { commands, issues } = parseBatch(
        batch(
          "command: sale\nticker: TCK\ndate: 2026-09-15\nunits: 2\nprice: 10 USD\nstop_executed: true",
          "command: deposit\namount: 0x10 USD",
        ),
      );
      assert.equal(commands.length, 1);
      assert.equal(commands[0].command.kind === "sale" && commands[0].command.stopExecuted, true);
      assert.match(issues[0].reason, /"amount" must be a plain decimal number/);
      assert.match(problem("command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 1e3\nprice: 1 USD"), /"units"/);
      assert.equal(parseBatch("schema_version: 1\ncommands: []\n").issues[0].reason.includes("schema"), false);
    });
  });

  describe("what is printed of the file is escaped (S4)", () => {
    it("prints an unknown field name, in a command or at the top, without raw control characters", () => {
      assert.match(problem('command: deposit\namount: 1 EUR\n"x\\e[31my": 1'), /unknown field "x\\u001b\[31my"/);
      const top = parseBatch('schema_version: 1\n"a\\tb": 1\ncommands:\n  - command: deposit\n    amount: 1 EUR\n');
      assert.match(top.issues[0].reason, /unknown field "a\\tb"/);
    });

    it("prints the reason of the YAML reader as a quoted string", () => {
      const { reason } = parseBatch("schema_version: 1\ncommands: [oops\n").issues[0];
      assert.match(reason, /^not valid YAML: ".*"$/);
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(parseBatch("a: \u001b[31m\n").issues[0].reason, /[\u0000-\u001f]/);
    });
  });

  describe("the rejected batches: replaces and discard (#152)", () => {
    it("reads `replaces` as the name of a rejected batch, with its line, beside the commands", () => {
      const parsed = parseBatch(
        "schema_version: 1\nreplaces: 2026-11-12.yaml\ncommands:\n  - command: deposit\n    amount: 1 EUR\n",
      );
      assert.deepEqual(parsed.issues, []);
      assert.deepEqual(parsed.replaces, { file: "2026-11-12.yaml", line: 2 });
      assert.equal(parseBatch(batch("command: deposit\namount: 1 EUR")).replaces, undefined);
    });

    it("refuses a `replaces` that is not the name of a yaml file: a path, a hidden file, another type, a list, nothing", () => {
      for (const value of ["../a.yaml", "rejected/a.yaml", ".a.yaml", "a.txt", "a\\b.yaml", "[a.yaml]", ""]) {
        const { issues, replaces } = parseBatch(
          `schema_version: 1\nreplaces: ${value}\ncommands:\n  - command: deposit\n    amount: 1 EUR\n`,
        );
        assert.equal(replaces, undefined, value);
        assert.equal(issues.length, 1, value);
        assert.equal(issues[0].command, null);
        assert.equal(issues[0].line, 2);
        assert.match(issues[0].reason, /"replaces" must be the name of a rejected batch/);
      }
    });

    it("reads the discard command with the file it gives up", () => {
      const { commands, issues } = parseBatch(batch("command: discard\nfile: bad.YML"));
      assert.deepEqual(issues, []);
      assert.deepEqual(
        commands.map((c) => c.command),
        [{ kind: "discard", file: "bad.YML" }],
      );
    });

    it("refuses a discard without a file, with a path, or with a field it does not have", () => {
      assert.equal(problem("command: discard"), 'missing field "file"');
      assert.match(problem("command: discard\nfile: ../x.yaml"), /"file" must be the name of a rejected batch/);
      assert.match(problem("command: discard\nfile: x.yaml\nticker: SAP.DE"), /unknown field "ticker" for a discard/);
    });

    it("an unreadable discard is listed as unread, with no currency and no ticker", () => {
      const { unread } = parseBatch(batch("command: discard\nfile: ../x"));
      assert.deepEqual(unread, [{ position: 1, currencies: [], kind: "discard", ticker: undefined }]);
    });
  });
});
