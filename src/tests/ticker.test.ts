import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTicker, parseTicker, tickerFileStem, tickerIdPart, tickerSlug } from "../ticker.js";

describe("parseTicker", () => {
  for (const bad of ["TC|K", "TC\nK", "\n", "TCK ; rm", "-", "^.-", "", "   ", "T CK"]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseTicker(bad), /ticker/);
    });
  }

  for (const bad of ["A..B", "..A", ".A", "A...B", " .a "]) {
    it(`refuses ${JSON.stringify(bad)}: two dots in a row or a leading dot`, () => {
      assert.throws(() => parseTicker(bad), /two dots in a row|start with a dot/);
    });
  }

  it("refuses what is not a string", () => {
    assert.throws(() => parseTicker(undefined), /must be a string/);
    assert.throws(() => parseTicker(42), /must be a string/);
  });

  it("trims and upper-cases", () => {
    assert.equal(parseTicker(" tck "), "TCK");
    assert.equal(parseTicker("brk-b"), "BRK-B");
  });

  for (const good of ["BRK.B", "EXSA.DE", "^GSPC", "BTC-USD", "EURUSD=X", "4GLD.DE"]) {
    it(`accepts ${good} unchanged`, () => {
      assert.equal(parseTicker(good), good);
    });
  }

  it("makes tickers that differ in case equal with ===", () => {
    assert.ok(parseTicker("tck") === parseTicker("TCK"));
  });
});

describe("checkTicker", () => {
  it("returns the ticker or the problem", () => {
    assert.deepEqual(checkTicker("tck"), { ticker: "TCK" });
    assert.match((checkTicker("T|K") as { problem: string }).problem, /letters, digits/);
    assert.match((checkTicker("A..B") as { problem: string }).problem, /two dots in a row/);
    assert.match((checkTicker(".A") as { problem: string }).problem, /start with a dot/);
  });
});

describe("file names and slugs", () => {
  it("keeps today's names, with and without dots", () => {
    assert.equal(tickerFileStem(parseTicker("TCK")), "tck");
    assert.equal(tickerFileStem(parseTicker("EXSA.DE")), "exsa.de");
    assert.equal(tickerFileStem(parseTicker("^GSPC")), "^gspc");
    assert.equal(tickerSlug(parseTicker("EXSA.DE")), "exsade");
    assert.equal(tickerSlug(parseTicker("BRK-B")), "brk-b");
    assert.equal(tickerIdPart("EXSA.DE"), "exsade");
    assert.equal(tickerIdPart("BRK-B"), "brkb");
  });
});
