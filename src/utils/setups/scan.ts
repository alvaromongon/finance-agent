// Heartbeat setups step (ADR-0013). It lives apart from index.ts so
// it can be tested with a fake provider: index.ts runs main() on import.
//
// On each candidate (watchlist entry without an open position) it runs every
// detector and handles each new setup according to what the engine knows:
//
// - Confirmed and buyable → `setup` signal for the reasoner (with cooldown).
// - Confirmed and blocked → straight to `buy_blocked`, without spending the
//   escalation: the rules already made the decision.
// - Armed breakout → `setup_armed`, with the Buy Stop level, eligible or not.
//
// Everything goes to the decision log, acted on or not, with the engine
// conviction; armed breakouts also go out in the heartbeat summary email.
import { benchmarkFields, buildDecision, setupFields, strengthFields, type Decision } from "../../decisions.js";
import { latestScreening, setupConviction } from "../conviction.js";
import { money } from "../../money.js";
import { round2 } from "../round.js";
import { siloValue } from "../sizing.js";
import { snapshotFromTechnicals, type HistoricalSource } from "../strength.js";
import { detectNewSetups, evaluateSetup, type SetupEvaluation, type SetupParams } from "./index.js";
import type { Benchmark, PortfolioSnapshot, Signal, WatchlistEntry } from "../../types.js";

export interface SetupScanInput {
  watchlist: readonly WatchlistEntry[];
  portfolio: PortfolioSnapshot;
  /** The run's prices, to value the silo like the rest of the heartbeat. */
  prices?: ReadonlyMap<string, number>;
  /** Silo benchmark with its regime: the `regime_adverse` rule and the decision log field. */
  benchmark?: Benchmark;
  provider: HistoricalSource;
  date: string;
  rulesVersion: string;
  /** Decision log: each candidate's screening contributes points to its conviction. */
  history?: readonly Decision[];
  params?: SetupParams;
  log?: (msg: string) => void;
}

export interface SetupScanResult {
  /** Confirmed, buyable setups, to escalate to the reasoner. */
  signals: Signal[];
  /** Armed setups and blocked confirmed ones, ready for the decision log. */
  decisions: Decision[];
  /** The evaluations behind `decisions`, for the day's warning and the console. */
  notices: SetupEvaluation[];
}

export async function scanSetups(input: SetupScanInput): Promise<SetupScanResult> {
  const { portfolio, benchmark, provider, log = console.warn } = input;
  const result: SetupScanResult = { signals: [], decisions: [], notices: [] };
  if (!provider.getHistorical) return result;

  const held = new Set(portfolio.positions.map((p) => p.ticker));
  const silo = siloValue(portfolio, input.prices);

  for (const entry of input.watchlist) {
    if (held.has(entry.ticker)) continue;

    let bars;
    try {
      bars = await provider.getHistorical(entry.ticker, "1y");
    } catch (err) {
      log(
        `[setups] ${entry.ticker}: no history, setups not searched (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    if (bars.length === 0) continue;

    for (const setup of detectNewSetups(bars, input.params)) {
      const ev = evaluateSetup(setup, {
        entry,
        bars,
        regime: benchmark?.regime,
        cash: portfolio.cash,
        siloValue: silo,
      });
      const strength = snapshotFromTechnicals(ev.technicals);
      const conviction = setupConviction({
        screening: latestScreening(input.history ?? [], entry.ticker, input.date),
        regime: benchmark?.regime,
        rewardRisk: ev.ticket?.rrNet,
      });

      if (setup.state === "triggered" && ev.reasons.length === 0) {
        result.signals.push({
          ticker: entry.ticker,
          currency: entry.currency,
          triggers: ["setup"],
          price: setup.level,
          entry,
          cash: portfolio.cash,
          siloValue: silo,
          // The pattern target is the only level that anchors the reasoner's.
          strength: strength ? { ...strength, levels: [setup.target] } : undefined,
          benchmark,
          setup,
          conviction,
        });
        continue;
      }

      const ticket = ev.ticket;
      result.decisions.push(
        buildDecision({
          date: input.date,
          ticker: entry.ticker,
          currency: entry.currency,
          origin: "sistema",
          source: "heartbeat",
          type: setup.state === "armed" ? "setup_armed" : "buy_blocked",
          price: round2(bars[bars.length - 1].close),
          ...benchmarkFields(benchmark),
          horizon: entry.horizon,
          conviction: conviction.conviction,
          conviction_points: conviction.points,
          ...strengthFields(strength),
          ...setupFields(setup),
          target: setup.target,
          stop_initial: ticket?.stop,
          amount: ticket && ticket.amount > 0 ? ticket.amount : undefined,
          costs: ticket?.costs == null ? undefined : money(ticket.costs),
          eligibility:
            ev.reasons.length === 0
              ? { verdict: "eligible", reasons: [] }
              : { verdict: "blocked", reasons: ev.reasons },
          rules_version: input.rulesVersion,
        }),
      );
      result.notices.push(ev);
    }
  }
  return result;
}
