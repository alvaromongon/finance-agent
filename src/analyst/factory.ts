// Analysis provider factory. Same pattern as src/providers/factory.ts.
// To add a new backend: (1) create src/analyst/<name>.ts implementing
// IAnalystProvider, (2) register it here, (3) change the ANALYST_PROVIDER env
// var in GitHub Secrets/Vars. Business logic does not change.
import { config } from "../config.js";
import { ApiAnalystProvider } from "./api-provider.js";
import { HandoffAnalystProvider } from "./handoff-provider.js";
import type { IAnalystProvider } from "./types.js";

const PROVIDERS: Record<string, () => IAnalystProvider> = {
  api: () => new ApiAnalystProvider(),
  handoff: () => new HandoffAnalystProvider(),
};

export function createAnalystProvider(): IAnalystProvider {
  const name = config.analyst.provider;
  const factory = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : undefined;
  if (!factory) {
    const available = Object.keys(PROVIDERS).join(", ");
    throw new Error(`Unknown analyst provider: "${name}". Available: ${available}`);
  }
  return factory();
}

export type { IAnalystProvider };
