import { parseTicker, type Ticker } from "../ticker.js";

export const ANALYZE_USAGE = "Usage: npm run analyze -- --ticker <TICKER> [--range 1y|2y]";

/** The `analyze` command line: the ticker parsed (any case, canonical result) and the range. Throws with the reason. */
export function parseAnalyzeArgs(args: readonly string[]): { ticker: Ticker; range: string } {
  const tickerIdx = args.indexOf("--ticker");
  const rangeIdx = args.indexOf("--range");

  if (tickerIdx === -1 || !args[tickerIdx + 1]) throw new Error(ANALYZE_USAGE);

  let ticker: Ticker;
  try {
    ticker = parseTicker(args[tickerIdx + 1]);
  } catch (err) {
    throw new Error(`--ticker: ${(err as Error).message}`, { cause: err });
  }

  return { ticker, range: rangeIdx !== -1 && args[rangeIdx + 1] ? args[rangeIdx + 1] : "1y" };
}
