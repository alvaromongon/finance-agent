// The ticker, a domain value (ADR-0016): made only by parsing, so two tickers are equal exactly
// when `===` says so.

declare const tickerBrand: unique symbol;

/**
 * A ticker in its canonical form: trimmed, inside the ticker pattern and upper case. A branded
 * string, so it survives JSON; `parseTicker` is the only way to make one.
 */
export type Ticker = string & { readonly [tickerBrand]: "Ticker" };

/** Letters, digits and `. - ^ =` (`BRK-B`, `EXSA.DE`, `^GSPC`, `EURUSD=X`), with at least one letter or digit. */
export const TICKER_PATTERN = /^(?=.*[A-Za-z0-9])[A-Za-z0-9.\-^=]+$/;

/** The reason a value is not a ticker, or `undefined` if it is one (before trimming and upper-casing). */
function problemWith(raw: unknown): string | undefined {
  if (typeof raw !== "string") return `a ticker must be a string; got: ${JSON.stringify(raw)}`;
  const trimmed = raw.trim();
  if (trimmed === "") return "a ticker must not be empty";
  if (!TICKER_PATTERN.test(trimmed)) {
    return `a ticker has letters, digits and . - ^ = only, with at least one letter or digit; got: ${JSON.stringify(raw)}`;
  }
  return undefined;
}

/** The only way to make a `Ticker`: trims, checks the pattern and upper-cases. Throws with a clear message. */
export function parseTicker(raw: unknown): Ticker {
  const problem = problemWith(raw);
  if (problem !== undefined) throw new Error(problem);
  return (raw as string).trim().toUpperCase() as Ticker;
}

/** `parseTicker` for a boundary that collects problems instead of throwing: the ticker, or why not. */
export function checkTicker(raw: unknown): { ticker: Ticker } | { problem: string } {
  const problem = problemWith(raw);
  return problem === undefined ? { ticker: parseTicker(raw) } : { problem };
}

/** True if a raw value (a cell, a YAML field) names the ticker, whatever the case it was written in. */
export function namesTicker(raw: unknown, ticker: Ticker): boolean {
  const checked = checkTicker(raw);
  return "ticker" in checked && checked.ticker === ticker;
}

/** The ticker as a file-name stem, the way the engine names logs and pending files: lower case, dots kept. */
export function tickerFileStem(ticker: Ticker): string {
  return ticker.toLowerCase();
}

/** The ticker as a thesis-note slug (`tesis-<slug>.md`): lower case, without dots. */
export function tickerSlug(ticker: Ticker): string {
  return ticker.toLowerCase().replace(/\./g, "");
}

/** The ticker (or any subject) inside a decision id: lower case, letters and digits only. */
export function tickerIdPart(subject: string): string {
  return subject.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
