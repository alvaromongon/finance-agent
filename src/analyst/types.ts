import type { Recommendation, Signal } from "../types.js";

export type AnalystResult =
  { status: "resolved"; recommendation: Recommendation } | { status: "deferred"; pendingPath: string };

export interface IAnalystProvider {
  escalate(signal: Signal, newsHeadlines: string[]): Promise<AnalystResult>;
}
