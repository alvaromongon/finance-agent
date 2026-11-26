// The engine's stop proposals as an inbox batch (#136, spec #124, ADR-0018): an `ADJUST_STOP` the engine proposes is
// never written into the state by the flow that proposes it; it is dropped as a `set_stop` command in `inbox/`, and
// `inbox:ingest` applies it like the owner's. Pure: the file is read and written by `src/stop-proposals.ts`.
import { CURRENCIES, type Currency } from "../types.js";
import type { Ticker } from "../ticker.js";
import { parseBatch } from "./inbox-parse.js";

/** A stop the engine proposes for an open position: the one an `ADJUST_STOP` ticket carries. */
export interface StopProposal {
  ticker: Ticker;
  currency: Currency;
  stop: number;
}

/** A price as the inbox reads it: a plain decimal, no exponent, at most eight decimals; `null` if it is not above zero. */
export function plainPrice(price: number): string | null {
  if (!Number.isFinite(price)) return null;
  const text = price.toFixed(8).replace(/\.?0+$/, "");
  return Number(text) > 0 ? text : null;
}

/** What identifies a proposal for the "not dropped twice" rule: the ticker and the price as the file will say it. */
const keyOf = (ticker: Ticker, currency: Currency, price: string): string => `${ticker}|${currency}|${Number(price)}`;

/**
 * The `set_stop` commands waiting in the files of `inbox/` (their text), as keys. A file that does not read as a
 * batch contributes what it did parse and nothing else: whether it is valid is `inbox:check`'s to say, not this.
 */
export function pendingStopKeys(texts: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const text of texts) {
    for (const { command } of parseBatch(text).commands) {
      if (command.kind !== "set_stop") continue;
      const price = plainPrice(command.price);
      if (price !== null) keys.add(keyOf(command.ticker, command.currency, price));
    }
  }
  return keys;
}

/**
 * Splits `proposals` into the ones to drop and the ones already waiting in `inbox/` (the same ticker, currency and
 * price), and drops a proposal repeated within the list too. A proposal whose price is not above zero is never
 * dropped: it could not be a `set_stop`.
 */
export function newStopProposals(
  proposals: readonly StopProposal[],
  pendingTexts: readonly string[],
): { fresh: StopProposal[]; waiting: StopProposal[] } {
  const seen = pendingStopKeys(pendingTexts);
  const fresh: StopProposal[] = [];
  const waiting: StopProposal[] = [];
  for (const p of proposals) {
    const price = plainPrice(p.stop);
    if (price === null || !CURRENCIES.includes(p.currency)) continue;
    const key = keyOf(p.ticker, p.currency, price);
    if (seen.has(key)) {
      waiting.push(p);
      continue;
    }
    seen.add(key);
    fresh.push(p);
  }
  return { fresh, waiting };
}

/** The text of one batch file with a `set_stop` per proposal, in the format of `docs/input-format.md › inbox/`. */
export function renderStopBatch(proposals: readonly StopProposal[], origin: string, date: string): string {
  const lines = [
    `# Dropped by the engine (${origin}, ${date}): ADJUST_STOP proposals, each a set_stop command.`,
    `# It changes nothing until inbox:ingest applies it; placing the stop at the broker is up to you.`,
    `schema_version: 1`,
    `commands:`,
  ];
  for (const p of proposals) {
    const price = plainPrice(p.stop);
    if (price === null) throw new Error(`${p.ticker}: a stop of ${p.stop} cannot be written as a set_stop`);
    lines.push(`  - command: set_stop`, `    ticker: ${JSON.stringify(p.ticker)}`, `    price: ${price} ${p.currency}`);
  }
  return `${lines.join("\n")}\n`;
}
