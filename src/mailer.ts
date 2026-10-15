// Email alerts. Abstraction over the provider (v1: nodemailer/Gmail SMTP;
// future: Resend). See routines/execution-analysis.md for the format.
//
// Two transports (MAIL_TRANSPORT):
//   - "smtp": direct send (GitHub Actions, local with credentials).
//   - "outbox": persists the email in logs/outbox/ for the
//     finance-agent-email-relay workflow to send — required in the Routines
//     cloud environments, whose egress proxy only tunnels port 443.
import nodemailer from "nodemailer";
import { marked } from "marked";
import { config } from "./config.js";
import { messages, type Messages } from "./i18n/index.js";
import { writeOutboxMessage } from "./vault-io.js";
import { describeTicket } from "./utils/sizing.js";
import { describeConviction } from "./utils/conviction.js";
import type { EngineConviction, EngineTicket, Recommendation } from "./types.js";

// Bodies are written in Markdown (LLM and fixed templates). Gmail does not
// render Markdown in plain-text emails, so besides `text` an `html` part with
// the converted Markdown is sent — same content, readable in the mail client.
function markdownToEmailHtml(markdown: string): string {
  const content = marked.parse(markdown, { async: false });
  return [
    '<div style="font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #1a1a1a; max-width: 720px;">',
    "<style>",
    "table { border-collapse: collapse; width: 100%; margin: 12px 0; }",
    "th, td { border: 1px solid #d0d0d0; padding: 6px 10px; text-align: left; }",
    "th { background: #f2f2f2; }",
    "code { background: #f2f2f2; padding: 1px 4px; border-radius: 3px; font-size: 13px; }",
    "pre { background: #f2f2f2; padding: 10px; border-radius: 4px; overflow-x: auto; }",
    "blockquote { border-left: 3px solid #d0d0d0; margin: 8px 0; padding: 2px 12px; color: #555; }",
    "h1, h2, h3 { border-bottom: 1px solid #eee; padding-bottom: 4px; }",
    "</style>",
    content,
    "</div>",
  ].join("\n");
}

/**
 * Strict SMTP send: throws if credentials are missing or sending fails.
 * Used by `deliver` (smtp mode with credentials) and by outbox:send from the relay.
 */
export async function sendEmailSmtp(subject: string, markdownBody: string): Promise<void> {
  const to = config.mail.to();
  if (!to) throw new Error("ALERT_EMAIL_TO is not configured: the email has no recipient");
  const transporter = nodemailer.createTransport({
    host: config.mail.smtpHost,
    port: config.mail.smtpPort,
    secure: config.mail.smtpPort === 465,
    auth: { user: config.mail.smtpUser(), pass: config.mail.smtpPass() },
  });
  await transporter.sendMail({
    from: config.mail.from(),
    to,
    subject,
    text: markdownBody,
    html: markdownToEmailHtml(markdownBody),
  });
  console.log(`[mailer] Email sent to ${to}: ${subject}`);
}

/**
 * Delivery error with MAIL_REQUIRE_DELIVERY=true. It has its own type so
 * callers can tell it apart from a data failure.
 */
export class MailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailDeliveryError";
  }
}

/** SMTP credentials and a recipient: without any of them no email goes out. */
const smtpReady = (): boolean => Boolean(process.env.SMTP_USER && process.env.SMTP_PASS && config.mail.to());

/** Single message for both paths (startup and delivery). */
const MISSING_SMTP =
  "SMTP_USER/SMTP_PASS/ALERT_EMAIL_TO not configured and MAIL_REQUIRE_DELIVERY=true: " +
  "the email cannot be delivered. Check the repository secrets " +
  "(or remove MAIL_REQUIRE_DELIVERY if this environment must not send mail).";

/**
 * Checks up front that delivery is possible, to fail before spending the run
 * (same pattern as `createAnalystProvider` in index.ts). It only acts with
 * MAIL_REQUIRE_DELIVERY=true; in outbox mode there is nothing to validate,
 * because the relay does the real sending later.
 */
export function assertMailConfigured(): void {
  if (!config.mail.requireDelivery()) return;
  const transport = config.mail.transport();
  if (transport !== "smtp") return;
  if (!smtpReady()) {
    throw new MailDeliveryError(MISSING_SMTP);
  }
}

/**
 * Delivers according to MAIL_TRANSPORT. Returns true if the email went out
 * (smtp) or was persisted in logs/outbox/ (outbox); false only in smtp mode
 * without credentials ("logs only" mode: the body is dumped to the log).
 * Whoever depends on the email not being lost (e.g. summarizeScreening before
 * deleting results.jsonl) must check the boolean.
 *
 * With MAIL_REQUIRE_DELIVERY=true that `false` stops being a return value and
 * becomes a `MailDeliveryError`: in the workflows that do send, a lost email
 * must turn the run red instead of going unnoticed (the heartbeat ignored
 * `sendAlert`'s boolean, so expired credentials silenced the alerts without
 * anything giving it away).
 */
async function deliver(subject: string, body: string, source: string): Promise<boolean> {
  const transport = config.mail.transport();
  if (transport === "outbox") {
    const path = await writeOutboxMessage({ subject, body, source });
    console.log(`[mailer] Email queued in ${path} (the Actions relay will send it)`);
    return true;
  }
  if (transport !== "smtp") {
    // A typo in MAIL_TRANSPORT must not silently fall back to smtp: in the
    // cloud environment that means hanging on a connection timeout.
    throw new Error(`invalid MAIL_TRANSPORT="${transport}" (values: smtp | outbox)`);
  }

  // "Logs only" mode: without SMTP credentials no email is sent — the body is
  // dumped to the Action log so it can be reviewed. Legitimate locally and in
  // tests; unacceptable where delivery is required.
  if (!smtpReady()) {
    if (config.mail.requireDelivery()) {
      throw new MailDeliveryError(`${MISSING_SMTP} Subject: "${subject}".`);
    }
    console.warn("[mailer] SMTP_USER/SMTP_PASS/ALERT_EMAIL_TO not configured — email NOT sent. Dumping to the log:");
    console.log(`\n=== ${subject} ===\n${body}\n`);
    return false;
  }

  await sendEmailSmtp(subject, body);
  return true;
}

/**
 * Trade alert with the engine ticket. HOLD, or a recommendation
 * without a ticket, sends no email.
 */
export async function sendAlert(
  rec: Recommendation,
  ticket: EngineTicket | null,
  notes: readonly string[] = [],
  conviction?: EngineConviction,
): Promise<boolean> {
  if (rec.action === "HOLD" || !ticket) return false;

  const m = messages();
  return deliver(m.mail.alertSubject(rec.action, rec.ticker), renderBody(rec, ticket, notes, conviction, m), "alert");
}

/** Sends a free-text summary email (weekly review, screening, etc.) */
export async function sendSummaryEmail(subject: string, body: string): Promise<boolean> {
  return deliver(subject, body, "summary");
}

function renderBody(
  rec: Recommendation,
  ticket: EngineTicket,
  notes: readonly string[],
  conviction: EngineConviction | undefined,
  m: Messages,
): string {
  const t = m.mail;
  const isAdjustStop = ticket.kind === "ADJUST_STOP";
  const rows: [string, string][] = [
    [t.tickerField, rec.ticker],
    // ADJUST_STOP is not a buy/sell: no direction or amount.
    ...(isAdjustStop ? [] : [[t.directionField, ticket.kind] as [string, string]]),
    ...describeTicket(ticket, m),
  ];
  const width = Math.max(...rows.map(([field]) => field.length)) + 2;
  const footerWidth = Math.max(t.convictionLabel.length, t.triggersLabel.length) + 1;
  return [
    ...heading(isAdjustStop ? t.adjustStopTitle : t.orderTicketTitle),
    ...rows.map(([field, value]) => `${`${field}:`.padEnd(width)}${value}`),
    "",
    t.engineNote,
    "",
    ...(notes.length > 0 ? [...heading(t.noticesTitle), ...notes.map((n) => `- ${n}`), ""] : []),
    ...(rec.assumptions && rec.assumptions.length > 0
      ? [...heading(t.assumptionsTitle), ...rec.assumptions.map((a) => `- ${a}`), ""]
      : []),
    ...heading(t.thesisTitle),
    rec.thesis_summary,
    "",
    // The engine's: only a buy coming from a setup carries it.
    ...(conviction ? [`${t.convictionLabel.padEnd(footerWidth)}${describeConviction(conviction, m)}`] : []),
    `${t.triggersLabel.padEnd(footerWidth)}${rec.triggers.join(", ")}`,
    "",
    "---",
    t.disclaimer,
  ].join("\n");
}

/** Plain-text heading underlined with "=" to its length. */
function heading(title: string): string[] {
  return [title, "=".repeat(title.length)];
}
