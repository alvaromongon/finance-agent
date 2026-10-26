/**
 * Tests of the email outbox: mailer with MAIL_TRANSPORT=outbox,
 * hardening of smtp mode without credentials, and processOutbox (relay).
 * Temporary vault, no network or real SMTP — same pattern as
 * screening-flow.test.ts: VAULT_PROJECT_DIR is set BEFORE the first import of
 * config.js, so the app modules are imported dynamically in before().
 * MAIL_TRANSPORT is lazy in config, so it can vary per test.
 */
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BuyTicket, EngineTicket, Recommendation } from "../types.js";
import { parseTicker as tk } from "../ticker.js";

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

const BUY_REC: Recommendation = {
  ticker: tk("NVDA"),
  action: "BUY",
  ticket: {
    direction: "BUY",
    currency: "USD",
    target: 140,
  },
  assumptions: ["Supuesto de prueba"],
  thesis_summary: "Tesis de prueba para el outbox.",
  triggers: ["big_move"],
};

const HOLD_REC: Recommendation = { ...BUY_REC, action: "HOLD" };

describe("outbox", () => {
  let vaultDir: string;
  let outboxDir: string;
  let sendAlert: (rec: Recommendation, ticket: EngineTicket | null) => Promise<boolean>;
  let sendSummaryEmail: (subject: string, body: string) => Promise<boolean>;
  let assertMailConfigured: () => void;
  let MailDeliveryError: new (message: string) => Error;
  let processOutbox: (
    sender?: (subject: string, body: string) => Promise<void>,
  ) => Promise<{ sent: string[]; failed: string[] }>;
  let writeOutboxMessage: (msg: { subject: string; body: string; source: string }) => Promise<string>;
  let readOutboxMessage: (filename: string) => Promise<unknown>;

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-outbox-"));
    outboxDir = join(vaultDir, "logs", "outbox");
    process.env.VAULT_PROJECT_DIR = vaultDir;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;

    ({ sendAlert, sendSummaryEmail, assertMailConfigured, MailDeliveryError } = await import("../mailer.js"));
    ({ processOutbox } = await import("../outbox.js"));
    ({ writeOutboxMessage, readOutboxMessage } = await import("../vault-io.js"));
  });

  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
    delete process.env.MAIL_TRANSPORT;
    delete process.env.MAIL_REQUIRE_DELIVERY;
  });

  beforeEach(async () => {
    await rm(join(vaultDir, "logs"), { recursive: true, force: true });
    await mkdir(join(vaultDir, "logs"), { recursive: true });
    process.env.MAIL_TRANSPORT = "outbox";
    delete process.env.MAIL_REQUIRE_DELIVERY;
  });

  async function listOutbox(): Promise<string[]> {
    return readdir(outboxDir).catch(() => [] as string[]);
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

  describe("mailer with MAIL_TRANSPORT=outbox", () => {
    it("sendSummaryEmail persists the message as JSON and returns true", async () => {
      const ok = await quiet(() => sendSummaryEmail("Asunto de Prueba (2026)", "Cuerpo **Markdown**"));
      assert.equal(ok, true);

      const files = await listOutbox();
      assert.equal(files.length, 1);
      assert.match(files[0], /^\d{8}T\d{6}-\d{3}Z-asunto-de-prueba-2026\.json$/);

      const msg = JSON.parse(await readFile(join(outboxDir, files[0]), "utf8"));
      assert.equal(msg.subject, "Asunto de Prueba (2026)");
      assert.equal(msg.body, "Cuerpo **Markdown**");
      assert.equal(msg.source, "summary");
      assert.match(msg.created, /^\d{4}-\d{2}-\d{2}T/);
    });

    it("sendAlert with BUY queues; with HOLD returns false and writes nothing", async () => {
      assert.equal(await quiet(() => sendAlert(BUY_REC, BUY_TICKET)), true);
      const files = await listOutbox();
      assert.equal(files.length, 1);
      const msg = JSON.parse(await readFile(join(outboxDir, files[0]), "utf8"));
      assert.match(msg.subject, /ALERTA DE OPERACIÓN: BUY/);
      assert.equal(msg.source, "alert");

      assert.equal(await quiet(() => sendAlert(HOLD_REC, null)), false);
      assert.equal((await listOutbox()).length, 1, "HOLD must not queue");
    });
  });

  describe("mailer with MAIL_TRANSPORT=smtp", () => {
    it("without credentials returns false and writes nothing to the outbox", async () => {
      process.env.MAIL_TRANSPORT = "smtp";
      assert.equal(await quiet(() => sendSummaryEmail("Asunto", "Cuerpo")), false);
      assert.deepEqual(await listOutbox(), []);
    });

    it("with an invalid MAIL_TRANSPORT throws instead of falling back to smtp", async () => {
      process.env.MAIL_TRANSPORT = "smpt"; // typo deliberado
      await assert.rejects(() => sendSummaryEmail("Asunto", "Cuerpo"), /invalid MAIL_TRANSPORT="smpt"/);
    });
  });

  // An email that does not go out is invisible: the heartbeat ignored
  // sendAlert's boolean, so expired credentials silenced the alerts without a
  // trace and the workflow ended green.
  describe("MAIL_REQUIRE_DELIVERY (mandatory delivery)", () => {
    beforeEach(() => {
      process.env.MAIL_TRANSPORT = "smtp";
      process.env.MAIL_REQUIRE_DELIVERY = "true";
    });

    it("without credentials throws MailDeliveryError instead of falling back to 'logs only'", async () => {
      await assert.rejects(
        () => quiet(() => sendSummaryEmail("Asunto", "Cuerpo")),
        (err: Error) => {
          assert.ok(err instanceof MailDeliveryError, "must be a MailDeliveryError");
          assert.match(err.message, /SMTP_USER\/SMTP_PASS\/ALERT_EMAIL_TO not configured/);
          assert.match(err.message, /Subject: "Asunto"/, "the error identifies the lost email");
          return true;
        },
      );
      assert.deepEqual(await listOutbox(), [], "it must not queue as a side effect");
    });

    it("assertMailConfigured fails at startup, before spending the run", () => {
      assert.throws(() => {
        assertMailConfigured();
      }, MailDeliveryError);
    });

    it("assertMailConfigured passes with credentials present", () => {
      process.env.SMTP_USER = "u@example.com";
      process.env.SMTP_PASS = "secreto";
      process.env.ALERT_EMAIL_TO = "owner@example.com";
      try {
        assert.doesNotThrow(() => {
          assertMailConfigured();
        });
      } finally {
        delete process.env.SMTP_USER;
        delete process.env.SMTP_PASS;
        delete process.env.ALERT_EMAIL_TO;
      }
    });

    it("does not affect MAIL_TRANSPORT=outbox: the relay sends later", async () => {
      process.env.MAIL_TRANSPORT = "outbox";
      assert.doesNotThrow(() => {
        assertMailConfigured();
      });
      assert.equal(await quiet(() => sendSummaryEmail("Encolado", "Cuerpo")), true);
      assert.equal((await listOutbox()).length, 1);
    });

    it("HOLD still returns false: there is no email to lose", async () => {
      assert.equal(await quiet(() => sendAlert(HOLD_REC, null)), false);
      assert.deepEqual(await listOutbox(), []);
    });

    it("disabled (default) keeps 'logs only' mode", async () => {
      delete process.env.MAIL_REQUIRE_DELIVERY;
      assert.equal(await quiet(() => sendSummaryEmail("Asunto", "Cuerpo")), false);
    });
  });

  describe("processOutbox (relay)", () => {
    it("with MAIL_TRANSPORT=outbox throws (anti-loop guard)", async () => {
      await assert.rejects(() => processOutbox(async () => {}), /requires MAIL_TRANSPORT=smtp/);
    });

    it("sends in order and deletes only the successful ones", async () => {
      await quiet(() => sendSummaryEmail("Primero", "a"));
      await quiet(() => sendSummaryEmail("Segundo", "b"));
      process.env.MAIL_TRANSPORT = "smtp";

      const delivered: string[] = [];
      const sender = async (subject: string) => {
        if (subject === "Primero") throw new Error("SMTP caído");
        delivered.push(subject);
      };

      const result = await quiet(() => processOutbox(sender));
      assert.deepEqual(delivered, ["Segundo"], "the first one failing does not stop the rest");
      assert.equal(result.sent.length, 1);
      assert.equal(result.failed.length, 1);

      const remaining = await listOutbox();
      assert.equal(remaining.length, 1, "the failed one is kept");
      assert.match(remaining[0], /primero/);
    });

    it("keeps a malformed JSON without blocking the rest", async () => {
      await quiet(() => sendSummaryEmail("Válido", "cuerpo"));
      const badName = "20260718T000000-000Z-malformado.json";
      await writeFile(join(outboxDir, badName), JSON.stringify({ subject: "sin body" }), "utf8");
      process.env.MAIL_TRANSPORT = "smtp";

      const result = await quiet(() => processOutbox(async () => {}));
      assert.deepEqual(result.failed, [badName]);
      assert.equal(result.sent.length, 1);
      await access(join(outboxDir, badName));
    });

    it("with MAIL_TRANSPORT=none sends nothing and keeps the queue", async () => {
      await quiet(() => sendSummaryEmail("Queued", "a"));
      process.env.MAIL_TRANSPORT = "none";

      const result = await quiet(() =>
        processOutbox(async () => {
          throw new Error("must not send when email is off");
        }),
      );
      assert.deepEqual(result, { sent: [], failed: [] });
      assert.equal((await listOutbox()).length, 1);
    });

    it("with an empty outbox does nothing", async () => {
      process.env.MAIL_TRANSPORT = "smtp";
      const result = await quiet(() =>
        processOutbox(async () => {
          throw new Error("no debería llamarse");
        }),
      );
      assert.deepEqual(result, { sent: [], failed: [] });
    });
  });

  describe("file name validation", () => {
    it("readOutboxMessage rejects names that escape the directory", async () => {
      await assert.rejects(() => readOutboxMessage("../../evil.json"), /Invalid/);
      await assert.rejects(() => readOutboxMessage("20260718T000000-000Z-..%2f.json"), /Invalid/);
    });

    it("writeOutboxMessage builds a safe slug even with odd subjects", async () => {
      const path = await writeOutboxMessage({ subject: "¡¡¡···!!!", body: "x", source: "test" });
      assert.match(path, /logs\/outbox\/\d{8}T\d{6}-\d{3}Z-email\.json$/);
    });
  });
});
