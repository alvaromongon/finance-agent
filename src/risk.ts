// Arithmetic checks of the engine ticket. Only facts that are not
// calibrated: that there is cash, that the order reaches the broker minimum,
// that the stop is below the entry and that no more is sold than there is.
//
// The calibratable framework rules (minimum R:R, anchored target, no ATR no
// stop) live in utils/sizing.ts and block with their own reason: `risk.ts`
// blocks on facts, not on criteria (ADR-0011).
import { config } from "./config.js";
import { formatMoney, money, overByMoreThanACent } from "./money.js";
import type { EngineTicket, Signal } from "./types.js";

/** What the broker accepts as an order: fractional shares and their minimum amount. */
export type OrderRules = Pick<typeof config.broker, "fractionalShares" | "minOrderValue">;

export type TicketErrorCode =
  | "insufficient_cash"
  | "below_min_order"
  | "stop_not_below_entry"
  | "no_position"
  | "sell_above_position"
  | "invalid_amount";

export interface TicketError {
  code: TicketErrorCode;
  message: string;
}

export interface TicketValidation {
  valid: boolean;
  errors: TicketError[];
}

/**
 * Validates the arithmetic of a ticket already computed by the engine.
 * `signal` provides the silo cash and the position recorded in portfolio.md.
 */
export function validateTicket(
  ticket: EngineTicket,
  signal: Pick<Signal, "cash" | "position">,
  orderRules: OrderRules = config.broker,
): TicketValidation {
  const { fractionalShares, minOrderValue } = orderRules;
  const errors: TicketError[] = [];
  const err = (code: TicketErrorCode, message: string) => errors.push({ code, message });
  const cur = ticket.currency;

  switch (ticket.kind) {
    case "BUY": {
      const belowMin = fractionalShares ? ticket.amount < minOrderValue : ticket.units < 1;
      if (ticket.units <= 0 || belowMin) {
        // If cash is what capped the units, the real reason is the lack of cash.
        const minLabel = fractionalShares ? `the minimum order (${minOrderValue} ${cur})` : "1 whole share";
        err(
          ticket.cappedBy === "cash" ? "insufficient_cash" : "below_min_order",
          `amount ${formatMoney(ticket.amount)} ${cur} does not reach ${minLabel}` +
            (ticket.cappedBy === "cash" ? ` with the available cash (${formatMoney(signal.cash)} ${cur})` : ""),
        );
      }
      if (overByMoreThanACent(ticket.amount + ticket.costs, signal.cash)) {
        err(
          "insufficient_cash",
          `amount ${formatMoney(ticket.amount)} + costs ${formatMoney(ticket.costs)} ${cur} > available balance ${formatMoney(signal.cash)} ${cur}`,
        );
      }
      if (ticket.stop >= ticket.entry) {
        err("stop_not_below_entry", `stop-loss (${ticket.stop}) must be < entry (${ticket.entry})`);
      }
      break;
    }

    case "SELL": {
      if (!(ticket.amount > 0)) {
        err("invalid_amount", `amount to sell must be > 0; got: ${ticket.amount}`);
      }
      if (!signal.position) {
        // Without a recorded position there is no cap to check and nothing to sell:
        // it is blocked like an ADJUST_STOP, and the Monday Briefing does not record it either.
        err("no_position", "SELL recommended without an open position recorded in portfolio.md");
      } else {
        // currentPrice from portfolio.md (synced by hand from the broker), never a
        // price the reasoner proposes: the cap cannot be inflated.
        const positionValue = money(signal.position.volume * signal.position.currentPrice);
        if (overByMoreThanACent(ticket.amount, positionValue)) {
          err(
            "sell_above_position",
            `amount to sell (${formatMoney(ticket.amount)}) exceeds the recorded position value (${formatMoney(positionValue)})`,
          );
        }
      }
      break;
    }

    case "ADJUST_STOP": {
      if (!signal.position) {
        err("no_position", "ADJUST_STOP recommended without an open position recorded in portfolio.md");
      }
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}
