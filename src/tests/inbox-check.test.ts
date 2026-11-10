/**
 * `inbox:check` (#131, spec #124): the batches in `inbox/` against the current portfolio, read through the
 * state port, changing nothing. Temporary vault, no network. VAULT_PROJECT_DIR is set before the first import
 * of the engine.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { portfolioMd } from "./fixtures/inbox.js";

const SAP: { ticker: string; units: number; price: number } = { ticker: "SAP.DE", units: 5, price: 180 };

const batch = (...commands: string[]): string =>
  `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;
const BUY = "command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 2\nprice: 100 USD";
const SELL = "command: sale\nticker: TCK\ndate: 2026-09-20\nunits: 2\nprice: 110 USD";

describe("inbox:check", () => {
  let vaultDir: string;
  let checkInbox: typeof import("../inbox.js").checkInbox;
  const inbox = () => join(vaultDir, "inbox");
  const drop = (name: string, text: string) => writeFile(join(inbox(), name), text, "utf8");

  /** Every file of the vault with its bytes: what "changes nothing" is measured against. */
  async function snapshot(dir = vaultDir): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        out[relative(dir, path)] = await readFile(path, "utf8");
      }
    }
    return out;
  }

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-inbox-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    ({ checkInbox } = await import("../inbox.js"));
  });
  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rm(inbox(), { recursive: true, force: true });
    await mkdir(inbox(), { recursive: true });
    await writeFile(join(vaultDir, "portfolio.md"), portfolioMd({ usd: [SAP] }), "utf8");
  });

  it("says a missing or empty inbox is nothing to check and exits 0", async () => {
    assert.deepEqual(await checkInbox(), { lines: ["Inbox is empty: nothing to check."], exitCode: 0 });
    await rm(inbox(), { recursive: true });
    assert.equal((await checkInbox()).exitCode, 0);
  });

  it("reads a batch saved with CRLF line endings like any other", async () => {
    await drop("a.yaml", batch("command: deposit\namount: 5 EUR").replace(/\n/g, "\r\n"));
    assert.equal((await checkInbox()).exitCode, 0);
  });

  it("reads portfolio.md once: a stale portfolio warns once, not once per currency", async () => {
    const stale = portfolioMd({ usd: [SAP] }).replace("2099-01-01T00:00:00Z", "2020-01-01T00:00:00Z");
    await writeFile(join(vaultDir, "portfolio.md"), stale, "utf8");
    await drop("a.yaml", batch("command: deposit\namount: 5 EUR"));
    const warn = mock.method(console, "warn", () => {});
    try {
      await checkInbox();
      assert.equal(warn.mock.calls.filter((c) => String(c.arguments[0]).includes("has not been updated")).length, 1);
    } finally {
      warn.mock.restore();
    }
  });

  it("exits 0 for a clean batch, and a buy and its sale in one batch are valid", async () => {
    await drop("2026-09-15.yaml", batch("command: deposit\namount: 100 USD", BUY, SELL));
    const { lines, exitCode } = await checkInbox();
    assert.equal(exitCode, 0, lines.join("\n"));
    assert.match(lines[0], /clean: 1 batch/);
  });

  it("says whether the lots a sale refusal talks about are the portfolio's or an earlier command's (#149)", async () => {
    const sell = (units: number) => `command: sale\nticker: TCK\ndate: 2026-09-20\nunits: ${units}\nprice: 110 USD`;
    await drop("a.yaml", batch(BUY, sell(5)));
    // In a file of its own: a refused command blocks the later commands of its currency in the same batch.
    await drop("b.yaml", batch("command: sale\nticker: SAP.DE\ndate: 2026-09-20\nunits: 9\nprice: 1 USD"));
    const { lines } = await checkInbox();
    assert.match(lines[0], /^inbox\/a\.yaml: command 2.*only 2 are open in command 1 of this batch/);
    assert.match(lines[1], /^inbox\/b\.yaml: command 1.*only 5 are open in portfolio\.md/);
  });

  describe("stops are their own commands (#151)", () => {
    const BUY_TCK = "command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 2\nprice: 100 USD";

    describe("an initial stop at or above the entry price is refused (#159)", () => {
      it("names the set_stop, the buy and both prices", async () => {
        await drop("a.yaml", batch(BUY_TCK, "command: set_stop\nticker: TCK\nprice: 100 USD"));
        const { lines, exitCode } = await checkInbox();
        assert.equal(exitCode, 1);
        assert.match(lines[0], /^inbox\/a\.yaml: command 2, line 8: /);
        assert.match(lines[0], /set_stop at 100 USD/);
        assert.match(lines[0], /buy of TCK \(command 1.*entry price of 100 USD/);
        assert.match(lines[0], /R would be zero or negative/);
      });

      it("accepts a set_stop above the entry price of a position with no lot opened in the batch", async () => {
        await drop("a.yaml", batch("command: set_stop\nticker: SAP.DE\nprice: 500 USD"));
        const { lines, exitCode } = await checkInbox();
        assert.equal(exitCode, 0, lines.join("\n"));
      });

      it("refuses a scale-in under a stop at or above the new price, naming the portfolio's stop", async () => {
        await drop("a.yaml", batch("command: buy\nticker: SAP.DE\ndate: 2026-09-15\nunits: 1\nprice: 100 USD"));
        await writeFile(join(vaultDir, "portfolio.md"), portfolioMd({ usd: [{ ...SAP, stop: 150 }] }), "utf8");
        const { lines, exitCode } = await checkInbox();
        assert.equal(exitCode, 1, lines.join("\n"));
        assert.match(lines[0], /^inbox\/a\.yaml: command 1, line 3: /);
        assert.match(lines[0], /entry price of 100 USD.*stop of 150 USD that portfolio\.md holds/);
      });

      it("accepts that scale-in when a set_stop in the batch sets a stop below the entry price", async () => {
        await drop(
          "a.yaml",
          batch(
            "command: buy\nticker: SAP.DE\ndate: 2026-09-15\nunits: 1\nprice: 100 USD",
            "command: set_stop\nticker: SAP.DE\nprice: 90 USD",
          ),
        );
        await writeFile(join(vaultDir, "portfolio.md"), portfolioMd({ usd: [{ ...SAP, stop: 150 }] }), "utf8");
        const { lines, exitCode } = await checkInbox();
        assert.equal(exitCode, 0, lines.join("\n"));
      });
    });

    it("refuses a buy that carries a stop, naming set_stop", async () => {
      await drop("a.yaml", batch(`${BUY_TCK}\nstop: 90 USD`));
      const { lines, exitCode } = await checkInbox();
      assert.equal(exitCode, 1);
      assert.match(lines[0], /^inbox\/a\.yaml: command 1, line 3: a buy carries no "stop": set it with a set_stop/);
    });

    it("accepts a buy and its set_stop in one batch with no warning", async () => {
      await drop("a.yaml", batch(BUY_TCK, "command: set_stop\nticker: TCK\nprice: 90 USD"));
      const { lines, exitCode } = await checkInbox();
      assert.equal(exitCode, 0, lines.join("\n"));
      assert.deepEqual(lines, ["Inbox is clean: 1 batch(es) would apply."]);
    });

    it("warns, without failing, about a position that ends the batch with no stop", async () => {
      await drop("a.yaml", batch(BUY_TCK));
      const { lines, exitCode } = await checkInbox();
      assert.equal(exitCode, 0);
      assert.equal(lines[0], "Inbox is clean: 1 batch(es) would apply.");
      assert.equal(
        lines[1],
        "inbox/a.yaml: command 1, line 3: warning: TCK has no stop in the USD silo, so risk watch cannot protect it",
      );
    });

    it("warns when a clear_stop leaves the position without one", async () => {
      await drop(
        "a.yaml",
        batch(BUY_TCK, "command: set_stop\nticker: TCK\nprice: 90 USD", "command: clear_stop\nticker: TCK"),
      );
      const { lines, exitCode } = await checkInbox();
      assert.equal(exitCode, 0);
      assert.match(lines[1], /command 3, line 11: warning: TCK has no stop in the USD silo/);
    });

    it("refuses clear_stop on a position without a stop and set_stop on a ticker with no position", async () => {
      await drop(
        "a.yaml",
        batch("command: clear_stop\nticker: SAP.DE", "command: set_stop\nticker: NOPE\nprice: 1 USD"),
      );
      const { lines, exitCode } = await checkInbox();
      assert.equal(exitCode, 1);
      assert.match(lines[0], /command 1, line 3: .*SAP\.DE has no stop to clear/);
      assert.match(lines[1], /command 2, line 5: .*no open position in NOPE/);
    });

    it("sees a position opened earlier in the batch, and one sold earlier in it", async () => {
      await drop("a.yaml", batch(BUY_TCK, SELL, "command: set_stop\nticker: TCK\nprice: 90 USD"));
      const { lines } = await checkInbox();
      assert.match(lines[0], /command 3, line 13: .*no open position in TCK/);
    });
  });

  it("checks each command against the state the previous ones produce", async () => {
    // The state has 500 USD: the second withdrawal fails only because the first one already happened.
    await drop("a.yaml", batch("command: withdrawal\namount: 300 USD", "command: withdrawal\namount: 300 USD"));
    const { lines, exitCode } = await checkInbox();
    assert.equal(exitCode, 1);
    assert.match(
      lines[0],
      /^inbox\/a\.yaml: command 2, line 5: the withdrawal of 300\.00 USD exceeds the available cash of 200\.00 USD$/,
    );
  });

  it("reports every error of the batch, not only the first: command, line and reason", async () => {
    await drop(
      "a.yaml",
      batch(
        "command: withdrawal\namount: 9999 USD", // 1: over the cash
        "command: withdrawal\namount: 9999 EUR", // 2: over the cash of the other silo
        "command: deposit\namount: 10 GBP", // 3: unknown currency
        "command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 1e2\nprice: 1 USD", // 4: notation
      ),
    );
    const { lines, exitCode } = await checkInbox();
    assert.equal(exitCode, 1);
    assert.deepEqual(
      lines.slice(0, 4).map((l) => l.replace(/:.*?(command \d+, line \d+).*$/, " $1")),
      [
        "inbox/a.yaml command 1, line 3",
        "inbox/a.yaml command 2, line 5",
        "inbox/a.yaml command 3, line 7",
        "inbox/a.yaml command 4, line 9",
      ],
    );
    assert.match(lines[4], /^4 error\(s\) in 1 of 1 batch/);
    assert.equal(lines.length, 5);
  });

  describe("a command that cannot be checked is named, with the command that blocked it", () => {
    const lineOf = (lines: string[], n: number) => lines.find((l) => l.includes(`command ${n},`));

    it("a refused buy and its sale in one batch: the sale is not checked, and gives no 'no open lots' error", async () => {
      // 1 is refused (more than the 500 USD of cash): the lot it would have opened is unknown, not absent.
      const dear = "command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 10\nprice: 100 USD";
      await drop("a.yaml", batch(dear, SELL));
      const { lines, exitCode } = await checkInbox();
      assert.equal(exitCode, 1);
      assert.match(lineOf(lines, 1)!, /^inbox\/a\.yaml: command 1, line 3: the buy of TCK costs 1000\.00 USD/);
      assert.match(lineOf(lines, 2)!, /^inbox\/a\.yaml: command 2, line 8: not checked: command 1 was refused/);
      assert.doesNotMatch(lines.join("\n"), /no open lot/);
      assert.match(lines.at(-1)!, /^1 error\(s\) in 1 of 1 batch\(es\); 1 command\(s\) not checked\.$/);
    });

    it("a clear_stop names no currency: it waits for a blocked one, and a refused clear_stop blocks nothing", async () => {
      const dear = "command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 10\nprice: 100 USD";
      await drop("a.yaml", batch(dear, "command: clear_stop\nticker: TCK"));
      const blocked = await checkInbox();
      assert.match(
        lineOf(blocked.lines, 2)!,
        /not checked: command 1 was refused, so the position it would change is unknown/,
      );

      await drop("a.yaml", batch("command: clear_stop\nticker: NOPE", "command: withdrawal\namount: 99999 USD"));
      const refused = await checkInbox();
      assert.ok(lineOf(refused.lines, 1));
      assert.doesNotMatch(lineOf(refused.lines, 2)!, /not checked/);
    });

    it("an unreadable command blocks the commands of its currency, and says it was not read", async () => {
      await drop(
        "a.yaml",
        batch(
          "command: deposit\namount: 10 USD\nbogus: 1", // 1: unknown field, USD
          "command: withdrawal\namount: 99999 USD", // 2: not checked
          "command: withdrawal\namount: 99999 EUR", // 3: other silo, checked
        ),
      );
      const { lines } = await checkInbox();
      assert.match(lineOf(lines, 2)!, /not checked: command 1 could not be read/);
      assert.match(lineOf(lines, 3)!, /exceeds the available cash/);
    });

    it("an unreadable command with no currency blocks both silos", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 5", "command: withdrawal\namount: 99999 EUR"));
      const { lines } = await checkInbox();
      assert.match(lineOf(lines, 2)!, /not checked: command 1 could not be read/);
    });

    it("names every command it skipped, so fixing the listed errors reveals no unannounced one", async () => {
      await drop(
        "a.yaml",
        batch(
          "command: withdrawal\namount: 9999 USD", // 1: refused
          "command: deposit\namount: 10 USD", // 2: not checked
          "command: sale\nticker: ZZZ\ndate: 2026-09-20\nunits: 1\nprice: 1 USD", // 3: not checked
          "command: withdrawal\namount: 9999 EUR", // 4: refused (EUR)
          "command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 1e2\nprice: 1 EUR", // 5: unreadable
          "command: deposit\namount: 1 EUR", // 6: not checked
        ),
      );
      const { lines } = await checkInbox();
      const named = lines.filter((l) => /command \d/.test(l)).map((l) => /command (\d)/.exec(l)![1]);
      assert.deepEqual(named, ["1", "2", "3", "4", "5", "6"], lines.join("\n"));
      assert.match(lines.at(-1)!, /3 error\(s\) in 1 of 1 batch\(es\); 3 command\(s\) not checked\.$/);
    });

    it("a clean batch names none and the summary does not mention any", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 5 USD"));
      assert.match((await checkInbox()).lines[0], /^Inbox is clean/);
    });
  });

  it("checks the currency of the silo: the EUR cash does not cover a USD withdrawal, nor does a USD amount touch EUR", async () => {
    await writeFile(join(vaultDir, "portfolio.md"), portfolioMd({ eurCash: "9000.00", usdCash: "50.00" }), "utf8");
    await drop("a.yaml", batch("command: withdrawal\namount: 100 USD", "command: withdrawal\namount: 100 EUR"));
    const { lines } = await checkInbox();
    assert.equal(lines.filter((l) => /command \d/.test(l)).length, 1);
    assert.match(lines[0], /command 1.*100\.00 USD exceeds the available cash of 50\.00 USD/);
  });

  it("reports a malformed YAML file as one error, not a crash, and still checks the other files", async () => {
    await drop("a.yaml", "schema_version: 1\ncommands: [oops\n");
    await drop("b.yaml", batch("command: deposit\namount: 5 USD"));
    await drop("c.yml", batch("command: deposit\namount: 5 GBP"));
    const { lines, exitCode } = await checkInbox();
    assert.equal(exitCode, 1);
    assert.match(lines[0], /^inbox\/a\.yaml: file, line \d+: not valid YAML/);
    assert.match(lines[1], /^inbox\/c\.yml: command 1, line 3: .*unknown currency/);
    assert.match(lines[2], /^2 error\(s\) in 2 of 3 batch/);
  });

  it("checks the files in name order, each against what the clean ones before it would produce", async () => {
    await drop("1.yaml", batch("command: withdrawal\namount: 400 USD"));
    await drop("2.yaml", batch("command: withdrawal\namount: 400 USD")); // only 100 left after 1.yaml
    await drop("3.yaml", batch("command: deposit\namount: 1 GBP")); // rejected: contributes nothing
    await drop("4.yaml", batch("command: withdrawal\namount: 100 USD")); // 100 are left
    const { lines } = await checkInbox();
    assert.deepEqual(
      lines.filter((l) => l.startsWith("inbox/")).map((l) => l.split(":")[0]),
      ["inbox/2.yaml", "inbox/3.yaml"],
    );
  });

  it("ignores files that are not YAML", async () => {
    await drop("notes.txt", "not a batch");
    assert.equal((await checkInbox()).exitCode, 0);
  });

  it("refuses a portfolio it cannot read whole instead of checking against a partial state", async () => {
    await writeFile(join(vaultDir, "portfolio.md"), "---\nschema_version: 1\n---\n", "utf8");
    await drop("a.yaml", batch("command: deposit\namount: 5 USD"));
    await assert.rejects(checkInbox(), /portfolio\.md/);
  });

  describe("a portfolio it cannot read whole is refused, as decision:record refuses it (B1)", () => {
    const refusedWith = async (portfolio: string, pattern: RegExp) => {
      await writeFile(join(vaultDir, "portfolio.md"), portfolio, "utf8");
      await drop("a.yaml", batch("command: deposit\namount: 5 USD"));
      await assert.rejects(checkInbox(), pattern);
    };
    const sap = portfolioMd({ usd: [SAP] });

    // Each case is refused for its own reason: the pattern is that reason, not any refusal of the portfolio.
    it("a Lots row that does not read", async () => {
      await refusedWith(
        sap.replace("| SAP.DE | lot-sapde |", "| ??? | lot-sapde |"),
        /^Error: portfolio\.md \(USD\): Lots row 1 \(\?\?\?, lot-sapde\): Ticker "\?\?\?" does not read.*the row is skipped/,
      );
    });

    it("a Positions row that does not read", async () => {
      await refusedWith(
        sap.replace("| SAP.DE | 5 | 180 | 180", "| ??? | 5 | 180 | 180"),
        /^Error: ## USD — Positions: Ticker "\?\?\?": a ticker has letters, digits/,
      );
    });

    it("a ticker on two rows of Positions", async () => {
      const row = "| SAP.DE | 5 | 180 | 180 | 0 | — |";
      await refusedWith(
        sap.replace(row, `${row}\n${row}`),
        /^Error: portfolio\.md \(USD\): SAP\.DE is on 2 rows of "## USD — Positions".*merge them into one row/,
      );
    });

    it("a Cash cell too large to count", async () => {
      await refusedWith(
        sap.replace("| Available cash | 500.00 |", "| Available cash | 1e307 |"),
        /^Error: ## USD — Cash: Available cash "1e307" is too large to count in cents/,
      );
    });

    it("a P/L cell too large to count", async () => {
      await refusedWith(
        sap.replace("| 180 | 180 | 0 | — |", "| 180 | 180 | 1e307 | — |"),
        /^Error: ## USD — Positions: SAP\.DE P\/L "1e307" is too large to count in cents/,
      );
    });

    it("a Volume that is not the sum of the Units of its lots", async () => {
      await refusedWith(
        sap.replace("| SAP.DE | 5 | 180 |", "| SAP.DE | 7 | 180 |"),
        /^Error: portfolio\.md \(USD\): SAP\.DE: Volume 7 is not the sum of the Units of its lots \(5\)/,
      );
    });

    it("leaves the inbox untouched when it refuses", async () => {
      await writeFile(join(vaultDir, "portfolio.md"), sap.replace("| SAP.DE | 5 | 180 |", "| SAP.DE | 7 | 180 |"));
      await drop("a.yaml", batch("command: deposit\namount: 5 USD"));
      const before = await snapshot();
      await assert.rejects(checkInbox());
      assert.deepEqual(await snapshot(), before);
    });
  });

  it("a portfolio with only an EUR section gives a reason for each USD command, not a crash (N7)", async () => {
    const eurOnly = portfolioMd().split("## USD — Cash")[0];
    await writeFile(join(vaultDir, "portfolio.md"), eurOnly, "utf8");
    await drop("a.yaml", batch("command: deposit\namount: 5 EUR", "command: deposit\namount: 5 USD", BUY));
    const { lines, exitCode } = await checkInbox();
    assert.equal(exitCode, 1);
    assert.match(lines[0], /^inbox\/a\.yaml: command 2, line 5: there is no USD silo in the portfolio$/);
    assert.match(lines[1], /^inbox\/a\.yaml: command 3, line 7: there is no USD silo/);
    assert.equal(lines.length, 3);
  });

  describe("a silo whose headings are all misspelt is not an absent silo", () => {
    const typo = () =>
      portfolioMd()
        .replace("## USD — Cash", "## USD — Caja")
        .replace("## USD — Positions", "## USD — Posiciones")
        .replace("## USD — Lots", "## USD — Lotes");

    it("the check is refused naming the headings found, not 'there is no USD silo'", async () => {
      await writeFile(join(vaultDir, "portfolio.md"), typo(), "utf8");
      await drop("a.yaml", batch("command: deposit\namount: 5 USD"));
      await assert.rejects(checkInbox(), (err: Error) => {
        assert.match(err.message, /missing section "## USD — Cash"/);
        assert.match(err.message, /"## USD — Caja", "## USD — Posiciones", "## USD — Lotes"/);
        assert.doesNotMatch(err.message, /no USD silo/);
        return true;
      });
    });

    it("the other flows still refuse the file", async () => {
      await writeFile(join(vaultDir, "portfolio.md"), typo(), "utf8");
      const { readPortfolio } = await import("../portfolio-store.js");
      await assert.rejects(readPortfolio("USD"), /missing section "## USD — Cash"/);
    });
  });

  it("a portfolio with no silo at all is refused, not checked", async () => {
    await writeFile(
      join(vaultDir, "portfolio.md"),
      "---\nschema_version: 2\nlast_manual_sync: 2099-01-01T00:00:00Z\n---\n",
    );
    await drop("a.yaml", batch("command: deposit\namount: 5 USD"));
    await assert.rejects(checkInbox(), /missing section/);
  });

  describe("a command that does not parse leaves what it would have done unknown (N8)", () => {
    it("does not check the later commands of its currency against cash and lots", async () => {
      // 1 does not parse (ticker): the buy it stands for would have opened TCK, so selling it is not an error of 2.
      await drop(
        "a.yaml",
        batch(
          "command: buy\nticker: ???\ndate: 2026-09-15\nunits: 2\nprice: 100 USD",
          "command: sale\nticker: ???2\ndate: 2026-09-20\nunits: 2\nprice: 110 USD",
          "command: sale\nticker: TCK\ndate: 2026-09-20\nunits: 2\nprice: 110 USD",
          "command: withdrawal\namount: 99999 EUR",
        ),
      );
      const { lines } = await checkInbox();
      const commands = lines.filter((l) => /command \d/.test(l)).map((l) => /command (\d)/.exec(l)![1]);
      assert.deepEqual(commands, ["1", "2", "3", "4"], lines.join("\n"));
      assert.match(
        lines.find((l) => l.includes("command 3,"))!,
        /not checked/,
      );
      assert.doesNotMatch(lines.join("\n"), /no open lot/);
    });

    it("does not check any silo after a command whose currency is unknown", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 5", "command: withdrawal\namount: 99999 EUR"));
      const { lines } = await checkInbox();
      assert.match(
        lines.find((l) => l.includes("command 2,"))!,
        /not checked/,
      );
      assert.doesNotMatch(lines.join("\n"), /exceeds the available cash/);
    });

    it("still checks the later commands of the other currency", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 0 USD", "command: withdrawal\namount: 99999 EUR"));
      const { lines } = await checkInbox();
      assert.match(lines.join("\n"), /command 2.*exceeds the available cash/);
    });
  });

  it("prints a file name without raw control characters (S4)", async () => {
    await drop("a\u001b[31mb.yaml", batch("command: deposit\namount: 5 GBP"));
    const { lines } = await checkInbox();
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(lines.join("\n"), /[\u0000-\u0009\u000b-\u001f]/);
    assert.match(lines[0], /^inbox\/a\\u001b\[31mb\.yaml: command 1/);
  });

  it("writes nothing: the inbox and the state are byte-identical afterwards, clean batch or not", async () => {
    await drop("a.yaml", batch("command: deposit\namount: 100 USD", BUY, SELL));
    await drop("b.yaml", batch("command: withdrawal\namount: 99999 USD", "command: deposit\namount: 5"));
    await drop("c.yaml", "{ not yaml");
    const before = await snapshot();
    await checkInbox();
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await readdir(vaultDir)).sort(), ["inbox", "portfolio.md"]);
    assert.deepEqual((await readdir(inbox())).sort(), ["a.yaml", "b.yaml", "c.yaml"]);
  });

  describe("what a refusal blocks, and what it names (#158)", () => {
    const lineOf = (lines: string[], n: number) => lines.find((l) => l.includes(`command ${n},`));
    const withPortfolio = (md: string) => writeFile(join(vaultDir, "portfolio.md"), md, "utf8");
    const setStop = (ticker: string, price: string) => `command: set_stop\nticker: ${ticker}\nprice: ${price}`;
    const buyTck = (price: number, units = 1) =>
      `command: buy\nticker: TCK\ndate: 2026-09-15\nunits: ${units}\nprice: ${price} USD`;

    describe("a command that did not read blocks the silos the portfolio has", () => {
      it("a currency with no silo is not blocked: its commands are refused for that, not 'not checked'", async () => {
        await withPortfolio(portfolioMd().split("## USD — Cash")[0]);
        await drop(
          "a.yaml",
          batch("command: deposit\namount: 5", "command: deposit\namount: 5 USD", "command: deposit\namount: 5 EUR"),
        );
        const { lines } = await checkInbox();
        assert.match(lineOf(lines, 2)!, /command 2, line 5: there is no USD silo in the portfolio$/);
        assert.match(lineOf(lines, 3)!, /command 3, line 7: not checked: command 1 could not be read/);
      });
    });

    describe("a set_stop or clear_stop that failed leaves only the stop of its ticker unknown", () => {
      it("an unreadable set_stop does not stop the cash and lot commands after it from being checked", async () => {
        await drop("a.yaml", batch("command: set_stop\nticker: TCK", "command: withdrawal\namount: 99999 USD"));
        const { lines } = await checkInbox();
        assert.match(lineOf(lines, 2)!, /exceeds the available cash/);
        assert.doesNotMatch(lines.join("\n"), /not checked/);
      });

      it("a refused set_stop does not either, and its ticker's clear_stop is not checked", async () => {
        await drop(
          "a.yaml",
          batch(
            setStop("NOPE", "10 USD"),
            "command: clear_stop\nticker: NOPE",
            "command: withdrawal\namount: 99999 USD",
          ),
        );
        const { lines } = await checkInbox();
        assert.match(lineOf(lines, 1)!, /no open position in NOPE in the USD silo/);
        assert.match(lineOf(lines, 2)!, /not checked: command 1 was refused, so the stop it would change is unknown/);
        assert.match(lineOf(lines, 3)!, /exceeds the available cash/);
      });

      it("a clear_stop not checked because its currency is blocked leaves no cascade error in another currency", async () => {
        await withPortfolio(portfolioMd({ eur: [{ ticker: "TCK", units: 1, price: 100, stop: 110 }] }));
        await drop(
          "a.yaml",
          batch(
            "command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 10\nprice: 100 USD", // 1: refused for cash, blocks USD
            "command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 1\nprice: 100 EUR", // 2: the stop of 110 is not below it
            "command: clear_stop\nticker: TCK", // 3: would clear that stop; not checked
          ),
        );
        const { lines } = await checkInbox();
        assert.match(lineOf(lines, 1)!, /more than the available cash/);
        assert.match(lineOf(lines, 2)!, /not checked: command (1 was refused|3 was not checked), so/);
        assert.match(lineOf(lines, 3)!, /not checked: command 1 was refused/);
        assert.doesNotMatch(lines.join("\n"), /R would be zero or negative/);
      });

      it("a clear_stop is blocked by what concerns its own ticker, not by a refusal of another ticker or currency", async () => {
        await withPortfolio(
          portfolioMd({ eur: [{ ticker: "TCK", units: 1, price: 100, stop: 90 }], usd: [{ ...SAP }] }),
        );
        await drop(
          "a.yaml",
          batch(
            "command: buy\nticker: ZZZ\ndate: 2026-09-15\nunits: 10\nprice: 100 USD", // 1: refused, blocks USD
            "command: clear_stop\nticker: TCK", // 2: held in EUR only: checked, and valid
            "command: clear_stop\nticker: SAP.DE", // 3: held in USD but not stopped: checked, has no stop
            "command: clear_stop\nticker: ZZZ", // 4: the ticker of the refusal: not checked
            "command: deposit\namount: 5 USD", // 5: the currency is blocked
          ),
        );
        const { lines } = await checkInbox();
        assert.equal(lineOf(lines, 2), undefined, lines.join("\n"));
        assert.match(lineOf(lines, 3)!, /SAP\.DE has no stop to clear/);
        assert.match(
          lineOf(lines, 4)!,
          /not checked: command 1 was refused, so the position it would change is unknown/,
        );
        assert.match(lineOf(lines, 5)!, /not checked: command 1 was refused/);
      });

      it("a clear_stop of the ticker of a command that was itself not checked is not checked either", async () => {
        await drop(
          "a.yaml",
          batch(
            "command: deposit\namount: 5 USD\nbogus: 1", // 1: unreadable, blocks USD
            "command: buy\nticker: ZZZ\ndate: 2026-09-15\nunits: 1\nprice: 1 USD", // 2: not checked
            "command: clear_stop\nticker: ZZZ", // 3: ZZZ may have been opened by 2
          ),
        );
        const { lines } = await checkInbox();
        assert.match(
          lineOf(lines, 3)!,
          /not checked: command 1 could not be read, so the position it would change is unknown/,
        );
      });

      it("a set_stop that succeeds later lifts the stop block of its ticker and currency", async () => {
        await drop(
          "a.yaml",
          batch(
            setStop("TCK", "150 USD"), // 1: refused, no position yet; the stop of TCK is unknown
            buyTck(100), // 2
            setStop("TCK", "150 USD"), // 3: sets it for sure
          ),
        );
        const { lines, exitCode } = await checkInbox();
        assert.equal(exitCode, 1);
        assert.match(lineOf(lines, 1)!, /no open position in TCK in the USD silo/);
        assert.match(
          lineOf(lines, 3)!,
          /^inbox\/a\.yaml: command 3, line 11: the set_stop at 150 USD would be the initial stop of the buy of TCK \(command 2/,
        );
        assert.doesNotMatch(lines.join("\n"), /not checked/);
      });

      it("an unreadable clear_stop leaves the stop of its ticker unknown in every currency", async () => {
        await drop(
          "a.yaml",
          batch(
            "command: clear_stop\nticker: TCK\nbogus: 1",
            "command: clear_stop\nticker: SAP.DE",
            "command: clear_stop\nticker: TCK",
          ),
        );
        const { lines } = await checkInbox();
        assert.match(lineOf(lines, 2)!, /has no stop to clear/);
        assert.match(
          lineOf(lines, 3)!,
          /not checked: command 1 could not be read, so the stop it would change is unknown/,
        );
      });

      it("a command that changes no cash or lots says 'the position' when a refusal before it blocked the currency", async () => {
        await drop("a.yaml", batch(`${buyTck(100, 10)}`, setStop("SAP.DE", "10 USD")));
        const { lines } = await checkInbox();
        assert.match(
          lineOf(lines, 2)!,
          /not checked: command 1 was refused, so the position it would change is unknown$/,
        );
      });
    });

    describe("the warning about a position without a stop", () => {
      it("looks in the silo the command touched: the same ticker with a stop in the other silo does not hide it", async () => {
        await withPortfolio(
          portfolioMd({
            eur: [{ ticker: "TCK", units: 1, price: 100, stop: 90 }],
            usd: [{ ticker: "TCK", units: 1, price: 100 }],
          }),
        );
        await drop("a.yaml", batch(buyTck(100)));
        const { lines } = await checkInbox();
        assert.equal(lines.length, 2, lines.join("\n"));
        assert.match(lines[1], /warning: TCK has no stop in the USD silo, so risk watch cannot protect it/);
      });

      it("fires after a partial sale of a position without a stop, and not after a sale that closes it", async () => {
        await drop("a.yaml", batch("command: sale\nticker: SAP.DE\ndate: 2026-09-20\nunits: 1\nprice: 190 USD"));
        const partial = await checkInbox();
        assert.match(partial.lines[1], /command 1, line 3: warning: SAP\.DE has no stop in the USD silo/);
        await drop("a.yaml", batch("command: sale\nticker: SAP.DE\ndate: 2026-09-20\nunits: 5\nprice: 190 USD"));
        assert.deepEqual((await checkInbox()).lines, ["Inbox is clean: 1 batch(es) would apply."]);
      });

      it("counts a stop that is not above zero as no stop", async () => {
        await withPortfolio(portfolioMd({ usd: [{ ...SAP, stop: 0 }] }));
        await drop("a.yaml", batch(setStop("SAP.DE", "170 USD"), "command: clear_stop\nticker: SAP.DE"));
        const { lines } = await checkInbox();
        assert.match(lines[1], /command 2.*warning: SAP\.DE has no stop in the USD silo/);
        await drop("a.yaml", batch("command: clear_stop\nticker: SAP.DE"));
        assert.match((await checkInbox()).lines[0], /SAP\.DE has no stop to clear/);
      });

      it("names the silos a clear_stop of a ticker held in both cleared", async () => {
        await withPortfolio(
          portfolioMd({
            eur: [{ ticker: "TCK", units: 1, price: 100, stop: 90 }],
            usd: [{ ticker: "TCK", units: 1, price: 100, stop: 90 }],
          }),
        );
        await drop("a.yaml", batch("command: clear_stop\nticker: TCK"));
        const { lines } = await checkInbox();
        assert.deepEqual(lines.slice(1), [
          "inbox/a.yaml: command 1, line 3: warning: TCK has no stop in the EUR silo, so risk watch cannot protect it",
          "inbox/a.yaml: command 1, line 3: warning: TCK has no stop in the USD silo, so risk watch cannot protect it",
        ]);
      });
    });

    describe("where the lots of a refusal come from", () => {
      const sell = (units: number, ticker = "TCK") =>
        `command: sale\nticker: ${ticker}\ndate: 2026-09-20\nunits: ${units}\nprice: 110 USD`;

      it("names the earlier file that opened them, not 'an earlier batch'", async () => {
        await drop("a.yaml", batch(buyTck(100, 2)));
        await drop("b.yaml", batch(sell(5)));
        const { lines } = await checkInbox();
        assert.match(lines[0], /^inbox\/b\.yaml: command 1.*only 2 are open in command 1 of inbox\/a\.yaml$/);
      });

      it("names an earlier file for a ticker it opened and a later one sold out, though no lot of it is left", async () => {
        await drop("a.yaml", batch(buyTck(100, 2)));
        await drop("b.yaml", batch(sell(2)));
        await drop("c.yaml", batch(sell(1)));
        const { lines } = await checkInbox();
        assert.match(
          lines[0],
          /^inbox\/c\.yaml: command 1.*no open lots for TCK in portfolio\.md and an earlier file$/,
        );
      });

      it("names the commands of the batch for a ticker they sold out, and not for another ticker", async () => {
        await drop("a.yaml", batch(buyTck(100, 2), sell(2), sell(1), sell(1, "SAP.DE\nlot: nope")));
        const { lines } = await checkInbox();
        assert.match(lineOf(lines, 3)!, /no open lots for TCK in portfolio\.md and the earlier commands$/);
      });
    });

    describe("a rejected file", () => {
      it("is named by the later commands that depend on it, instead of reporting 'no open lots' unmarked", async () => {
        await drop("a.yaml", batch(buyTck(100, 2), "command: deposit\namount: 5 USD\nbogus: 1"));
        await drop(
          "b.yaml",
          batch(
            "command: sale\nticker: TCK\ndate: 2026-09-20\nunits: 2\nprice: 110 USD",
            "command: withdrawal\namount: 99999 EUR",
          ),
        );
        const { lines } = await checkInbox();
        const b = lines.filter((l) => l.startsWith("inbox/b.yaml"));
        assert.match(
          b[0],
          /^inbox\/b\.yaml: command 1, line 3: not checked: depends on inbox\/a\.yaml, which was rejected/,
        );
        // Another currency: nothing in a.yaml explains it.
        assert.match(b[1], /command 2, line 8: the withdrawal of 99999\.00 EUR exceeds/);
        assert.doesNotMatch(lines.join("\n"), /no open lots/);
        assert.match(lines.at(-1)!, /^2 error\(s\) in 2 of 2 batch\(es\); 1 command\(s\) not checked\.$/);
      });

      it("says the position, not cash and lots, for a set_stop that depends on a rejected file", async () => {
        await drop("a.yaml", batch(buyTck(100, 2), "command: deposit\namount: 5 USD\nbogus: 1"));
        await drop("b.yaml", batch(setStop("TCK", "90 USD")));
        const { lines } = await checkInbox();
        const b = lines.find((l) => l.startsWith("inbox/b.yaml"))!;
        assert.match(
          b,
          /not checked: depends on inbox\/a\.yaml, which was rejected, so the position it would change is unknown$/,
        );
      });

      it("a file that holds only stop errors changes no cash or lots: the later cash errors are real", async () => {
        await drop("a.yaml", batch(setStop("NOPE", "10 USD"), "command: clear_stop\nticker: NOPE"));
        await drop("b.yaml", batch(buyTck(100, 10), "command: withdrawal\namount: 99999 EUR"));
        const { lines } = await checkInbox();
        const b = lines.filter((l) => l.startsWith("inbox/b.yaml"));
        assert.equal(b.length, 2, lines.join("\n"));
        assert.match(b[0], /more than the available cash/);
        assert.match(b[1], /exceeds the available cash/);
        assert.doesNotMatch(lines.join("\n"), /depends on/);
      });

      it("a file with a stop error and a buy still explains the cash errors after it", async () => {
        await drop("a.yaml", batch(buyTck(100, 2), setStop("NOPE", "10 USD")));
        await drop("b.yaml", batch("command: withdrawal\namount: 99999 USD"));
        const { lines } = await checkInbox();
        assert.match(
          lines.find((l) => l.startsWith("inbox/b.yaml"))!,
          /not checked: depends on inbox\/a\.yaml/,
        );
      });

      it("a refused stop still explains a later clear_stop of the same ticker, and no other", async () => {
        await drop("a.yaml", batch(setStop("NOPE", "10 USD")));
        await drop("b.yaml", batch("command: clear_stop\nticker: NOPE", "command: clear_stop\nticker: OTHER"));
        const { lines } = await checkInbox();
        assert.match(
          lineOf(
            lines.filter((l) => l.startsWith("inbox/b.yaml")),
            1,
          )!,
          /not checked: depends on inbox\/a\.yaml/,
        );
        assert.match(
          lineOf(
            lines.filter((l) => l.startsWith("inbox/b.yaml")),
            2,
          )!,
          /no open position in OTHER$/,
        );
      });

      it("a file that is not YAML could have changed anything: a later refusal depends on it", async () => {
        await drop("a.yaml", "schema_version: 1\ncommands: [oops\n");
        await drop("b.yaml", batch("command: withdrawal\namount: 99999 EUR"));
        const { lines } = await checkInbox();
        assert.match(lines[1], /^inbox\/b\.yaml: command 1, line 3: not checked: depends on inbox\/a\.yaml/);
      });

      it("a file that is not checked counts as rejected for the ones after it", async () => {
        await drop("a.yaml", batch(buyTck(100, 2), "command: deposit\namount: 5 GBP"));
        await drop("b.yaml", batch("command: withdrawal\namount: 99999 USD"));
        await drop("c.yaml", batch("command: withdrawal\namount: 99999 USD"));
        const { lines } = await checkInbox();
        assert.match(lines[1], /^inbox\/b\.yaml: .*not checked: depends on inbox\/a\.yaml/);
        assert.match(lines[2], /^inbox\/c\.yaml: .*not checked: depends on inbox\/a\.yaml/);
      });
    });

    describe("the initial stop of a lot", () => {
      it("blames the set_stop of the lot's own currency, and names the stop portfolio.md holds", async () => {
        await withPortfolio(
          portfolioMd({
            eur: [{ ticker: "TCK", units: 1, price: 100 }],
            usd: [{ ticker: "TCK", units: 1, price: 100, stop: 150 }],
          }),
        );
        await drop("a.yaml", batch(setStop("TCK", "90 EUR"), buyTck(100)));
        const { lines, exitCode } = await checkInbox();
        assert.equal(exitCode, 1);
        assert.match(
          lines[0],
          /^inbox\/a\.yaml: command 2, line 6: the buy of TCK .*stop of 150 USD that portfolio\.md holds/,
        );
        assert.equal(lines.length, 2, lines.join("\n"));
      });

      it("names the earlier file when the stop comes from one", async () => {
        await drop("a.yaml", batch(setStop("SAP.DE", "500 USD")));
        await drop("b.yaml", batch("command: buy\nticker: SAP.DE\ndate: 2026-09-15\nunits: 1\nprice: 100 USD"));
        const { lines } = await checkInbox();
        assert.match(
          lines[0],
          /^inbox\/b\.yaml: command 1, line 3: .*stop of 500 USD that command 1 of inbox\/a\.yaml set/,
        );
        assert.doesNotMatch(lines[0], /portfolio\.md holds/);
      });

      it("gives one error for a set_stop that breaches several lots, naming them", async () => {
        await drop("a.yaml", batch(buyTck(100), buyTck(101), setStop("TCK", "150 USD")));
        const { lines } = await checkInbox();
        assert.equal(lines.length, 2, lines.join("\n"));
        assert.match(
          lines[0],
          /^inbox\/a\.yaml: command 3, line 13: the set_stop at 150 USD would be the initial stop of /,
        );
        assert.match(
          lines[0],
          /buy of TCK \(command 1, line 3\) at an entry price of 100 USD and the buy of TCK \(command 2, line 8\) at an entry price of 101 USD, not below them/,
        );
      });

      it("is listed as not checked when a refusal in its currency left the stops unknown", async () => {
        await drop("a.yaml", batch(buyTck(100), setStop("TCK", "150 USD"), "command: withdrawal\namount: 99999 USD"));
        const { lines, exitCode } = await checkInbox();
        assert.equal(exitCode, 1);
        assert.match(lineOf(lines, 3)!, /exceeds the available cash/);
        assert.match(
          lineOf(lines, 1)!,
          /^inbox\/a\.yaml: command 1, line 3: not checked: command 3 was refused, so the initial stop of the buy of TCK \(command 1, line 3\) at an entry price of 100 USD is unknown$/,
        );
        assert.doesNotMatch(lines.join("\n"), /R would be zero/);
        assert.match(lines.at(-1)!, /1 error\(s\) in 1 of 1 batch\(es\); 1 command\(s\) not checked\.$/);
      });
    });
  });

  describe("the command `npm run inbox:check`", () => {
    const run = () =>
      spawnSync(process.execPath, ["--import", "tsx/esm", join(import.meta.dirname, "..", "inbox.ts"), "check"], {
        env: { ...process.env, VAULT_PROJECT_DIR: vaultDir },
        encoding: "utf8",
      });

    it("exits 0 and prints on stdout for a clean batch", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 5 USD"));
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Inbox is clean/);
    });

    it("exits non-zero and lists the errors on stderr for a batch with errors", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 5"));
      const result = run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /inbox\/a\.yaml: command 1, line 3: "amount" needs its currency/);
    });

    it("is wired in package.json", () => {
      const scripts = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")).scripts;
      assert.equal(scripts["inbox:check"], "tsx src/inbox.ts check");
    });
  });

  describe("the inbox is not part of the heartbeat (the stop check does not read it)", () => {
    it("no module of the engine but the inbox's own reads the inbox", () => {
      const SRC = join(import.meta.dirname, "..");
      const inboxModules = new Set([
        "inbox.ts",
        "inbox-store.ts",
        "utils/inbox-check.ts",
        "utils/inbox-parse.ts",
        "utils/inbox-handlers.ts",
      ]);
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? e.name === "tests"
              ? []
              : walk(join(dir, e.name))
            : e.name.endsWith(".ts")
              ? [relative(SRC, join(dir, e.name))]
              : [],
        );
      const importers = walk(SRC).filter(
        (file) =>
          !inboxModules.has(file) && /from\s+["'][^"']*inbox[^"']*["']/.test(readFileSync(join(SRC, file), "utf8")),
      );
      assert.deepEqual(importers, []);
    });
  });
});
