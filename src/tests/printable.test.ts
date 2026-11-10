/** The one escaping of owner-supplied text (S4): `quoted` and `printable`, and the modules that must use them. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { printable, quoted } from "../utils/printable.js";

describe("quoted and printable", () => {
  const wild = 'a\u001b[31m"b\\';

  it("write every control character, quote and backslash as an escape sequence", () => {
    assert.equal(quoted(wild), '"a\\u001b[31m\\"b\\\\"');
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(quoted(wild), /[\u0000-\u001f]/);
  });

  it("leave text without any of them as it is, and printable is quoted without its quotes", () => {
    assert.equal(quoted("SAP.DE"), '"SAP.DE"');
    assert.equal(printable(wild), quoted(wild).slice(1, -1));
  });

  it("is the escaping the portfolio reader uses for the text it quotes: no JSON.stringify of its own", () => {
    const source = readFileSync(new URL("../utils/vault-parser.ts", import.meta.url), "utf8");
    // The one call left is the `schema_version`, which is any YAML value, not owner text.
    assert.equal(source.match(/JSON\.stringify\(/g)?.length, 1);
  });
});
