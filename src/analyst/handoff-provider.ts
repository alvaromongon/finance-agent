import { config } from "../config.js";
import { loadSystemPrompt, buildUserPrompt, shouldUseWebSearch } from "../claude-analyst.js";
import { writePendingSignal } from "../vault-io.js";
import type { IAnalystProvider, AnalystResult } from "./types.js";
import type { Signal } from "../types.js";

export class HandoffAnalystProvider implements IAnalystProvider {
  async escalate(signal: Signal, newsHeadlines: string[]): Promise<AnalystResult> {
    const systemPrompt = await loadSystemPrompt();
    const userPrompt = buildUserPrompt(signal, newsHeadlines);
    const useWebSearch = shouldUseWebSearch(signal.triggers, config.claude.analystWebSearch);

    const pendingPath = await writePendingSignal(signal, { systemPrompt, userPrompt, useWebSearch });
    return { status: "deferred", pendingPath };
  }
}
