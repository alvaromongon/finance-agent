// How a message names a silo's part of `portfolio.md`. Pure wording, shared by the storage layer and the
// lots check; it reads and writes nothing.
import type { Currency } from "../types.js";

/** `portfolio.md (USD)`: file and silo, the prefix of every message about the lots of one silo. */
export const portfolioWhere = (currency: Currency): string => `portfolio.md (${currency})`;

/** The message for a silo without its `## <CURRENCY> — Lots` section: the one place it is worded. */
export const missingLotsSection = (currency: Currency): string =>
  `${portfolioWhere(currency)}: missing section "## ${currency} — Lots" (see docs/input-format.md)`;
