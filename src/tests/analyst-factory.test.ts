import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAnalystProvider } from "../analyst/factory.js";
import { ApiAnalystProvider } from "../analyst/api-provider.js";
import type { AnalystResult } from "../analyst/types.js";

describe("createAnalystProvider", () => {
  it("without ANALYST_PROVIDER defined returns ApiAnalystProvider (default)", () => {
    const provider = createAnalystProvider();
    assert.ok(provider instanceof ApiAnalystProvider);
    assert.equal(typeof provider.escalate, "function");
  });
});

// Pins the shape index.ts expects from the "deferred" variant (registered
// as a real backend in analyst-factory-handoff.test.ts).
describe("AnalystResult — deferred variant", () => {
  it("a provider that defers the escalation exposes pendingPath", async () => {
    const fakeProvider = {
      async escalate(): Promise<AnalystResult> {
        return { status: "deferred", pendingPath: "logs/pending/XOM.md" };
      },
    };
    const result = await fakeProvider.escalate();
    assert.equal(result.status, "deferred");
    assert.equal(result.status === "deferred" && result.pendingPath, "logs/pending/XOM.md");
  });
});
