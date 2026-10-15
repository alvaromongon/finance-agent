/**
 * Separate file because config.ts sets config.analyst.provider on the first
 * import of config.js in the process — the node:test runner isolates each file
 * in its own process, so ANALYST_PROVIDER can be set here without interfering
 * with analyst-factory.test.ts (same pattern as integration.test.ts).
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

describe("createAnalystProvider — unknown provider", () => {
  let createAnalystProvider: () => unknown;

  before(async () => {
    // "constructor" exists on Object.prototype: regression of the Object.hasOwn
    // guard in factory.ts (without it, PROVIDERS["constructor"] resolves to
    // Object's constructor instead of throwing the expected error).
    process.env.ANALYST_PROVIDER = "constructor";
    const factory = await import("../analyst/factory.js");
    createAnalystProvider = factory.createAnalystProvider;
  });

  it("throws instead of resolving through Object.prototype", () => {
    assert.throws(() => createAnalystProvider(), /Unknown analyst provider: "constructor"/);
  });
});
