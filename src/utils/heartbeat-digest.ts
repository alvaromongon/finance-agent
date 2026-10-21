// Heartbeat summary email: a single email per run, with one
// section per kind of alert, and only with what was not already sent today.
//
// Why: the heartbeat runs twice per currency and day, and each run used to
// send up to four separate emails (crossed stop, tight stop, armed breakouts
// and one per deferred signal), repeating in the second run what had not
// changed since the first. Lots of email, little signal.
//
// What repeats and what does not:
// - A crossed stop always goes out: it is the "did the broker fill it?"
//   question and it is no less urgent for having been asked already.
// - The rest goes out once a day per currency while its relevant data do not
//   change (`digestKeys`). vault-io keeps the "already sent" state in
//   logs/heartbeat-sent-<currency>.json.
// - Escalated signals are an informational line: the BUY/SELL alert comes
//   separately when the Routine resolves them, and a HOLD asks for nothing.
import { formatNumber, messages, type Messages } from "../i18n/index.js";
import { STOP_ATR_BY_HORIZON, type TightStop } from "./atr-stop.js";
import { describeSetup, type SetupEvaluation } from "./setups/index.js";
import type { StopBreach } from "./stop-breach.js";
import type { Currency, Signal } from "../types.js";

export interface HeartbeatDigest {
  currency: Currency;
  /** Last manual sync of portfolio.md: tells how old the account state is. */
  syncedAt: string;
  /** Tight-stop warning threshold (STOP_MIN_ATR). */
  minAtr: number;
  breaches: StopBreach[];
  /**
   * Problems of the portfolio's `Lots` against the decision log (ADR-0015). The run does not
   * refuse the file: it keeps watching the positions and reports them here.
   */
  lotsWarnings: string[];
  tightStops: TightStop[];
  /** The day's armed breakouts (ADR-0013): the only thing actionable without the reasoner. */
  armed: SetupEvaluation[];
  /** Signals left in logs/pending/ for the Routine. */
  escalated: Signal[];
}

/** "Already sent" keys of what the digest deduplicates; crossed stops have none. */
export function digestKeys(d: HeartbeatDigest): string[] {
  return [
    ...d.lotsWarnings.map(lotsKey),
    ...d.tightStops.map(tightStopKey),
    ...d.armed.map(armedKey),
    ...d.escalated.map(escalatedKey),
  ];
}

/** The digest without what was already sent today. Crossed stops always stay. */
export function onlyNew(d: HeartbeatDigest, sent: ReadonlySet<string>): HeartbeatDigest {
  return {
    ...d,
    lotsWarnings: d.lotsWarnings.filter((w) => !sent.has(lotsKey(w))),
    tightStops: d.tightStops.filter((t) => !sent.has(tightStopKey(t))),
    armed: d.armed.filter((a) => !sent.has(armedKey(a))),
    escalated: d.escalated.filter((s) => !sent.has(escalatedKey(s))),
  };
}

// Each alert's relevant data: if they change, it is news again.
const lotsKey = (warning: string) => `lots|${warning}`;
const tightStopKey = (t: TightStop) => `tight_stop|${t.ticker}|${t.stopLoss}`;
const armedKey = (a: SetupEvaluation) => `setup_armed|${a.ticker}|${a.setup.pattern}|${a.setup.level}`;
// Without the price on purpose: a re-escalation by price (cooldown) creates
// another pending file, but in the digest it is only an informational line and
// that analysis's BUY/SELL alert comes separately. Repeating it on every move
// would be noise.
const escalatedKey = (s: Signal) => `escalated|${s.ticker}|${[...s.triggers].sort().join(",")}`;

/** Subject and Markdown body of the digest; `null` if there is nothing to report. */
export function renderHeartbeatDigest(
  d: HeartbeatDigest,
  m: Messages = messages(),
): { subject: string; body: string } | null {
  const t = m.heartbeatDigest;
  const sections: { label: string; tickers: string[]; lines: string[] }[] = [];
  if (d.breaches.length > 0) {
    sections.push({ label: t.labels.breaches, tickers: d.breaches.map((b) => b.ticker), lines: breachSection(d, m) });
  }
  if (d.lotsWarnings.length > 0) {
    sections.push({ label: t.labels.lots, tickers: [], lines: lotsSection(d, m) });
  }
  if (d.tightStops.length > 0) {
    sections.push({
      label: t.labels.tightStops,
      tickers: d.tightStops.map((s) => s.ticker),
      lines: tightStopSection(d, m),
    });
  }
  if (d.armed.length > 0) {
    sections.push({ label: t.labels.armed, tickers: d.armed.map((a) => a.ticker), lines: armedSection(d, m) });
  }
  if (d.escalated.length > 0) {
    sections.push({
      label: t.labels.escalated,
      tickers: d.escalated.map((s) => s.ticker),
      lines: escalatedSection(d, m),
    });
  }
  if (sections.length === 0) return null;

  // The tickers in the subject, to see them from the notification.
  const subject = t.subject(
    d.currency,
    sections.map((s) => (s.tickers.length > 0 ? `${s.label}: ${s.tickers.join(", ")}` : s.label)).join(" · "),
  );
  const body = sections.map((s) => s.lines.join("\n")).join("\n\n");
  return { subject, body };
}

function breachSection(d: HeartbeatDigest, m: Messages): string[] {
  const fmt = (n: number) => formatNumber(m, n);
  return [
    ...m.heartbeatDigest.breachIntro(d.syncedAt.slice(0, 10)),
    ...m.heartbeatDigest.breachHeader,
    ...d.breaches.map(
      (b) =>
        `| ${b.ticker} | ${fmt(b.price)} ${b.currency} | ${fmt(b.stopLoss)} |` +
        ` -${b.belowStopPct.toFixed(2)}% | ${fmt(b.unrealizedPl)} ${b.currency} |`,
    ),
    ...m.heartbeatDigest.breachOutro,
  ];
}

function lotsSection(d: HeartbeatDigest, m: Messages): string[] {
  const t = m.heartbeatDigest;
  return [...t.lotsIntro, ...d.lotsWarnings.map((w) => `- ${w}`), ...t.lotsOutro];
}

function tightStopSection(d: HeartbeatDigest, m: Messages): string[] {
  const t = m.heartbeatDigest;
  const fmt = (n: number) => formatNumber(m, n);
  const belowEntry = d.tightStops.filter((s) => s.suggestedBelowEntry);
  return [
    ...t.tightIntro(d.minAtr),
    ...t.tightHeader(STOP_ATR_BY_HORIZON.medium),
    ...d.tightStops.map(
      (s) =>
        `| ${s.ticker} | ${fmt(s.price)} ${s.currency} | ${fmt(s.stopLoss)} |` +
        ` ${formatNumber(m, s.distancePct, 1)}% | ${formatNumber(m, s.atrPct, 2)}% |` +
        ` **${formatNumber(m, s.multiple, 1)} ATR** | ${fmt(s.suggestedStop)} |`,
    ),
    ...t.tightOptions,
    ...(belowEntry.length > 0 ? t.tightBelowEntry(belowEntry.map((s) => s.ticker).join(", ")) : []),
    ...t.tightOutro(d.syncedAt.slice(0, 10)),
  ];
}

function armedSection(d: HeartbeatDigest, m: Messages): string[] {
  return [
    ...m.heartbeatDigest.armedIntro,
    ...d.armed.map((a) => `- ${describeSetup(a, m)}`),
    ...m.heartbeatDigest.armedOutro,
  ];
}

function escalatedSection(d: HeartbeatDigest, m: Messages): string[] {
  const t = m.heartbeatDigest;
  return [
    ...t.escalatedIntro,
    ...d.escalated.map(
      (s) =>
        t.escalatedLine(s.ticker, s.triggers.join(", "), formatNumber(m, s.price), s.currency) +
        (s.setup ? t.escalatedSetup(s.setup.pattern, s.setup.target) : ""),
    ),
    ...t.escalatedOutro,
  ];
}
