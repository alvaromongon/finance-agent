/**
 * Heartbeat flow tests: a single summary email per run, without
 * repeating in the next one what did not change. Temporary vault, no network
 * or real SMTP: MAIL_TRANSPORT=outbox leaves each email as a file in
 * logs/outbox/, so counting files is counting emails. Same pattern as
 * monday-briefing-flow.test.ts: VAULT_PROJECT_DIR is set before the first
 * import of config.js.
 */
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bar, extend, uptrend } from "./fixtures/setup-bars.js";
import type { IMarketDataProvider, HistoricalBar } from "../providers/types.js";
import type { IAnalystProvider } from "../analyst/types.js";
import type { Currency, PortfolioSnapshot, Signal } from "../types.js";
import { parsePositions } from "../utils/vault-parser.js";
import { entryLines, lotsSection, type HeldLot } from "./fixtures/lots.js";

const WATCHLIST_MD = `---
schema_version: 1
---

# Watchlist

\`\`\`yaml
watchlist:
  - ticker: XOM
    name: Exxon
    market: NYSE
    currency: USD
    horizon: medium
    thesis: "Sin setup; se mueve un 12% en la sesión."
  - ticker: BO
    name: Breakout
    market: NYSE
    currency: USD
    horizon: medium
    thesis: "Base pegada al máximo."
\`\`\`
`;

const portfolioMd = (positions: string, held: HeldLot[]) => `---
schema_version: 2
last_manual_sync: "2026-10-01"
---

## USD — Cash

| Item | Value |
|---|---|
| Available cash | $1000.00 |

## USD — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
${positions}

${lotsSection("USD", held)}`;

// MSFT with the stop 0.1 ATR from the price: tight stop and approaching_stop (deferred escalation).
const MSFT_ROW = "| MSFT | 1 | 492.01 | 501.02 | +9.01 | 500.00 |";
const MSFT_LOT: HeldLot = { ticker: "MSFT", units: 1, price: 492.01 };
// CAT already trades below its stop.
const CAT_ROW = "| CAT | 1 | 218.00 | 216.90 | -1.10 | 213.00 |";
const CAT_LOT: HeldLot = { ticker: "CAT", units: 1, price: 218 };

// A fifteen-session base right at the high; before() cuts it where it is
// armed for the first time (see setups-scan.test.ts). The detector is imported
// there: loading it here would load config.js before setting VAULT_PROJECT_DIR.
const run = uptrend(150);
const high = run[run.length - 1].close;
const base = extend(
  run,
  Array.from({ length: 15 }, (_, i) => high + (i % 2 ? 0.5 : -0.5)),
);

const flat = (close: number, spread: number): HistoricalBar[] =>
  Array.from({ length: 30 }, (_, i) => bar(i, close, { spread }));

const PRICES: Record<string, number> = { MSFT: 501.02, CAT: 210.77, XOM: 112.4, VOO: 800 };
const HISTORY: Record<string, HistoricalBar[]> = {
  MSFT: flat(501.02, 5),
  CAT: flat(216, 2),
  XOM: uptrend(250),
  VOO: uptrend(250, 600),
};

const provider: IMarketDataProvider = {
  getPrices: async (tickers) => new Map(tickers.filter((t) => t in PRICES).map((t) => [t, PRICES[t]])),
  getPreviousCloses: async (tickers) =>
    new Map(tickers.filter((t) => t in PRICES).map((t) => [t, t === "XOM" ? 100 : PRICES[t]])),
  getHistorical: async (ticker) => HISTORY[ticker] ?? [],
};

describe("runHeartbeat", () => {
  let vaultDir: string;
  let runHeartbeat: (
    currency: Currency,
    deps: {
      provider: IMarketDataProvider;
      analyst: IAnalystProvider;
      headlines?: (ticker: string) => Promise<string[]>;
      lastMarketDate?: (ticker: string) => Promise<Date | null>;
      lotsCheck?: (portfolio: PortfolioSnapshot) => string[];
    },
  ) => Promise<void>;
  const escalated: Signal[] = [];
  const analyst: IAnalystProvider = {
    escalate: async (signal) => {
      escalated.push(signal);
      return { status: "deferred", pendingPath: `logs/pending/2026-10-13-${signal.ticker.toLowerCase()}.md` };
    },
  };

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-heartbeat-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    ({ runHeartbeat } = await import("../heartbeat-run.js"));
    const { detectNewSetups } = await import("../utils/setups/index.js");
    HISTORY.BO = Array.from({ length: 16 }, (_, i) => base.slice(0, run.length + i)).find((bars) =>
      detectNewSetups(bars).some((s) => s.state === "armed"),
    )!;
    PRICES.BO = HISTORY.BO.at(-1)!.close;
  });

  after(async () => {
    delete process.env.MAIL_TRANSPORT;
    await rm(vaultDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    process.env.MAIL_TRANSPORT = "outbox";
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    escalated.length = 0;
    await rm(join(vaultDir, "logs"), { recursive: true, force: true });
    await rm(join(vaultDir, "state"), { recursive: true, force: true });
    await rm(join(vaultDir, "telemetry"), { recursive: true, force: true });
    await rm(join(vaultDir, "inbox"), { recursive: true, force: true });
    await mkdir(join(vaultDir, "logs"), { recursive: true });
    await mkdir(join(vaultDir, "strategies"), { recursive: true });
    await writeFile(join(vaultDir, "strategies", "base.md"), `---\nversion: "1.0"\n---\n`, "utf8");
    await mkdir(join(vaultDir, "routines"), { recursive: true });
    await writeFile(join(vaultDir, "routines", "execution-analysis.md"), "Reasoner instructions.\n", "utf8");
    await writeFile(join(vaultDir, "watchlist.md"), WATCHLIST_MD, "utf8");
    await setPortfolio(MSFT_ROW, [MSFT_LOT]);
  });

  /** portfolio.md with these position rows and, consistent with them, their lots and the entries in the log. */
  const setPortfolio = async (rows: string, held: HeldLot[]) => {
    await writeFile(join(vaultDir, "portfolio.md"), portfolioMd(rows, held), "utf8");
    await writeFile(join(vaultDir, "logs", "decisions.jsonl"), entryLines("USD", held), "utf8");
  };

  const heartbeat = async (over: Partial<Parameters<typeof runHeartbeat>[1]> = {}) => {
    const log = mock.method(console, "log", () => {});
    const warn = mock.method(console, "warn", () => {});
    const error = mock.method(console, "error", () => {});
    try {
      await runHeartbeat("USD", { provider, analyst, headlines: async () => [], ...over });
      return warn.mock.calls.map((c) => String(c.arguments[0]));
    } finally {
      log.mock.restore();
      warn.mock.restore();
      error.mock.restore();
    }
  };

  async function outbox(): Promise<{ subject: string; body: string }[]> {
    const dir = join(vaultDir, "logs", "outbox");
    const files = (await readdir(dir).catch(() => [] as string[])).sort();
    return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8"))));
  }

  it("tight stop + armed breakout + deferred signal produce exactly one email", async () => {
    await heartbeat();

    const emails = await outbox();
    assert.equal(emails.length, 1);
    assert.match(emails[0].subject, /stop ceñido: MSFT · ruptura armada: BO · a análisis: /);
    assert.deepEqual(escalated.map((s) => s.ticker).sort(), ["MSFT", "XOM"], "both escalated as before");
    assert.doesNotMatch(emails[0].subject, /pendiente de análisis/);
  });

  describe("a position without a stop (#132)", () => {
    const NO_STOP_ROW = "| MSFT | 1 | 492.01 | 501.02 | +9.01 | — |";

    it("is named in every digest, with its silo, while it lasts", async () => {
      await setPortfolio(NO_STOP_ROW, [MSFT_LOT]);
      await heartbeat();
      await heartbeat();

      const emails = await outbox();
      assert.equal(emails.length, 2, "it is not deduplicated: the second run sends it again");
      for (const email of emails) {
        assert.match(email.subject, /posición sin stop: MSFT/);
        assert.match(email.body, /## Posiciones sin stop/);
        assert.match(email.body, /- MSFT \(silo USD\)/);
      }
    });

    it("a stop of zero is no stop either: one definition for the digest and the stop checks", async () => {
      await setPortfolio("| MSFT | 1 | 492.01 | 501.02 | +9.01 | 0.00 |", [MSFT_LOT]);
      await heartbeat();
      const [email] = await outbox();
      assert.match(email.body, /- MSFT \(silo USD\)/);
      assert.doesNotMatch(email.subject, /stop ceñido|stop cruzado/);
    });

    it("a position with a stop is not named", async () => {
      await heartbeat();
      for (const email of await outbox()) assert.doesNotMatch(email.body, /Posiciones sin stop/);
    });
  });

  describe("prices are telemetry, never state (#133)", () => {
    const stateFiles = ["portfolio.json", "portfolio.last-readable.json"];
    const readState = async () => Promise.all(stateFiles.map((f) => readFile(join(vaultDir, "state", f), "utf8")));
    const seedStore = async () => {
      const { storeFromPortfolioFile, saveStore } = await import("../portfolio-store.js");
      await saveStore(await storeFromPortfolioFile());
    };

    it("a run changes no byte of the store, and the last prices are in telemetry and in the generated view", async () => {
      await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
      await seedStore();
      const before = await readState();

      await heartbeat();

      assert.deepEqual(await readState(), before);
      const telemetry = JSON.parse(await readFile(join(vaultDir, "telemetry", "prices-usd.json"), "utf8"));
      assert.deepEqual(Object.keys(telemetry.silos.USD).sort(), ["CAT", "MSFT"]);
      assert.equal(telemetry.silos.USD.CAT.price, "210.77");
      const view = await readFile(join(vaultDir, "portfolio.md"), "utf8");
      assert.match(view, /\| CAT \| 1 \| 218\.00 \| 210\.77 \| -7\.23 \| 213\.00 \|/);
    });

    it("risk watch still checks every stop of the state last applied, with no price written to it", async () => {
      await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
      await seedStore();

      await heartbeat();
      const [first] = await outbox();
      assert.match(first.subject, /stop cruzado: CAT/);

      // A later run reads the last prices over the state, and the stop is still the state's.
      await rm(join(vaultDir, "logs", "outbox"), { recursive: true, force: true });
      await heartbeat();
      const [second] = await outbox();
      assert.match(second.subject, /stop cruzado: CAT/, "a crossed stop is in every digest while it lasts");
      assert.match(second.body, /213/);
    });

    it("a telemetry file that does not read never stops risk watch", async () => {
      await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
      await seedStore();
      await mkdir(join(vaultDir, "telemetry"), { recursive: true });
      await writeFile(join(vaultDir, "telemetry", "prices-usd.json"), "{ not json", "utf8");

      await heartbeat();

      const [email] = await outbox();
      assert.match(email.subject, /stop cruzado: CAT/);
    });
  });

  describe("risk watch never stops for a rejected batch (ADR-0015, ADR-0018)", () => {
    const drop = async (name: string, text: string) => {
      await mkdir(join(vaultDir, "inbox"), { recursive: true });
      await writeFile(join(vaultDir, "inbox", name), text, "utf8");
    };
    const batch = (...commands: string[]) =>
      `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;

    it("with a rejected batch present, the heartbeat still checks every stop of the state it last applied", async () => {
      const { ingestInbox } = await import("../inbox.js");
      await setPortfolio("", []);
      await drop(
        "1-buy.yaml",
        batch(
          "command: buy\nticker: CAT\ndate: 2026-10-01\nunits: 1\nprice: 218 USD",
          "command: set_stop\nticker: CAT\nprice: 213 USD",
        ),
      );
      await drop("2-bad.yaml", batch("command: withdrawal\namount: 99999 USD"));
      const quiet = mock.method(console, "log", () => {});
      const quietWarn = mock.method(console, "warn", () => {});
      try {
        const result = await ingestInbox();
        assert.equal(result.exitCode, 1, "one batch was rejected");
      } finally {
        quiet.mock.restore();
        quietWarn.mock.restore();
      }
      assert.deepEqual(await readdir(join(vaultDir, "inbox", "rejected")), ["2-bad.yaml", "2-bad.yaml.errors.txt"]);

      await heartbeat();

      const [email] = await outbox();
      assert.match(
        email.subject,
        /stop cruzado: CAT/,
        "the crossed stop is detected from the store, rejected batch or not",
      );
      assert.match(email.body, /CAT/);
      assert.match(email.subject, /lote rechazado/, "and the rejected batch is named in the same digest");
      assert.match(email.body, /## Lotes rechazados a la espera de respuesta/);
      assert.match(email.body, /- `inbox\/rejected\/2-bad\.yaml`/);
      assert.match(email.body, /replaces: <archivo>/);
    });

    it("a rejected batch is named in every digest until a batch replaces or discards it (#152)", async () => {
      await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
      await mkdir(join(vaultDir, "inbox", "rejected"), { recursive: true });
      await writeFile(
        join(vaultDir, "inbox", "rejected", "bad.yaml"),
        batch("command: deposit\namount: 1 USD"),
        "utf8",
      );
      await heartbeat();
      await heartbeat();
      let emails = await outbox();
      assert.equal(emails.length, 2, "it is not deduplicated");
      for (const email of emails) assert.match(email.body, /inbox\/rejected\/bad\.yaml/);

      // Settled: the file stays, the digest stops naming it.
      const { storeFromPortfolioFile, saveStore } = await import("../portfolio-store.js");
      const { sha256 } = await import("../inbox-rejected.js");
      const seeded = await storeFromPortfolioFile();
      await saveStore({
        ...seeded,
        resolvedRejections: [
          {
            file: "bad.yaml",
            sha256: sha256(batch("command: deposit\namount: 1 USD")),
            how: "discarded",
            by: "d.yaml",
            at: "2026-11-13T09:00:00.000Z",
          },
        ],
      });
      await rm(join(vaultDir, "logs", "outbox"), { recursive: true, force: true });
      await heartbeat();
      emails = await outbox();
      assert.equal(emails.length, 1);
      assert.doesNotMatch(emails[0].body, /bad\.yaml/);
      assert.doesNotMatch(emails[0].subject, /lote rechazado/);
      assert.deepEqual(await readdir(join(vaultDir, "inbox", "rejected")), ["bad.yaml"]);
    });

    it("a pending escalation is named in every digest until a resolve command closes it (#141)", async () => {
      await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
      const id = "2026-11-20-xom";
      await mkdir(join(vaultDir, "logs", "pending"), { recursive: true });
      await writeFile(join(vaultDir, "logs", "pending", `${id}.md`), "---\nticker: XOM\n---\n", "utf8");
      await heartbeat();
      await heartbeat();
      let emails = await outbox();
      assert.equal(emails.length, 2, "it is not deduplicated");
      for (const email of emails) {
        assert.match(email.subject, /escalado pendiente/);
        assert.match(email.body, /- `logs\/pending\/2026-11-20-xom\.md`/);
        assert.match(email.body, /comando `resolve`/);
      }

      const { ingestInbox } = await import("../inbox.js");
      await drop("close.yaml", batch(`command: resolve\nid: ${id}\noutcome: resolved`));
      const quiet = mock.method(console, "log", () => {});
      const quietWarn = mock.method(console, "warn", () => {});
      try {
        assert.equal((await ingestInbox()).exitCode, 0);
      } finally {
        quiet.mock.restore();
        quietWarn.mock.restore();
      }
      await rm(join(vaultDir, "logs", "outbox"), { recursive: true, force: true });
      await heartbeat();
      emails = await outbox();
      assert.equal(emails.length, 1);
      assert.doesNotMatch(emails[0].body, /2026-11-20-xom/);
      assert.doesNotMatch(emails[0].subject, /escalado pendiente/);
      assert.deepEqual(await readdir(join(vaultDir, "logs", "pending")), [`${id}.md`], "the file stays as the record");
    });

    describe("the silo and the broker (#138)", () => {
      const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
      /** The store made from portfolio.md, its USD silo carrying `reconciled` (none: no snapshot was ever recorded). */
      const storeWith = async (reconciled?: PortfolioSnapshot<"USD">["reconciled"], syncedAt?: string) => {
        const { storeFromPortfolioFile, saveStore } = await import("../portfolio-store.js");
        const seeded = await storeFromPortfolioFile();
        const usd = seeded.silos.USD!;
        const { reconciled: _none, ...rest } = usd;
        await saveStore({
          ...seeded,
          silos: { USD: { ...rest, ...(syncedAt ? { syncedAt } : {}), ...(reconciled ? { reconciled } : {}) } },
        });
      };

      it("names a silo with no snapshot stale, once a day, and keeps watching the stops", async () => {
        await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
        await storeWith();
        await heartbeat();
        const [first] = await outbox();
        assert.match(first.subject, /stop cruzado: CAT/);
        assert.match(first.subject, /cartera desactualizada/);
        assert.match(first.body, /no tiene ninguna instantánea del bróker/);
        await rm(join(vaultDir, "logs", "outbox"), { recursive: true, force: true });
        await heartbeat();
        const [second] = await outbox();
        assert.doesNotMatch(second.subject, /cartera desactualizada/, "told once a day");
      });

      it("does not name a silo stale while its snapshot is recent, even if nothing else changed it for months", async () => {
        await storeWith({ date: day(2), differences: [] }, "2026-01-01T00:00:00.000Z");
        await heartbeat();
        for (const email of await outbox()) assert.doesNotMatch(email.subject, /desactualizada/);
      });

      it("names a silo whose latest snapshot is older than the limit, with its date", async () => {
        await storeWith({ date: day(30), differences: [] });
        await heartbeat();
        const [email] = await outbox();
        assert.match(email.subject, /cartera desactualizada/);
        assert.ok(email.body.includes(`**${day(30)}**`), email.body);
      });

      it("lists the differences of the latest snapshot in every digest, until a later one shows none", async () => {
        const { money } = await import("../money.js");
        const differences = [{ kind: "cash" as const, broker: money(1010.5, "USD"), engine: money(1000, "USD") }];
        await storeWith({ date: day(2), differences }, "2026-01-01T00:00:00.000Z");
        await heartbeat();
        await heartbeat();
        let emails = await outbox();
        const withDifferences = emails.filter((e) => e.subject.includes("diferencia con el bróker"));
        assert.equal(withDifferences.length, 2, "it is not deduplicated");
        assert.match(
          withDifferences[0].body,
          /Efectivo: el bróker tiene 1\.010,50 USD, el motor 1\.000,00 USD \(\+10,50 USD\)/,
        );

        await rm(join(vaultDir, "logs", "outbox"), { recursive: true, force: true });
        await storeWith({ date: day(1), differences: [] }, "2026-01-01T00:00:00.000Z");
        await heartbeat();
        emails = await outbox();
        for (const email of emails) assert.doesNotMatch(email.subject, /diferencia|instantánea/);
      });

      it("a snapshot with no difference recorded today says so once", async () => {
        await storeWith({ date: day(0), recordedOn: day(0), differences: [] });
        await heartbeat();
        await heartbeat();
        const emails = (await outbox()).filter((e) => e.subject.includes("instantánea sin diferencias"));
        assert.equal(emails.length, 1);
      });

      it("a snapshot with no difference recorded earlier is not confirmed again when a later batch moved syncedAt", async () => {
        await storeWith({ date: day(5), recordedOn: day(5), differences: [] }, new Date().toISOString());
        await heartbeat();
        for (const email of await outbox()) assert.doesNotMatch(email.subject, /instantánea sin diferencias/);
      });

      it("a corrupt state file never stops risk watch: the stops of the last readable state are checked and the digest names the corruption (ADR-0015, #139)", async () => {
        await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
        await storeWith({ date: day(0), recordedOn: day(0), differences: [] });
        await writeFile(join(vaultDir, "state", "portfolio.json"), '{"silos": {', "utf8");
        await heartbeat();
        const [email] = await outbox();
        assert.match(email.subject, /stop cruzado: CAT/, "the stop of the last readable state is still checked");
        assert.match(email.subject, /archivo de estado/);
        assert.match(email.body, /state\/portfolio\.json/);
        assert.match(email.body, /npm run state:repair/);
        // The corrupt file is left as it is: the repair is the way back, the heartbeat does not write over it.
        assert.equal(await readFile(join(vaultDir, "state", "portfolio.json"), "utf8"), '{"silos": {');
      });

      it("while the state is still the old portfolio.md, nothing is judged stale in the digest", async () => {
        await heartbeat();
        for (const email of await outbox()) assert.doesNotMatch(email.subject, /desactualizada/);
      });
    });

    it("a rejected batch is named even when there is nothing else to watch", async () => {
      await setPortfolio("", []);
      await mkdir(join(vaultDir, "inbox", "rejected"), { recursive: true });
      await writeFile(
        join(vaultDir, "inbox", "rejected", "bad.yaml"),
        batch("command: deposit\namount: 1 USD"),
        "utf8",
      );
      await heartbeat();
      const [email] = await outbox();
      assert.match(email.subject, /lote rechazado/);
    });

    it("a rejected/ folder that cannot be read is said in the log and never stops the stops", async () => {
      await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
      await mkdir(join(vaultDir, "elsewhere"), { recursive: true });
      await mkdir(join(vaultDir, "inbox"), { recursive: true });
      await symlink(join(vaultDir, "elsewhere"), join(vaultDir, "inbox", "rejected"));
      const warnings = await heartbeat();
      assert.ok(warnings.some((w) => w.includes("inbox/rejected is not a real folder")));
      const [email] = await outbox();
      assert.match(email.subject, /stop cruzado: CAT/);
      assert.doesNotMatch(email.subject, /lote rechazado/);
    });

    it("a file in inbox/ that cannot be read does not touch the run either", async () => {
      await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
      await drop("garbage.yaml", "commands: [\n");
      await heartbeat();
      const [email] = await outbox();
      assert.match(email.subject, /stop cruzado: CAT/);
    });
  });

  describe("a ticker that does not parse (ADR-0016): the row is skipped, the rest keeps working", () => {
    const BAD_ROW = "| M&M.NS | 4 | 100 | 100 | 0 | 90 |";

    it("a Positions row: the other positions are priced, the crossed stop goes out, the digest warns naming the row", async () => {
      await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}\n${BAD_ROW}`, [MSFT_LOT, CAT_LOT]);
      const warnings = await heartbeat();

      assert.ok(
        warnings.some((w) => w.includes("M&M.NS")),
        `warnings: ${JSON.stringify(warnings)}`,
      );
      const [email] = await outbox();
      assert.match(email.subject, /stop cruzado: CAT/, "the crossed stop is still detected");
      assert.match(email.subject, /ticker que no se lee/);
      assert.match(email.body, /## USD — Positions: Ticker "M&M\.NS"/);
      assert.match(await readFile(join(vaultDir, "portfolio.md"), "utf8"), /^\| CAT \| 1 \| 218\.00 \| 210,77 /m);
    });

    it("a watchlist entry of another currency: the USD run is not stopped and the digest names the entry", async () => {
      await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
      const list = await readFile(join(vaultDir, "watchlist.md"), "utf8");
      await writeFile(
        join(vaultDir, "watchlist.md"),
        list.replace(
          "\n```\n",
          '\n  - ticker: "M&M.NS"\n    name: Mahindra\n    market: NSE\n    currency: EUR\n    horizon: medium\n    thesis: "x"\n```\n',
        ),
        "utf8",
      );
      await heartbeat();

      const [email] = await outbox();
      assert.match(email.subject, /stop cruzado: CAT/);
      assert.match(email.body, /watchlist\.md: entry 3.*M&M\.NS/);
    });

    it("the warning repeats in every run while the row lasts", async () => {
      await setPortfolio(`${MSFT_ROW}\n${BAD_ROW}`, [MSFT_LOT]);
      await heartbeat();
      await heartbeat();

      const emails = await outbox();
      assert.equal(emails.length, 2);
      for (const email of emails) assert.match(email.body, /M&M\.NS/);
    });
  });

  describe("a money cell that cannot be counted in cents (#83, ADR-0015): read as unreadable, the stop alerts still go out", () => {
    for (const huge of ["1e307", "-1e307"]) {
      const crossedStopGoesOut = async () => {
        const [email] = await outbox();
        assert.match(email.subject, /stop cruzado: CAT/, "the crossed stop is still detected");
        return email;
      };
      const edit = async (change: (text: string) => string) => {
        const path = join(vaultDir, "portfolio.md");
        await writeFile(path, change(await readFile(path, "utf8")), "utf8");
      };

      it(`a Lots Entry costs of ${huge}: the row is skipped with a warning naming it and the reason`, async () => {
        await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
        await edit((text) => text.replace(/(\| lot-msft [^\n]*?\| )— (\| sistema)/, `$1${huge} $2`));

        const warnings = await heartbeat();

        assert.ok(
          warnings.some((w) => w.includes("Lots row 1 (MSFT, lot-msft)") && w.includes("Entry costs")),
          `warnings: ${JSON.stringify(warnings)}`,
        );
        const email = await crossedStopGoesOut();
        assert.match(email.body, /Lots row 1 \(MSFT, lot-msft\).*Entry costs/);
      });

      it(`a Positions P/L of ${huge}: the position is still watched, its P/L reads as unreadable`, async () => {
        await setPortfolio(`${MSFT_ROW}\n${CAT_ROW.replace("-1.10", huge)}`, [MSFT_LOT, CAT_LOT]);
        const warnings = await heartbeat();
        const email = await crossedStopGoesOut();
        assert.ok(
          warnings.some((w) => /Positions.*CAT.*P\/L.*too large to count in cents/.test(w)),
          `warnings: ${JSON.stringify(warnings)}`,
        );
        assert.match(email.subject, /celda que no se puede contar/);
        assert.match(email.body, /Positions.*CAT.*P\/L.*too large to count in cents/);
      });

      for (const row of ["Total cash", "Available cash"]) {
        it(`a Cash row ${row} of ${huge}: read as unreadable and named`, async () => {
          await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
          await edit((text) =>
            row === "Total cash"
              ? text.replace("| Available cash | $1000.00 |", `| Available cash | $1000.00 |\n| Total cash | ${huge} |`)
              : text.replace("$1000.00", huge),
          );
          const warnings = await heartbeat();
          const email = await crossedStopGoesOut();
          assert.ok(
            warnings.some((w) => new RegExp(`Cash.*${row}.*too large to count in cents`).test(w)),
            `warnings: ${JSON.stringify(warnings)}`,
          );
          assert.match(email.subject, /celda que no se puede contar/);
          assert.match(email.body, new RegExp(`Cash.*${row}.*too large to count in cents`));
        });
      }
    }
  });

  describe("Lots that do not match (ADR-0015): it keeps watching and warns loudly", () => {
    it("Volume that is not the sum of the units of its lots: the crossed stop still goes out, with the warning", async () => {
      // CAT trades below its stop; its row says 1 unit and its lot 3.
      await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, { ...CAT_LOT, units: 3 }]);
      const warnings = await heartbeat();

      assert.ok(
        warnings.some((w) => w.includes("WARNING, Lots:") && /CAT.*Volume 1/.test(w)),
        `warnings: ${JSON.stringify(warnings)}`,
      );
      const [email] = await outbox();
      assert.match(email.subject, /stop cruzado: CAT/, "the position is still watched for risk");
      assert.match(email.subject, /problema con los lotes/);
      assert.match(email.body, /CAT.*Volume 1/);
    });

    it("a lots check that throws does not lose the crossed stop: the digest goes out with it and the run fails", async () => {
      await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
      await assert.rejects(
        heartbeat({
          lotsCheck: () => {
            throw new Error("lots check blew up");
          },
        }),
        /lots check blew up/,
      );

      const [email] = await outbox();
      assert.match(email.subject, /stop cruzado: CAT/, "the crossed stop is in the digest that was sent");
      assert.doesNotMatch(email.subject, /lotes/, "a check that failed is not reported as a warning");
    });

    it("the alerting path does not read the decision log: Volume is checked from portfolio.md alone (#52)", async () => {
      // A lot whose entry is not in the log, and a log that cannot be parsed at all: neither reaches the
      // heartbeat. The checks that need the log run where the log is read (the evaluation).
      await setPortfolio(MSFT_ROW, [{ ...MSFT_LOT, id: "ghost-entry" }]);
      await writeFile(join(vaultDir, "logs", "decisions.jsonl"), "not json at all\n", "utf8");
      const warnings = await heartbeat();

      assert.deepEqual(
        warnings.filter((w) => w.includes("Lots")),
        [],
      );
      const [email] = await outbox();
      assert.match(email.subject, /stop ceñido: MSFT/);
      assert.doesNotMatch(email.subject, /problema con los lotes/);
    });

    it("a Volume that does not match is found by the lots' own Ticker column", async () => {
      // The row says MSFT 1, the lots say MSFT 1 and CAT 3 with no CAT row.
      await setPortfolio(MSFT_ROW, [MSFT_LOT, { ...CAT_LOT, units: 3 }]);
      const warnings = await heartbeat();
      assert.ok(
        warnings.some((w) => /CAT.*Volume 0.*3/.test(w)),
        `warnings: ${JSON.stringify(warnings)}`,
      );
    });

    it("the warning is not deduplicated: a second run the same day with the same mismatch repeats it", async () => {
      await setPortfolio(MSFT_ROW, [{ ...MSFT_LOT, units: 2 }]);
      await heartbeat();
      await heartbeat();

      const emails = await outbox();
      assert.equal(emails.length, 2, "a lots warning alone still produces a digest, every run");
      for (const email of emails) {
        assert.match(email.subject, /problema con los lotes/);
        assert.match(email.body, /MSFT.*Volume 1/);
      }
      assert.doesNotMatch(emails[1].subject, /stop ceñido/, "what is deduplicated still is");
    });

    it("a lot row that does not read is a lots warning naming the row and the reason, not only a Volume mismatch", async () => {
      await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
      const path = join(vaultDir, "portfolio.md");
      const text = await readFile(path, "utf8");
      await writeFile(path, text.replace(/\| sistema \|(?=[^\n]*\n[^\n]*\| lot-cat)/, "| Sistema |"), "utf8");

      const warnings = await heartbeat();

      assert.ok(
        warnings.some((w) =>
          w.includes('portfolio.md (USD): Lots row 1 (MSFT, lot-msft): Origin "Sistema" is not sistema or propietario'),
        ),
        `warnings: ${JSON.stringify(warnings)}`,
      );
      const [email] = await outbox();
      assert.match(email.body, /Lots row 1 \(MSFT, lot-msft\)/);
    });

    it("a Lots heading that is lost while its table stays: no phantom positions, the missing section is reported", async () => {
      await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
      const path = join(vaultDir, "portfolio.md");
      const text = await readFile(path, "utf8");
      const edited = text.replace("## USD — Lots\n", "");
      assert.notEqual(edited, text);
      assert.ok(edited.includes("| Entry id |"), "the table stays");
      await writeFile(path, edited, "utf8");

      const warnings = await heartbeat();

      assert.ok(
        warnings.some((w) => w.includes('portfolio.md (USD): missing section "## USD — Lots"')),
        `warnings: ${JSON.stringify(warnings)}`,
      );
      assert.deepEqual(
        parsePositions(edited, "USD").map((p) => p.ticker),
        ["MSFT", "CAT"],
      );
      const [email] = await outbox();
      assert.match(email.subject, /stop cruzado: CAT/);
    });

    describe("a Lots table that does not read", () => {
      const brokenHeader = async () => {
        await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
        const path = join(vaultDir, "portfolio.md");
        const text = await readFile(path, "utf8");
        await writeFile(path, text.replace("| Entry units |", "| Entry unitz |"), "utf8");
      };

      it("does not stop the heartbeat: the crossed stop goes out with the lots warning naming file and section", async () => {
        await brokenHeader();
        const warnings = await heartbeat();

        assert.ok(
          warnings.some((w) => w.includes("portfolio.md") && w.includes("USD — Lots")),
          `warnings: ${JSON.stringify(warnings)}`,
        );
        const [email] = await outbox();
        assert.match(email.subject, /stop cruzado: CAT/);
        assert.match(email.subject, /problema con los lotes/);
        assert.match(email.body, /portfolio\.md \(USD\): ## USD — Lots: columns Entry units missing/);
      });

      it("two consecutive runs with the same mismatch both include the warning", async () => {
        await brokenHeader();
        await heartbeat();
        await heartbeat();

        const emails = await outbox();
        assert.equal(emails.length, 2);
        for (const email of emails) assert.match(email.body, /Entry units missing/);
      });

      for (const [name, edit] of [
        ["a misspelled Lots heading", (text: string) => text.replace("## USD — Lots", "## USD — Lot")],
        ["a deleted Lots section", (text: string) => text.slice(0, text.indexOf("## USD — Lots"))],
      ] as const) {
        it(`${name} is a lots warning naming file and section, and the crossed stop still goes out`, async () => {
          await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
          const path = join(vaultDir, "portfolio.md");
          const text = await readFile(path, "utf8");
          const edited = edit(text);
          assert.notEqual(edited, text, "the edit changed the portfolio");
          await writeFile(path, edited, "utf8");

          const warnings = await heartbeat();

          assert.ok(
            warnings.some(
              (w) => w.includes("WARNING, Lots:") && w.includes("portfolio.md") && w.includes("## USD — Lots"),
            ),
            `warnings: ${JSON.stringify(warnings)}`,
          );
          const [email] = await outbox();
          assert.match(email.subject, /stop cruzado: CAT/);
          assert.match(email.body, /portfolio\.md \(USD\): missing section "## USD — Lots"/);
        });
      }

      it("a missing Cash section still stops the run", async () => {
        await brokenHeader();
        const path = join(vaultDir, "portfolio.md");
        await writeFile(path, (await readFile(path, "utf8")).replace("## USD — Cash", "## USD — Cashh"), "utf8");
        await assert.rejects(heartbeat(), /missing section "## USD — Cash"/);
      });

      it("a Positions table that does not read still stops the run", async () => {
        await brokenHeader();
        const path = join(vaultDir, "portfolio.md");
        await writeFile(path, (await readFile(path, "utf8")).replace("| Volume |", "| Volumez |"), "utf8");
        await assert.rejects(heartbeat(), /Positions: columns Volume missing/);
      });
    });

    it("a consistent portfolio raises no warning and no lots section", async () => {
      const warnings = await heartbeat();
      assert.deepEqual(
        warnings.filter((w) => w.includes("Lots")),
        [],
      );
      assert.doesNotMatch((await outbox())[0].subject, /lotes/);
    });
  });

  it("ADR-0018 Confirmation: an invalid batch in inbox/ leaves the heartbeat's stop detection untouched: the crossed stop goes out", async () => {
    await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
    await mkdir(join(vaultDir, "inbox"), { recursive: true });
    await writeFile(
      join(vaultDir, "inbox", "bad.yaml"),
      "schema_version: 1\ncommands:\n  - command: withdrawal\n    amount: 99999\n",
      "utf8",
    );
    await writeFile(join(vaultDir, "inbox", "broken.yaml"), "{ not yaml", "utf8");

    const warnings = await heartbeat();

    const [email] = await outbox();
    assert.match(email.subject, /stop cruzado: CAT/);
    assert.deepEqual(
      warnings.filter((w) => /inbox/i.test(w)),
      [],
      "the heartbeat says nothing of the inbox",
    );
    await rm(join(vaultDir, "inbox"), { recursive: true, force: true });
  });

  describe("the engine's stop proposals are a batch in inbox/, never a write of the state (#136)", () => {
    const BUY_DATE = "2026-10-01";
    const stateFile = () => join(vaultDir, "state", "portfolio.json");
    const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        return await fn();
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }
    };
    const dropBatchFile = async (name: string, text: string) => {
      await mkdir(join(vaultDir, "inbox"), { recursive: true });
      await writeFile(join(vaultDir, "inbox", name), text, "utf8");
    };
    /** The store, made by ingesting a batch that opens each position with its stop (400 unless `stops` says another). */
    const openStore = async (tickers: string[], stops: Record<string, number> = {}) => {
      const { ingestInbox } = await import("../inbox.js");
      await setPortfolio("", []);
      const commands = [
        "  - command: deposit\n    amount: 5000 USD",
        ...tickers.flatMap((t) => [
          `  - command: buy\n    ticker: ${t}\n    date: ${BUY_DATE}\n    units: 1\n    price: ${PRICES[t]} USD`,
          `  - command: set_stop\n    ticker: ${t}\n    price: ${stops[t] ?? 400} USD`,
        ]),
      ];
      await dropBatchFile("0-open.yaml", `schema_version: 1\ncommands:\n${commands.join("\n")}\n`);
      assert.equal((await quietly(() => ingestInbox())).exitCode, 0);
    };
    /** The reasoner proposes ADJUST_STOP for whatever it is asked about. */
    const proposing: IAnalystProvider = {
      escalate: async (signal) => ({
        status: "resolved",
        recommendation: {
          ticker: signal.ticker,
          action: "ADJUST_STOP",
          ticket: { direction: "ADJUST_STOP", currency: "USD" },
          thesis_summary: "Raise the stop.",
          triggers: ["big_move"],
        },
      }),
    };
    // Each position moved more than BIG_MOVE_PCT: one signal each, and its flat history makes the trailing stop rise above 400.
    const moved: IMarketDataProvider = {
      ...provider,
      getPreviousCloses: async (tickers) => new Map(tickers.map((t) => [t, 450])),
    };
    const stopFiles = async () =>
      (await readdir(join(vaultDir, "inbox")).catch(() => [] as string[]))
        .filter((f) => f.endsWith("-stops.yaml"))
        .sort();
    const stopsOf = async () => {
      const store = JSON.parse(await readFile(stateFile(), "utf8")) as {
        silos: { USD: { positions: { ticker: string; stop_loss: string }[] } };
      };
      return Object.fromEntries(store.silos.USD.positions.map((p) => [p.ticker, p.stop_loss]));
    };
    const stopCommands = (text: string) =>
      [...text.matchAll(/command: set_stop\n\s+ticker: "([^"]+)"\n\s+price: (\S+) (\w+)/g)].map((m) => ({
        ticker: m[1],
        price: m[2],
        currency: m[3],
      }));
    const resetLogs = async () => {
      // The cooldown would skip a second analysis of the same trigger and price.
      await rm(join(vaultDir, "logs"), { recursive: true, force: true });
      await mkdir(join(vaultDir, "logs"), { recursive: true });
      await writeFile(join(vaultDir, "logs", "decisions.jsonl"), "", "utf8");
    };

    it("a stop the reasoner proposes is one set_stop in one batch file that passes inbox:check; the state is not touched", async () => {
      const { checkInbox, ingestInbox } = await import("../inbox.js");
      await openStore(["MSFT"]);
      const before = await readFile(stateFile(), "utf8");

      await heartbeat({ provider: moved, analyst: proposing });

      assert.equal(await readFile(stateFile(), "utf8"), before, "not a byte of the state changes");
      const files = await stopFiles();
      assert.equal(files.length, 1);
      assert.match(files[0], /^\d{4}-\d{2}-\d{2}-heartbeat-usd-stops\.yaml$/);
      const dropped = stopCommands(await readFile(join(vaultDir, "inbox", files[0]), "utf8"));
      assert.equal(dropped.length, 1);
      assert.equal(dropped[0].ticker, "MSFT");
      assert.equal(dropped[0].currency, "USD");
      assert.ok(Number(dropped[0].price) > 400 && Number(dropped[0].price) < 501.02, "a raised stop below the price");

      const check = await quietly(() => checkInbox());
      assert.equal(check.exitCode, 0, check.lines.join("\n"));
      assert.equal((await stopsOf()).MSFT, "400", "check changes nothing");

      assert.equal((await quietly(() => ingestInbox())).exitCode, 0);
      assert.equal(Number((await stopsOf()).MSFT), Number(dropped[0].price), "only inbox:ingest writes the stop");
    });

    it("several proposals of a run share one batch file, one set_stop each", async () => {
      await openStore(["MSFT", "CAT"], { CAT: 150 });
      const before = await readFile(stateFile(), "utf8");

      await heartbeat({ provider: moved, analyst: proposing });

      assert.equal(await readFile(stateFile(), "utf8"), before);
      const files = await stopFiles();
      assert.equal(files.length, 1);
      const dropped = stopCommands(await readFile(join(vaultDir, "inbox", files[0]), "utf8"));
      assert.deepEqual(dropped.map((d) => d.ticker).sort(), ["CAT", "MSFT"]);
    });

    it("a stop that is blocked (it does not rise) is not dropped: nothing the engine did not already propose", async () => {
      // The stop already at 490: the trailing stop of the flat history (about 471) does not raise it.
      await setPortfolio("| MSFT | 1 | 492.01 | 501.02 | +9.01 | 490.00 |", [MSFT_LOT]);

      await heartbeat({ provider: moved, analyst: proposing });

      assert.deepEqual(await stopFiles(), []);
    });

    it("a proposal already dropped and not ingested is not dropped twice (the same ticker and price)", async () => {
      await openStore(["MSFT"]);
      await heartbeat({ provider: moved, analyst: proposing });
      const first = await stopFiles();
      assert.equal(first.length, 1);
      await resetLogs();

      await heartbeat({ provider: moved, analyst: proposing });

      assert.deepEqual(await stopFiles(), first);
    });

    it("the same stop written by the owner in another file counts as waiting too", async () => {
      await openStore(["MSFT"]);
      await heartbeat({ provider: moved, analyst: proposing });
      const [file] = await stopFiles();
      const [{ price }] = stopCommands(await readFile(join(vaultDir, "inbox", file), "utf8"));
      await rm(join(vaultDir, "inbox", file));
      await dropBatchFile(
        "owner.yaml",
        `schema_version: 1\ncommands:\n  - command: set_stop\n    ticker: msft\n    price: ${price}0 USD\n`,
      );
      await resetLogs();

      await heartbeat({ provider: moved, analyst: proposing });

      assert.deepEqual(await stopFiles(), []);
    });

    it("risk watch never waits: with a batch pending every stop is still checked against the last applied state", async () => {
      // CAT trades below its stop of 200; the engine's own proposal waits in inbox/, not ingested.
      await openStore(["CAT"], { CAT: 200 });
      PRICES.CAT = 190;
      try {
        await dropBatchFile(
          "2026-11-26-heartbeat-usd-stops.yaml",
          'schema_version: 1\ncommands:\n  - command: set_stop\n    ticker: "CAT"\n    price: 180 USD\n',
        );

        await heartbeat();

        const [email] = await outbox();
        assert.match(email.subject, /stop cruzado: CAT/, "the breach is read from the last applied state and prices");
        assert.deepEqual(await stopFiles(), ["2026-11-26-heartbeat-usd-stops.yaml"], "the pending batch is untouched");
      } finally {
        PRICES.CAT = 210.77;
      }
    });

    it("an inbox/ that cannot be written to is said and never stops the run", async () => {
      await openStore(["MSFT"]);
      await rm(join(vaultDir, "inbox"), { recursive: true, force: true });
      await symlink(tmpdir(), join(vaultDir, "inbox"));
      try {
        const warnings = await heartbeat({ provider: moved, analyst: proposing });

        assert.ok(
          warnings.some((w) => w.includes("not dropped in inbox") && w.includes("symbolic link")),
          warnings.join("\n"),
        );
      } finally {
        await rm(join(vaultDir, "inbox"), { force: true });
      }
    });
  });

  describe("a configuration file that does not validate never stops risk watch (#142, ADR-0015, ADR-0018)", () => {
    const strategy = join("strategies", "base.md");
    const prompt = join("routines", "execution-analysis.md");
    const edit = (file: string, text: string) => writeFile(join(vaultDir, file), text, "utf8");
    const stored = (file: string) => readFile(join(vaultDir, "state", "config", file), "utf8");
    const crossed = () => setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
    const decisionsRulesVersions = async () =>
      (await readFile(join(vaultDir, "logs", "decisions.jsonl"), "utf8"))
        .split("\n")
        .filter((l) => l.includes('"setup"'))
        .map((l) => JSON.parse(l).rules_version);

    it("an invalid strategy: every stop is checked on the last valid version and the digest warns with the errors", async () => {
      await crossed();
      await heartbeat(); // a valid run saves the copy
      assert.match(await stored(strategy), /version: "1.0"/);
      await rm(join(vaultDir, "logs", "outbox"), { recursive: true });
      await rm(join(vaultDir, "logs", "heartbeat-sent-USD.json"), { force: true });
      await edit(strategy, "# the version line was deleted\n");

      const warnings = await heartbeat();

      const [email] = await outbox();
      assert.match(email.subject, /stop cruzado: CAT/, "the crossed stop is checked and sent");
      assert.match(email.subject, /configuración que no valida/);
      assert.match(email.body, /## Un archivo de configuración no valida/);
      assert.match(email.body, /`strategies\/base\.md`: el motor trabaja con su \*\*última versión válida\*\*/);
      assert.match(email.body, /- frontmatter: missing: the file must start with a `---` block holding `version`/);
      assert.ok(warnings.some((w) => /configuration.*strategies\/base\.md is not valid/.test(w)));
      assert.ok(
        (await decisionsRulesVersions()).every((v) => v === "1.0"),
        "the rules version is the stored one",
      );
      assert.match(await stored(strategy), /version: "1.0"/, "the bad file never replaces the copy");
    });

    it("the warning is in every digest while the file is invalid and goes on the first run after a valid edit", async () => {
      await crossed();
      await heartbeat();
      await edit(strategy, "# broken\n");
      await heartbeat();
      await heartbeat();
      await edit(strategy, `---\nversion: "2.0"\n---\n`);
      await heartbeat();

      const emails = await outbox();
      assert.equal(emails.length, 4, "the stop is repeated on every run, and the warning with it while it lasts");
      assert.doesNotMatch(emails[0].body, /configuración no valida/);
      assert.match(emails[1].body, /configuración no valida/);
      assert.match(emails[2].body, /configuración no valida/);
      assert.doesNotMatch(emails[3].body, /configuración no valida/, "gone on the first run after a valid edit");
      assert.match(await stored(strategy), /version: "2.0"/, "the valid edit is the new copy");
    });

    it("an invalid strategy on the first run: the stop check and the digest go out, and the run refuses with the errors", async () => {
      await crossed();
      await edit(strategy, "# broken\n");

      await assert.rejects(
        heartbeat(),
        /strategies\/base\.md is not valid and there is no last valid version[^]*frontmatter/,
      );

      const [email] = await outbox();
      assert.match(email.subject, /stop cruzado: CAT/);
      assert.match(email.body, /\*\*aún no hay última versión válida\*\*/);
    });

    it("an invalid prompt: the escalation runs on the last valid prompt and the stops are checked", async () => {
      const { HandoffAnalystProvider } = await import("../analyst/handoff-provider.js");
      await crossed();
      await heartbeat({ analyst: new HandoffAnalystProvider() });
      assert.match(await stored(prompt), /Reasoner instructions/);
      await rm(join(vaultDir, "logs", "outbox"), { recursive: true });
      await rm(join(vaultDir, "logs", "heartbeat-sent-USD.json"), { force: true });
      await rm(join(vaultDir, "logs", "pending"), { recursive: true, force: true });
      await edit(prompt, "  \n");

      await heartbeat({ analyst: new HandoffAnalystProvider() });

      const [email] = await outbox();
      assert.match(email.subject, /stop cruzado: CAT/);
      assert.match(
        email.body,
        /`routines\/execution-analysis\.md`: el motor trabaja con su \*\*última versión válida\*\*/,
      );
      assert.match(email.body, /- content: empty/);
      const pending = join(vaultDir, "logs", "pending");
      const [file] = await readdir(pending);
      assert.match(await readFile(join(pending, file), "utf8"), /Reasoner instructions/, "the stored prompt was used");
    });

    it("an invalid prompt on the first run: the stop is in the digest that goes out before the run refuses", async () => {
      const { HandoffAnalystProvider } = await import("../analyst/handoff-provider.js");
      await crossed();
      await edit(prompt, "");

      await assert.rejects(
        heartbeat({ analyst: new HandoffAnalystProvider() }),
        /routines\/execution-analysis\.md is not valid and there is no last valid version/,
      );

      const [email] = await outbox();
      assert.match(email.subject, /stop cruzado: CAT/);
      assert.match(email.body, /## Un archivo de configuración no valida/);
    });
  });

  it("a second run with the same state sends nothing (no crossed stops)", async () => {
    await heartbeat();
    await heartbeat();

    assert.equal((await outbox()).length, 1);
  });

  it("a crossed stop is repeated on every run, with only what is new", async () => {
    await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
    await heartbeat();
    await heartbeat();

    const [, second] = await outbox();
    assert.ok(second, "the second run sends");
    assert.equal(second.subject, "[Finance Agent] Heartbeat USD — stop cruzado: CAT");
  });

  it("on a holiday only the crossed stop goes out: there is no new price to review", async () => {
    await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
    await heartbeat({ lastMarketDate: async () => new Date(Date.now() - 72 * 3_600_000) });

    const emails = await outbox();
    assert.equal(emails.length, 1);
    assert.equal(emails[0].subject, "[Finance Agent] Heartbeat USD — stop cruzado: CAT");
    assert.deepEqual(escalated, [], "no escalation on a holiday");
  });

  it("if the run fails halfway, the crossed stop goes out anyway and the run ends in error", async () => {
    await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
    const failing: IAnalystProvider = {
      escalate: async () => {
        throw new Error("reasoner down");
      },
    };

    await assert.rejects(heartbeat({ analyst: failing }), /reasoner down/);
    const emails = await outbox();
    assert.equal(emails.length, 1);
    assert.match(emails[0].subject, /stop cruzado: CAT/);
  });

  it("what was sent another day does not silence today's alerts, and does not accumulate", async () => {
    await writeFile(
      join(vaultDir, "logs", "heartbeat-sent-usd.json"),
      JSON.stringify({ date: "2026-01-02", keys: ["tight_stop|MSFT|500", "viejo"] }),
      "utf8",
    );
    await heartbeat();

    assert.equal((await outbox()).length, 1);
    const state = JSON.parse(await readFile(join(vaultDir, "logs", "heartbeat-sent-usd.json"), "utf8"));
    assert.equal(state.date, new Date().toISOString().slice(0, 10));
    assert.ok(!state.keys.includes("viejo"));
  });

  it("if the email does not go out, it is not marked as sent", async () => {
    process.env.MAIL_TRANSPORT = "smtp"; // no credentials: "logs only" mode, sendSummaryEmail returns false
    await heartbeat();

    await assert.rejects(readFile(join(vaultDir, "logs", "heartbeat-sent-usd.json"), "utf8"), { code: "ENOENT" });
  });
});
