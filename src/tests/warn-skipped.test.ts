/** The warning of the readers that skip what they cannot read (ADR-0016): one helper, the prefix names the module. */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { skippedWarner } from "../utils/warn-skipped.js";

describe("skippedWarner", () => {
  it("warns on the console with the prefix of the module that logs", () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      skippedWarner("portfolio-store")("row 3 is skipped");
      skippedWarner("vault-io")("entry 2 is skipped");
      assert.deepEqual(
        warn.mock.calls.map((c) => c.arguments[0]),
        ["[portfolio-store] WARNING: row 3 is skipped", "[vault-io] WARNING: entry 2 is skipped"],
      );
    } finally {
      warn.mock.restore();
    }
  });
});
