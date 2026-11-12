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

  it("also writes a value that is not text the way JSON does, so a YAML value can be quoted as it is", () => {
    assert.equal(quoted(2), "2");
    assert.equal(quoted({ a: "\u001b" }), '{"a":"\\u001b"}');
    assert.equal(quoted(undefined), "undefined");
  });

  it("is the escaping the readers of owner text use: none has a JSON.stringify of its own", () => {
    for (const file of ["vault-parser", "inbox-parse", "inbox-handlers", "inbox-check", "portfolio-lots"]) {
      const source = readFileSync(new URL(`../utils/${file}.ts`, import.meta.url), "utf8");
      assert.equal(source.match(/JSON\.stringify\(/g)?.length ?? 0, 0, file);
    }
  });
});
