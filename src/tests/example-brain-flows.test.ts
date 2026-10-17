/**
 * Every flow of the engine against a temporary copy of examples/brain, with the
 * fixtures provider, canned reasoner answers and a stubbed mail transport: no
 * network, no Claude, no SMTP. It proves the example prompts and files match
 * what prepare / finalize / resolve expect (spec #14, metric 2).
 */
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EXAMPLES = join(import.meta.dirname, "..", "..", "examples");
const MONDAY_REPORT = `## 0. Resumen ejecutivo

- Keep the cash for the next setup.

## 1. Plan de la semana

Keep the available cash in both currencies.

## 2. Salud de posiciones

| Ticker | P/L | Stop | Verdict | Note |
|---|---|---|---|---|
| SAP.DE | 0 | 168,00 | KEEP | Example |

## 3. Watchlist — Revisión

| Ticker | Price | Setup | Verdict | Note |
|---|---|---|---|---|
| AIR.PA | 150 | armed breakout | KEEP | Example |

## 4. Contexto macro y sectorial

- Fuente: [example](https://example.com/markets)

## 5. Próximos eventos a vigilar

| Date | Asset | Event | Impact |
|---|---|---|---|
| 2026-11-05 | SAP.DE | Results | High |

## AUTOMATED_ACTIONS
RETIRE:
PLAN_SUMMARY: Keep the cash this week
PROPOSALS: [{"ticker":"SAP.DE","action":"ADJUST_STOP","conviction":"medium"}]
`;

describe("every flow runs on the example brain", () => {
  let dir: string;
  const emailsQueued = async () => {
    const files = await readdir(join(dir, "logs", "outbox")).catch(() => [] as string[]);
    return files.length;
  };

  before(async () => {
    mock.method(console, "log", () => {});
    mock.method(console, "warn", () => {});
    mock.method(console, "error", () => {});
    // The USD heartbeat first: the EUR one leaves the brain the rest uses.
    const { runDemo } = await import("../demo.js");
    const usd = await runDemo("USD");
    assert.equal(usd.pending.length, 0);
    assert.equal(usd.emails.length, 1);
    await rm(usd.dir, { recursive: true, force: true });
    const eur = await runDemo("EUR");
    dir = eur.dir;
    assert.equal(eur.emails.length, 1);
    // The bars end on 2026-10-09: pin the clock to the following Monday so the
    // screening's freshness check does not depend on the day the suite runs.
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-12T12:00:00Z") });
  });

  after(async () => {
    mock.timers.reset();
    mock.restoreAll();
    await rm(dir, { recursive: true, force: true });
  });

  it("pending:resolve closes the escalation with a canned answer", async () => {
    const { listPending, resolvePending } = await import("../pending.js");
    await listPending();
    const [file] = await readdir(join(dir, "logs", "pending"));
    assert.match(file, /sap\.de\.md$/);
    await resolvePending(file, {
      ticker: "SAP.DE",
      action: "HOLD",
      ticket: { direction: "HOLD", currency: "EUR" },
      thesis_summary: "Example: the stop holds.",
      triggers: ["approaching_stop"],
    });
    assert.deepEqual(await readdir(join(dir, "logs", "pending")), []);
  });

  it("decisions:evaluate writes the evaluation the briefing reads", async () => {
    const { loadEvaluationReport } = await import("../decisions-evaluation-run.js");
    const { renderDecisionsEvaluation } = await import("../utils/decisions-evaluation-render.js");
    const report = await loadEvaluationReport("[decisions-evaluate]");
    await writeFile(join(dir, "logs", "decisions-evaluation.md"), renderDecisionsEvaluation(report), "utf8");
  });

  it("monday-briefing:prepare + finalize", async () => {
    const { FixturesProvider } = await import("../providers/fixtures.js");
    const { prepareBriefing, finalizeBriefing } = await import("../monday-briefing.js");
    const provider = new FixturesProvider(join(EXAMPLES, "market"));
    const { systemPrompt, userPrompt } = await prepareBriefing(provider);
    assert.equal(systemPrompt, await readFile(join(EXAMPLES, "brain", "routines", "monday-briefing.md"), "utf8"));
    assert.match(userPrompt, /SAP\.DE/);

    const before = await emailsQueued();
    await finalizeBriefing(MONDAY_REPORT, provider);
    const logs = await readdir(join(dir, "logs"));
    assert.ok(logs.some((f) => f.endsWith("-monday-briefing.md")));
    assert.equal(await emailsQueued(), before + 1);
  });

  it("screening:prepare + resolve + summarize", async () => {
    const { FixturesProvider } = await import("../providers/fixtures.js");
    const { runPrepare, resolveScreeningCandidate, summarizeScreening } = await import("../weekly-screening.js");
    const files = await runPrepare(new FixturesProvider(join(EXAMPLES, "market")), () => Promise.resolve([]));
    assert.ok(files.length > 0, "the example universe yields at least one candidate");

    for (const [i, file] of files.entries()) {
      await resolveScreeningCandidate(
        file,
        i === 0
          ? {
              interesting: true,
              reason: "Example: strong relative strength.",
              thesis: "Example thesis.",
              horizon: "medium",
              next_catalyst: "Results, 2026-11-05",
              invalidation: ["Example: margins fall."],
            }
          : { interesting: false, reason: "Example: nothing to add." },
      );
    }
    const before = await emailsQueued();
    await summarizeScreening();
    assert.equal(await emailsQueued(), before + 1);
  });

  it("decision:record logs a trade the owner narrates", async () => {
    const { FixturesProvider } = await import("../providers/fixtures.js");
    const { recordOwnerDecision } = await import("../decision.js");
    const d = await recordOwnerDecision(
      { type: "entry", ticker: "AIR.PA", currency: "EUR", price: 150, units: 1, stop: 140 },
      new FixturesProvider(join(EXAMPLES, "market")),
    );
    assert.equal(d.ticker, "AIR.PA");
    assert.match(await readFile(join(dir, "logs", "decisions.jsonl"), "utf8"), /AIR\.PA/);
  });

  it("outbox:send delivers every queued email through the stubbed transport", async () => {
    process.env.MAIL_TRANSPORT = "smtp";
    const { processOutbox } = await import("../outbox.js");
    const queued = await emailsQueued();
    assert.ok(queued >= 3, "heartbeat, briefing and screening emails were queued");
    const { sent, failed } = await processOutbox(() => Promise.resolve());
    assert.equal(sent.length, queued);
    assert.deepEqual(failed, []);
    assert.equal(await emailsQueued(), 0);
  });
});

describe("a missing prompt names the example to copy", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "finance-agent-no-prompts-"));
    await cp(join(EXAMPLES, "brain"), dir, { recursive: true });
    await rm(join(dir, "routines"), { recursive: true, force: true });
    Object.assign(process.env, {
      VAULT_PROJECT_DIR: dir,
      MARKET_DATA_PROVIDER: "fixtures",
      MARKET_FIXTURES_DIR: join(EXAMPLES, "market"),
    });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("monday-briefing:prepare", async () => {
    const { FixturesProvider } = await import("../providers/fixtures.js");
    const { prepareBriefing } = await import("../monday-briefing.js");
    await assert.rejects(
      prepareBriefing(new FixturesProvider(join(EXAMPLES, "market"))),
      /routines\/monday-briefing\.md.*examples\/brain\/routines\/monday-briefing\.md/s,
    );
  });

  it("screening:prepare", async () => {
    const { FixturesProvider } = await import("../providers/fixtures.js");
    const { prepareScreening } = await import("../weekly-screening.js");
    await assert.rejects(
      prepareScreening(new FixturesProvider(join(EXAMPLES, "market")), () => Promise.resolve([])),
      /routines\/weekly-screening\.md.*examples\/brain\/routines\/weekly-screening\.md/s,
    );
  });
});
