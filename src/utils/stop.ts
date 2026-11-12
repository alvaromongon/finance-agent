// What a position's stop is, in one place (#132): a price above zero. A position with none, or with a stop
// that is not above zero, has no stop. Stop breach, tight stop, approaching stop, the inbox handlers and the
// heartbeat digest's list of positions without a stop all read it from here, so "no stop" is never defined twice.
import type { Position } from "../types.js";

/** A stop is a price; a position with none, or a stop that is not above zero, has no stop (`null`). */
export const stopOf = (position: Pick<Position, "stopLoss">): number | null =>
  position.stopLoss !== null && position.stopLoss > 0 ? position.stopLoss : null;

/** The positions that have no stop (`stopOf`), in their order. */
export const positionsWithoutStop = <P extends Pick<Position, "stopLoss">>(positions: readonly P[]): P[] =>
  positions.filter((p) => stopOf(p) === null);
