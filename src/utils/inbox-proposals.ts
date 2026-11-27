// The batches the flows drop in `inbox/` to change the watchlist (#140, spec #124): the screening proposes who joins and who
// leaves it, the Monday briefing who leaves it. A flow never edits `watchlist.md` or the store: it writes a batch like the
// owner's, and `inbox:ingest` applies it (or rejects it, and the digest says so). Pure: the file is written by
// `inbox-store.ts` (`dropBatchOnce`).
import yaml from "js-yaml";
import type { AssetClass, Currency, Horizon } from "../types.js";
import type { Ticker } from "../ticker.js";
import { INBOX_SCHEMA_VERSION } from "./inbox-parse.js";

/** A ticker the flow proposes to watch: the fields of a `watch` command. */
export interface WatchProposal {
  currency: Currency;
  ticker: Ticker;
  /** Why it is worth watching: the thesis, in a line or a paragraph. */
  note?: string;
  /** YYYY-MM-DD: the day it joins the list. */
  date?: string;
  horizon?: Horizon;
  assetClass?: AssetClass;
}

/** A ticker the flow proposes to retire: the fields of a `stop_watching` command. */
export interface StopWatchingProposal {
  ticker: Ticker;
  reason?: string;
}

const dump = (commands: readonly Record<string, string>[]): string =>
  yaml.dump({ schema_version: INBOX_SCHEMA_VERSION, commands }, { lineWidth: -1, noRefs: true });

/** The text of a batch of `watch` commands, one per proposal; the engine reads every value as text. */
export function watchBatch(proposals: readonly WatchProposal[]): string {
  return dump(
    proposals.map((p) => ({
      command: "watch",
      currency: p.currency,
      ticker: p.ticker,
      ...(p.note !== undefined && p.note.trim() !== "" ? { note: p.note.trim() } : {}),
      ...(p.date !== undefined ? { date: p.date } : {}),
      ...(p.horizon !== undefined ? { horizon: p.horizon } : {}),
      ...(p.assetClass !== undefined ? { asset_class: p.assetClass } : {}),
    })),
  );
}

/** The text of a batch of `stop_watching` commands, one per proposal. */
export function stopWatchingBatch(proposals: readonly StopWatchingProposal[]): string {
  return dump(
    proposals.map((p) => ({
      command: "stop_watching",
      ticker: p.ticker,
      ...(p.reason !== undefined && p.reason.trim() !== "" ? { reason: p.reason.trim() } : {}),
    })),
  );
}
