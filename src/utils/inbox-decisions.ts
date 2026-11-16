// The decision-log lines of the trades a clean batch applied (#132): one `entry` per buy and one `exit` per lot a sale
// touched, so the lots check and the evaluation read one history. Since #152 the inbox is the only way a trade is
// recorded; the lines are telemetry: the state is what the batch changed. Pure; the ids of the exits come from the one
// source of decision ids (`uniqueDecisionIds`).
import { createHash } from "node:crypto";
import { buildDecision, type Decision } from "../decisions.js";
import { exactAmount } from "../money.js";
import type { Trade } from "./inbox-check.js";
import { uniqueDecisionIds } from "./decision-id.js";

export interface DecisionContext {
  rulesVersion: string;
  /** Every id taken: the history's and the lots'. The ids of the exits are added to it. */
  takenIds: Set<string>;
}

/**
 * The lines for the trades of one file (`text`: what its ids are seeded from), in order. An exit whose share of the
 * sale rounds to nothing (a dust lot, the sale accepted with one exit of 0, #162) is recorded with an amount of 0, the
 * one amount of 0 the decision log accepts: the lot it closes is closed in the state, and an entry with no exit would
 * stay open in the log and lock `decisions:evaluate` out of the silo.
 */
export function decisionsOf(trades: readonly Trade[], text: string, context: DecisionContext): Decision[] {
  const nextId = uniqueDecisionIds(context.takenIds, createHash("sha256").update(text).digest("hex"));
  return trades.flatMap((trade): Decision[] => {
    const common = {
      date: trade.date,
      ticker: trade.ticker,
      currency: trade.currency,
      origin: "propietario" as const,
      source: "portfolio-sync" as const,
      price: trade.price,
      rules_version: context.rulesVersion,
    };
    if (trade.kind === "buy") {
      const { lot } = trade;
      return [
        buildDecision({
          ...common,
          id: lot.entryId,
          type: "entry",
          amount: exactAmount(trade.units * trade.price),
          units: trade.units,
          costs: trade.costs,
          stop_initial: lot.initialStop ?? undefined,
          rule_violations: lot.rulesViolations,
        }),
      ];
    }
    // Every lot a sale touched gets its exit, an amount of 0 included (dust): the lot is closed in the state, so
    // the log says it is closed, and no entry stays open in it (`lotsMismatches`).
    return trade.exits.map(({ share, lot }) =>
      buildDecision({
        ...common,
        id: nextId(trade.date, trade.ticker, "exit"),
        type: "exit",
        amount: share.amount,
        units: share.unitsSold,
        costs: share.costs,
        pnl: share.pnl,
        // The lot's, never the latest open entry's: each exit is self-contained (ADR-0015).
        related_id: lot.entryId,
        entry_price: lot.entryPrice,
        entry_units: lot.entryUnits,
        entry_costs: share.entryCosts,
        entry_date: lot.date,
        entry_origin: lot.origin,
        entry_rules_version: lot.rulesVersion,
        stop_initial: lot.initialStop ?? undefined,
        rule_violations: lot.rulesViolations,
        lot_units_left: share.unitsLeft,
      }),
    );
  });
}
