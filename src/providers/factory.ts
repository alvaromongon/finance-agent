// Market data provider factory.
// To add a new provider: (1) create src/providers/<name>.ts implementing
// IMarketDataProvider, (2) register it here, (3) change the
// MARKET_DATA_PROVIDER env var in GitHub Secrets. Business logic does not change.
import { config } from "../config.js";
import { FixturesProvider } from "./fixtures.js";
import { YahooFinanceProvider } from "./yahoo-finance.js";
import type { IMarketDataProvider } from "./types.js";

const PROVIDERS: Record<string, () => IMarketDataProvider> = {
  "yahoo-finance": () => new YahooFinanceProvider(),
  // Saved bars, no network (demo and tests against examples/brain).
  fixtures: () => new FixturesProvider(config.marketData.fixturesDir()),
};

export function createMarketDataProvider(): IMarketDataProvider {
  const name = config.marketData.provider;
  const factory = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : undefined;
  if (!factory) {
    const available = Object.keys(PROVIDERS).join(", ");
    throw new Error(`Unknown data provider: "${name}". Available: ${available}`);
  }
  return factory();
}

export type { IMarketDataProvider };
