// Mechanical watchlist exit (ADR-0012 §8): the only way a candidate leaves
// watchlist.md, besides the Monday Briefing marking its thesis as invalidated.
// screening:prepare applies it with the run's ranking. Pure function: the
// caller supplies the ranking, the bars and the dates added.
import { config } from "../config.js";
import { detectSetups } from "./setups/index.js";
import type { ExclusionReason, RankableTicker, UniverseRanking } from "../screening-ranking.js";
import type { Currency, WatchlistEntry } from "../types.js";
import type { Ticker } from "../ticker.js";

export type WatchlistExitReason = "out_of_universe" | "filter_zero" | "out_of_top" | "no_setup";

/**
 * Why a ticker leaves the watchlist, as data: prepare saves it in the run file
 * and summarize renders it, so the text is built in the language of the render
 *. `describeExit` in screening-helpers.ts turns it into a sentence.
 */
export type WatchlistExit = { ticker: Ticker } & (
  | { reason: "out_of_universe" }
  | { reason: "filter_zero"; exclusion: ExclusionReason }
  | { reason: "out_of_top"; rank: number; of: number; currency: Currency }
  | { reason: "no_setup"; weeks: number }
);

export interface WatchlistExitInput {
  watchlist: readonly WatchlistEntry[];
  /** Tickers with an open position: never removed. */
  held: ReadonlySet<string>;
  /** Tickers of screening-universe.md. */
  universe: ReadonlySet<string>;
  ranking: UniverseRanking<RankableTicker>;
  /** Date added to the watchlist per ticker (its thesis `created`), YYYY-MM-DD. */
  addedOn: ReadonlyMap<string, string>;
  today: string;
  rules?: { keepTopFraction: number; noSetupWeeks: number };
}

/**
 * Filter 0 exclusions that say something about the security. `no_data`,
 * `stale` and `no_overlap` are source failures: removing on them would empty
 * the watchlist the day Yahoo fails.
 */
const RETIRING_EXCLUSIONS: readonly ExclusionReason[] = ["below_sma200", "short_history", "illiquid"];

const DAY_MS = 86_400_000;

export function mechanicalExits(input: WatchlistExitInput): WatchlistExit[] {
  const { keepTopFraction, noSetupWeeks } = input.rules ?? config.framework.screening;
  const exits: WatchlistExit[] = [];
  for (const entry of input.watchlist) {
    const { ticker } = entry;
    if (input.held.has(ticker)) continue;
    if (!input.universe.has(ticker)) {
      exits.push({ ticker, reason: "out_of_universe" });
      continue;
    }
    const excluded = input.ranking.excluded.find((e) => e.ticker === ticker);
    if (excluded) {
      if (RETIRING_EXCLUSIONS.includes(excluded.reason))
        exits.push({ ticker, reason: "filter_zero", exclusion: excluded.reason });
      continue;
    }
    const silo = input.ranking.bySilo[entry.currency];
    const ranked = silo.find((r) => r.item.ticker === ticker);
    if (!ranked) continue;
    if (ranked.rank > silo.length * keepTopFraction) {
      exits.push({ ticker, reason: "out_of_top", rank: ranked.rank, of: silo.length, currency: entry.currency });
      continue;
    }
    const added = input.addedOn.get(ticker);
    const since = Date.parse(input.today) - noSetupWeeks * 7 * DAY_MS;
    if (added == null || Date.parse(added) > since) continue;
    const hadSetup = ranked.bars.some(
      (b, i) => Date.parse(b.date) > since && detectSetups(ranked.bars.slice(0, i + 1)).length > 0,
    );
    if (!hadSetup) exits.push({ ticker, reason: "no_setup", weeks: noSetupWeeks });
  }
  return exits;
}
