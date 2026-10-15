import { analyze } from "../claude-analyst.js";
import type { IAnalystProvider, AnalystResult } from "./types.js";
import type { Signal } from "../types.js";

export class ApiAnalystProvider implements IAnalystProvider {
  async escalate(signal: Signal, newsHeadlines: string[]): Promise<AnalystResult> {
    const recommendation = await analyze(signal, newsHeadlines);
    return { status: "resolved", recommendation };
  }
}
