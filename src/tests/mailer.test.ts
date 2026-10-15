/**
 * Tests of renderBody (mailer.ts): the alert shows the ticket the engine
 * computed — "TICKET DE ORDEN" on BUY/SELL and "AJUSTE DE STOP-LOSS"
 * without an amount on ADJUST_STOP. renderBody is not exported, so
 * it is checked through sendAlert with MAIL_TRANSPORT=outbox — same pattern as
 * outbox.test.ts: VAULT_PROJECT_DIR is set BEFORE the first import of
 * config.js, so the app modules are imported dynamically in before().
 */
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AdjustStopTicket, BuyTicket, EngineConviction, EngineTicket, Recommendation } from "../types.js";

const ADJUST_STOP_REC: Recommendation = {
  ticker: "XOM",
  action: "ADJUST_STOP",
  ticket: { direction: "ADJUST_STOP", currency: "USD" },
  thesis_summary: "Sube el stop-loss para proteger la ganancia acumulada.",
  triggers: ["approaching_stop"],
};

const ADJUST_STOP_TICKET: AdjustStopTicket = {
  kind: "ADJUST_STOP",
  currency: "USD",
  price: 138,
  stop: 132,
  previousStop: 125,
  stopAtr: 3,
};

const BUY_REC: Recommendation = {
  ...ADJUST_STOP_REC,
  action: "BUY",
  ticket: { direction: "BUY", currency: "USD", target: 140 },
  assumptions: ["El Brent aguanta los 80 $"],
};

const BUY_TICKET: BuyTicket = {
  kind: "BUY",
  currency: "USD",
  entry: 124.5,
  stop: 118,
  stopAtr: 3,
  units: 0.3614,
  amount: 45,
  costs: 0,
  taxPct: 0,
  risk: 2.35,
  riskBudget: 2.4,
  cappedBy: "risk",
  target: 140,
  rrGross: 2.38,
  rrNet: 2.38,
};

describe("mailer — renderBody through sendAlert", () => {
  let vaultDir: string;
  let outboxDir: string;
  let sendAlert: (
    rec: Recommendation,
    ticket: EngineTicket | null,
    notes?: string[],
    conviction?: EngineConviction,
  ) => Promise<boolean>;

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-mailer-"));
    outboxDir = join(vaultDir, "logs", "outbox");
    process.env.VAULT_PROJECT_DIR = vaultDir;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;

    ({ sendAlert } = await import("../mailer.js"));
  });

  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
    delete process.env.MAIL_TRANSPORT;
  });

  beforeEach(async () => {
    await rm(join(vaultDir, "logs"), { recursive: true, force: true });
    await mkdir(join(vaultDir, "logs"), { recursive: true });
    process.env.MAIL_TRANSPORT = "outbox";
  });

  async function readOnlyOutboxMessage(): Promise<{ subject: string; body: string }> {
    const files = await readdir(outboxDir);
    assert.equal(files.length, 1);
    return JSON.parse(await readFile(join(outboxDir, files[0]), "utf8"));
  }

  /** Silences console.log/warn during fn and returns its result. */
  async function quiet<T>(fn: () => Promise<T>): Promise<T> {
    const log = mock.method(console, "log", () => {});
    const warn = mock.method(console, "warn", () => {});
    try {
      return await fn();
    } finally {
      log.mock.restore();
      warn.mock.restore();
    }
  }

  it("ADJUST_STOP: subject with the action and an adjustment block with the engine stop", async () => {
    assert.equal(await quiet(() => sendAlert(ADJUST_STOP_REC, ADJUST_STOP_TICKET)), true);

    const { subject, body } = await readOnlyOutboxMessage();
    assert.match(subject, /ALERTA DE OPERACIÓN: ADJUST_STOP XOM/);
    assert.match(body, /^AJUSTE DE STOP-LOSS/);
    assert.match(body, /Nuevo stop-loss:\s+132 USD \(3 ATR bajo el precio\)/);
    assert.match(body, /Stop anterior:\s+125 USD/);
    assert.match(body, /Precio de referencia:\s+138 USD/);
  });

  it("ADJUST_STOP: no Direction or Amount (it is not a buy/sell)", async () => {
    await quiet(() => sendAlert(ADJUST_STOP_REC, ADJUST_STOP_TICKET));
    const { body } = await readOnlyOutboxMessage();
    assert.doesNotMatch(body, /Dirección:/);
    assert.doesNotMatch(body, /Importe:/);
    assert.doesNotMatch(body, /TICKET DE ORDEN/);
  });

  it("BUY: the engine ticket with units, ATR stop, target, risk, R:R and assumptions", async () => {
    await quiet(() => sendAlert(BUY_REC, BUY_TICKET, ["Regla de los dos meses: aviso de prueba"]));
    const { body } = await readOnlyOutboxMessage();
    assert.match(body, /^TICKET DE ORDEN/);
    assert.match(body, /Dirección:\s+BUY/);
    assert.match(body, /Unidades:\s+0\.3614/);
    assert.match(body, /Importe:\s+45\.00 USD/);
    assert.match(body, /Stop-loss:\s+118 USD \(3 ATR\)/);
    assert.match(body, /Objetivo:\s+140 USD/);
    assert.match(body, /R:R:\s+2\.38 bruto · 2\.38 neto/);
    assert.match(body, /AVISOS\n======\n- Regla de los dos meses/);
    assert.match(body, /SUPUESTOS\n=========\n- El Brent aguanta los 80 \$/);
    assert.doesNotMatch(body, /AJUSTE DE STOP-LOSS/);
  });

  it("the conviction is the engine's, with its points; without it there is no line", async () => {
    await quiet(() =>
      sendAlert(BUY_REC, BUY_TICKET, [], { conviction: "medium", points: ["regime_favorable", "reward_risk"] }),
    );
    assert.match((await readOnlyOutboxMessage()).body, /Convicción: medium \(régimen favorable, R:R ≥ 3\)/);
    await rm(outboxDir, { recursive: true, force: true });
    await quiet(() => sendAlert(ADJUST_STOP_REC, ADJUST_STOP_TICKET));
    assert.doesNotMatch((await readOnlyOutboxMessage()).body, /Convicción/);
  });

  it("in English with OUTPUT_LANGUAGE=en", async () => {
    process.env.OUTPUT_LANGUAGE = "en";
    try {
      await quiet(() =>
        sendAlert({ ...BUY_REC, assumptions: ["Brent holds 80 $"] }, BUY_TICKET, ["Check the earnings date"], {
          conviction: "medium",
          points: ["top_quintile"],
        }),
      );
    } finally {
      process.env.OUTPUT_LANGUAGE = "es";
    }

    const { subject, body } = await readOnlyOutboxMessage();
    assert.equal(subject, "[Finance Agent] TRADE ALERT: BUY XOM");
    assert.match(body, /^ORDER TICKET\n============\n/);
    assert.match(body, /Direction:\s+BUY/);
    assert.match(body, /Risk:\s+2\.35 USD of 2\.40 \(risk budget\)/);
    assert.match(body, /NOTICES\n=======\n- Check the earnings date/);
    assert.match(body, /ASSUMPTIONS\n===========\n- Brent holds 80 \$/);
    assert.match(body, /Conviction: medium \(top quintile\)\nTriggers: {3}approaching_stop/);
    assert.match(body, /not financial advice/);
    // The thesis comes from the reasoner, in whatever language it wrote it.
    assert.doesNotMatch(body.replace(BUY_REC.thesis_summary, ""), /[áéíóúñ¿¡]/i);
  });

  it("without an engine ticket nothing is sent", async () => {
    assert.equal(await quiet(() => sendAlert(BUY_REC, null)), false);
    await assert.rejects(() => readdir(outboxDir));
  });
});
