import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdownMoney, parseMarkdownNumber } from "../utils/parse.js";

describe("parseMarkdownNumber", () => {
  it("simple number with a decimal point", () => {
    assert.equal(parseMarkdownNumber("46.8"), 46.8);
  });
  it("simple European decimal comma", () => {
    assert.equal(parseMarkdownNumber("46,80"), 46.8);
  });
  it("European format with thousands: 1.234,56", () => {
    assert.equal(parseMarkdownNumber("1.234,56"), 1234.56);
  });
  it("US format with thousands: 2,500.00", () => {
    assert.equal(parseMarkdownNumber("2,500.00"), 2500.0);
  });
  it("euro symbol with a space: '3,24 €'", () => {
    assert.equal(parseMarkdownNumber("3,24 €"), 3.24);
  });
  it("dollar symbol: '$136.90'", () => {
    assert.equal(parseMarkdownNumber("$136.90"), 136.9);
  });
  it("placeholder —", () => {
    assert.equal(parseMarkdownNumber("—"), null);
  });
  it("placeholder -", () => {
    assert.equal(parseMarkdownNumber("-"), null);
  });
  it("TBD", () => {
    assert.equal(parseMarkdownNumber("TBD"), null);
  });
  it("lowercase tbd", () => {
    assert.equal(parseMarkdownNumber("tbd"), null);
  });
  it("N/A", () => {
    assert.equal(parseMarkdownNumber("N/A"), null);
  });
  it("empty string", () => {
    assert.equal(parseMarkdownNumber(""), null);
  });
  it("undefined", () => {
    assert.equal(parseMarkdownNumber(undefined), null);
  });
  it("text without a number", () => {
    assert.equal(parseMarkdownNumber("hello"), null);
  });
  it("currency symbol only", () => {
    assert.equal(parseMarkdownNumber("€"), null);
  });
  it("simple integer", () => {
    assert.equal(parseMarkdownNumber("1000"), 1000);
  });
  it("zero", () => {
    assert.equal(parseMarkdownNumber("0"), 0);
  });
  it("negative number", () => {
    assert.equal(parseMarkdownNumber("-12.50"), -12.5);
  });
  it("negative European P/L", () => {
    assert.equal(parseMarkdownNumber("-1.234,56 €"), -1234.56);
  });
});

describe("parseMarkdownMoney", () => {
  it("rounds a readable amount to the cent", () => {
    assert.equal(parseMarkdownMoney("$1,234.567"), 1234.57);
  });
  it("is null for a cell that is not a number, as parseMarkdownNumber is", () => {
    assert.equal(parseMarkdownMoney("TBD"), null);
    assert.equal(parseMarkdownMoney("—"), null);
  });
  it("is null, never a throw, for a number that cannot be counted in cents (#83)", () => {
    for (const cell of ["1e307", "-1e307", "1e308", "-1.8e306"]) {
      assert.equal(parseMarkdownMoney(cell), null, cell);
    }
  });
  it("still reads the largest amount that can be counted in cents", () => {
    assert.equal(parseMarkdownMoney("1e300"), 1e300);
  });
});
