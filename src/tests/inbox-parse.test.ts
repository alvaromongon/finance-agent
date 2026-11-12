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
  it("reads the six commands with their amounts, currency and optional fields", () => {
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
        issuesOf("schema_version: 1\nreplaces: x\ncommands:\n  - command: deposit\n    amount: 1 EUR\n")[0][2],
        /unknown field "replaces"/,
      );
    });

    it("reads no further than a wrong or missing schema_version: one error", () => {
      const bad = "command: deposit\n    amount: 0 EUR\n  - nonsense";
      assert.equal(issuesOf(`commands:\n  - ${bad}\n`).length, 1);
      assert.equal(issuesOf(`schema_version: 2\nreplaces: x\ncommands:\n  - ${bad}\n`).length, 1);
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
});
