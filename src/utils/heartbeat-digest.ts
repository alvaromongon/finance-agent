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
// - Lots warnings repeat too: while the `Lots` table is wrong they are in every
//   digest (they have no key), so the problem is not forgotten after one email.
// - The differences of the latest snapshot of the broker repeat too (#138): they stay until a later snapshot shows none.
// - A stale silo and a snapshot with no difference go out once a day (`digestKeys`): the first until a snapshot
//   comes, the second only on the day it is recorded.
// - Rejected batches repeat as well (#152): a batch the inbox refused is never forgotten, so it is in every digest
//   until a later batch replaces or discards it.
// - The rest goes out once a day per currency while its relevant data do not
//   change (`digestKeys`). vault-io keeps the "already sent" state in
//   logs/heartbeat-sent-<currency>.json.
// - Escalated signals are an informational line: the BUY/SELL alert comes
//   separately when the Routine resolves them, and a HOLD asks for nothing.
import { asNumber } from "../money.js";
import { formatNumber, messages, type Messages } from "../i18n/index.js";
import { STOP_ATR_BY_HORIZON, type TightStop } from "./atr-stop.js";
import { describeSetup, type SetupEvaluation } from "./setups/index.js";
import type { StopBreach } from "./stop-breach.js";
import { printable } from "./printable.js";
import type { Ticker } from "../ticker.js";
import type { Currency, Difference, Signal } from "../types.js";
import type { Staleness } from "./staleness.js";
import type { ConfigurationProblem } from "../configuration.js";
import { configurationWarningLines } from "./configuration-warning.js";

export interface HeartbeatDigest {
  currency: Currency;
  /** Last manual sync of portfolio.md: tells how old the account state is. */
  syncedAt: string;
  /** Tight-stop warning threshold (STOP_MIN_ATR). */
  minAtr: number;
  breaches: StopBreach[];
  /** A stop the engine proposed this run is waiting in `inbox/` (#136): the breach outro says so only then. */
  stopProposed?: boolean;
  /**
   * Problems of the portfolio's `Lots` (ADR-0015): a table that does not read, or a `Volume` that is not
   * the sum of its lots. The run does not refuse the file: it keeps watching the positions and reports
   * them here, in every digest while they last (not deduplicated).
   */
  lotsWarnings: string[];
  /**
   * Rows of `Positions` and watchlist entries whose ticker does not parse (ADR-0016): skipped, so the run
   * keeps watching the rest; reported in every digest while they last (not deduplicated).
   */
  tickerWarnings: string[];
  /**
   * Cells of `Positions` (P/L) and `Cash` too large to count in cents (#86): read as unreadable (P/L 0, cash
   * 0 or absent) and named here, in every digest while they last (not deduplicated).
   */
  unreadableCells: string[];
  /**
   * The open positions of the silo with no stop (`positionsWithoutStop`, #132): risk watch cannot protect them.
   * Named in every digest while they last (not deduplicated), until a `set_stop` gives them one.
   */
  noStop: { ticker: Ticker; currency: Currency }[];
  /**
   * The batches `inbox:ingest` rejected that no later batch replaced or discarded (#152), by their file name in
   * `inbox/rejected/`. Named in every digest while they last (not deduplicated): a rejected batch is never forgotten.
   */
  rejectedBatches: string[];
  /**
   * The ids of the pending escalations (`logs/pending/`) that no `resolve` command has closed (#141). Named in every digest
   * while they last (not deduplicated): a signal that was escalated is never forgotten.
   */
  pendingEscalations: string[];
  /**
   * Why the engine's state file cannot be read (#139), when it cannot: the run then watches the stops of the last state that
   * did read (`state/portfolio.last-readable.json`) and names the corruption here, in every digest while it lasts (not
   * deduplicated). `null`: the state file reads.
   */
  storeProblem: string | null;
  /**
   * The configuration files the run read that do not validate (#142): the run goes on over their last valid version (or,
   * on the first run with none, refuses what needs them after the stop check). Named in every digest while the file on
   * disk is not the valid one (not deduplicated), and gone on the first run after a valid edit.
   */
  configurationProblems: ConfigurationProblem[];
  /**
   * How stale the silo is (#138): the age of its latest snapshot of the broker; a silo with none is stale. `null`: not
   * judged (the state is still the old `portfolio.md`, which has its own warning).
   */
  staleness: Staleness | null;
  /**
   * The latest snapshot of the broker of the silo, or `null` when none was ever recorded. Its differences are named in
   * every digest until a later snapshot shows none; one with no difference says so only the day it was recorded
   * (`recordedToday`), so a clean reconciliation is confirmed once and then stays quiet.
   */
  snapshot: { date: string; differences: Difference[]; recordedToday: boolean } | null;
  tightStops: TightStop[];
  /** The day's armed breakouts (ADR-0013): the only thing actionable without the reasoner. */
  armed: SetupEvaluation[];
  /** Signals left in logs/pending/ for the Routine. */
  escalated: Signal[];
}

/** "Already sent" keys of what the digest deduplicates; crossed stops, positions without a stop, rejected batches, configuration problems and the lots, ticker and unreadable-cell warnings have none. */
export function digestKeys(d: HeartbeatDigest): string[] {
  return [
    ...(d.staleness?.stale ? [staleKey(d.staleness)] : []),
    ...(cleanSnapshotToSay(d) ? [reconciledKey(d.snapshot!.date)] : []),
    ...d.tightStops.map(tightStopKey),
    ...d.armed.map(armedKey),
    ...d.escalated.map(escalatedKey),
  ];
}

/** The digest without what was already sent today. Crossed stops, positions without a stop, rejected batches, configuration problems and the lots, ticker and unreadable-cell warnings always stay: they repeat while they last. */
export function onlyNew(d: HeartbeatDigest, sent: ReadonlySet<string>): HeartbeatDigest {
  return {
    ...d,
    staleness: d.staleness?.stale && sent.has(staleKey(d.staleness)) ? null : d.staleness,
    snapshot:
      d.snapshot !== null && d.snapshot.differences.length === 0 && sent.has(reconciledKey(d.snapshot.date))
        ? null
        : d.snapshot,
    tightStops: d.tightStops.filter((t) => !sent.has(tightStopKey(t))),
    armed: d.armed.filter((a) => !sent.has(armedKey(a))),
    escalated: d.escalated.filter((s) => !sent.has(escalatedKey(s))),
  };
}

// Each alert's relevant data: if they change, it is news again.
const staleKey = (s: Staleness) => `stale|${s.asOf ?? "none"}`;
const reconciledKey = (date: string) => `reconciled|${date}`;
/** True for a snapshot with no difference that was recorded today: the one thing to say about it. */
const cleanSnapshotToSay = (d: HeartbeatDigest): boolean =>
  d.snapshot !== null && d.snapshot.differences.length === 0 && d.snapshot.recordedToday;
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
  if (d.tickerWarnings.length > 0) {
    sections.push({ label: t.labels.tickers, tickers: [], lines: tickersSection(d, m) });
  }
  if (d.unreadableCells.length > 0) {
    sections.push({ label: t.labels.unreadableCells, tickers: [], lines: unreadableCellsSection(d, m) });
  }
  if (d.noStop.length > 0) {
    sections.push({ label: t.labels.noStop, tickers: d.noStop.map((p) => p.ticker), lines: noStopSection(d, m) });
  }
  if (d.storeProblem !== null) {
    sections.push({ label: t.labels.storeUnreadable, tickers: [], lines: storeProblemSection(d, m) });
  }
  if (d.configurationProblems.length > 0) {
    sections.push({
      label: m.configurationWarning.label,
      tickers: [],
      lines: configurationWarningLines(d.configurationProblems, m),
    });
  }
  if (d.rejectedBatches.length > 0) {
    sections.push({ label: t.labels.rejectedBatches, tickers: [], lines: rejectedBatchesSection(d, m) });
  }
  if (d.pendingEscalations.length > 0) {
    sections.push({ label: t.labels.pendingEscalations, tickers: [], lines: pendingEscalationsSection(d, m) });
  }
  if (d.staleness?.stale) {
    sections.push({ label: t.labels.stale, tickers: [], lines: staleSection(d, d.staleness, m) });
  }
  if (d.snapshot !== null && d.snapshot.differences.length > 0) {
    sections.push({
      label: t.labels.differences,
      tickers: d.snapshot.differences.flatMap((x) => (x.kind === "position" ? [x.ticker] : [])),
      lines: differencesSection(d, m),
    });
  }
  if (cleanSnapshotToSay(d)) {
    sections.push({ label: t.labels.reconciled, tickers: [], lines: t.reconciledLines(d.currency, d.snapshot!.date) });
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
    ...(d.stopProposed ? m.heartbeatDigest.breachOutroStopWaiting : []),
  ];
}

function lotsSection(d: HeartbeatDigest, m: Messages): string[] {
  const t = m.heartbeatDigest;
  return [...t.lotsIntro, ...d.lotsWarnings.map((w) => `- ${w}`), ...t.lotsOutro];
}

function unreadableCellsSection(d: HeartbeatDigest, m: Messages): string[] {
  const t = m.heartbeatDigest;
  return [...t.unreadableCellsIntro, ...d.unreadableCells.map((w) => `- ${w}`), ...t.unreadableCellsOutro];
}

function noStopSection(d: HeartbeatDigest, m: Messages): string[] {
  const t = m.heartbeatDigest;
  return [...t.noStopIntro, ...d.noStop.map((p) => t.noStopLine(p.ticker, p.currency)), ...t.noStopOutro];
}

function storeProblemSection(d: HeartbeatDigest, m: Messages): string[] {
  const t = m.heartbeatDigest;
  // The reason quotes the file: printed escaped, so no control character reaches the email (S4).
  return [...t.storeUnreadableIntro, `- ${printable(d.storeProblem!)}`, ...t.storeUnreadableOutro];
}

function rejectedBatchesSection(d: HeartbeatDigest, m: Messages): string[] {
  const t = m.heartbeatDigest;
  return [
    ...t.rejectedBatchesIntro,
    // A file name is the owner's text inside a Markdown code span: its control characters are escaped (`printable`)
    // and a backtick, which would end the span, is written as an escape too.
    ...d.rejectedBatches.map((file) => t.rejectedBatchesLine(printable(file).replaceAll("`", "\\u0060"))),
    ...t.rejectedBatchesOutro,
  ];
}

function pendingEscalationsSection(d: HeartbeatDigest, m: Messages): string[] {
  const t = m.heartbeatDigest;
  return [
    ...t.pendingEscalationsIntro,
    // An id comes from a file name: escaped like a rejected batch's, so no control character or backtick reaches the email.
    ...d.pendingEscalations.map((id) => t.pendingEscalationsLine(printable(id).replaceAll("`", "\\u0060"))),
    ...t.pendingEscalationsOutro,
  ];
}

function staleSection(d: HeartbeatDigest, staleness: Staleness, m: Messages): string[] {
  const t = m.heartbeatDigest;
  return [
    ...t.staleIntro(d.currency),
    staleness.asOf === null
      ? t.staleNone(d.currency)
      : t.staleSince(d.currency, staleness.asOf.slice(0, 10), formatNumber(m, staleness.ageDays ?? 0, 1)),
    ...t.staleOutro,
  ];
}

/** `n` as the catalog writes a number, up to eight decimals (units are fractions), without trailing zeros. */
const plain = (m: Messages, n: number): string =>
  n.toLocaleString(m.locale, { minimumFractionDigits: 0, maximumFractionDigits: 8 });

/** `+10.50` or `-2`: the sign of a size, which a zero does not have. */
const sized = (text: string, size: number): string => `${size > 0 ? "+" : size < 0 ? "-" : ""}${text}`;

function differencesSection(d: HeartbeatDigest, m: Messages): string[] {
  const t = m.heartbeatDigest;
  const { date, differences } = d.snapshot!;
  return [
    ...t.differencesIntro(d.currency, date),
    ...differences.map((x) => {
      const size = Math.round((asNumber(x.broker) - asNumber(x.engine)) * 1e8) / 1e8;
      return x.kind === "cash"
        ? t.differenceCash(
            formatNumber(m, asNumber(x.broker)),
            formatNumber(m, asNumber(x.engine)),
            sized(formatNumber(m, Math.abs(size)), size),
            d.currency,
          )
        : t.differencePosition(x.ticker, plain(m, x.broker), plain(m, x.engine), sized(plain(m, Math.abs(size)), size));
    }),
    ...t.differencesOutro,
  ];
}

function tickersSection(d: HeartbeatDigest, m: Messages): string[] {
  const t = m.heartbeatDigest;
  return [...t.tickersIntro, ...d.tickerWarnings.map((w) => `- ${w}`), ...t.tickersOutro];
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
