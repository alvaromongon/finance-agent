/**
 * Separate file because config.ts sets config.analyst.provider on the first
 * import of config.js in the process — same pattern as
 * analyst-factory-unknown-provider.test.ts so as not to interfere with
 * analyst-factory.test.ts (which checks the default without ANALYST_PROVIDER).
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

describe("createAnalystProvider — ANALYST_PROVIDER=handoff", () => {
  let createAnalystProvider: () => unknown;
  let HandoffAnalystProvider: new () => unknown;

  before(async () => {
    process.env.ANALYST_PROVIDER = "handoff";
    const factory = await import("../analyst/factory.js");
    const handoff = await import("../analyst/handoff-provider.js");
    createAnalystProvider = factory.createAnalystProvider;
    HandoffAnalystProvider = handoff.HandoffAnalystProvider;
  });

  it("instantiates HandoffAnalystProvider", () => {
    const provider = createAnalystProvider();
    assert.ok(provider instanceof HandoffAnalystProvider);
    assert.equal(typeof (provider as { escalate: unknown }).escalate, "function");
  });
});
