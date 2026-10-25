import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DUST_LIMIT,
  addMoney,
  exactAmount,
  formatMoney,
  money,
  sameCents,
  shareExactAmount,
  shareMoney,
  subtractMoney,
  sumMoney,
  unitsWorthACent,
  unitsWorthHalfACent,
  withinACent,
} from "../money.js";

describe("money", () => {
  it("rounds to whole cents", () => {
    assert.equal(money(1.234), 1.23);
    assert.equal(money(1.236), 1.24);
    assert.equal(money(-1.236), -1.24);
    assert.equal(money(100), 100);
  });

  it("is never negative zero", () => {
    assert.ok(Object.is(money(-0.001), 0));
    assert.equal(JSON.stringify(money(-0.001)), "0");
  });

  it("refuses what is not a finite number", () => {
    assert.throws(() => money(NaN), /finite/);
    assert.throws(() => money(Infinity), /finite/);
    assert.throws(() => money("1" as unknown as number), /finite/);
  });

  it("adds, subtracts and sums without float noise", () => {
    assert.equal(addMoney(money(0.1), money(0.2)), 0.3);
    assert.equal(subtractMoney(money(0.3), money(0.1)), 0.2);
    assert.equal(sumMoney([money(0.1), money(0.2), money(0.3)]), 0.6);
    assert.equal(sumMoney([]), 0);
  });
});

describe("sameCents and withinACent", () => {
  it("compares at the cent", () => {
    assert.ok(sameCents(0.1 + 0.2, 0.3));
    assert.ok(sameCents(10.001, 10));
    assert.ok(!sameCents(10.01, 10));
  });

  it("accepts a difference of one cent and refuses more", () => {
    assert.ok(withinACent(10.01, 10));
    assert.ok(withinACent(10, 10.01));
    assert.ok(!withinACent(10.02, 10));
  });

  it("converts a cent of price into units", () => {
    assert.equal(unitsWorthACent(2), 0.005);
    assert.equal(unitsWorthHalfACent(2), 0.0025);
  });
});

describe("formatMoney", () => {
  it("writes two decimals", () => {
    assert.equal(formatMoney(money(1.5)), "1.50");
    assert.equal(formatMoney(money(-0.004)), "0.00");
    assert.equal(formatMoney(money(1234.567)), "1234.57");
  });
});

describe("shareMoney: whole cents, never negative, adding up exactly", () => {
  it("shares 0.02 over lots of 30/30/30/10 as 0, 0.01, 0.01, 0", () => {
    assert.deepEqual(shareMoney(money(0.02), [30, 30, 30, 10]), [0, 0.01, 0.01, 0]);
  });

  it("gives the leftover cents to the largest remainders, the later one on a tie", () => {
    assert.deepEqual(shareMoney(money(1), [1, 1, 1]), [0.33, 0.33, 0.34]);
    assert.deepEqual(shareMoney(money(100), [10, 5]), [66.67, 33.33]);
  });

  it("a negative total gives shares that are all <= 0 and add up to it", () => {
    assert.deepEqual(shareMoney(money(-100), [10, 5]), [-66.67, -33.33]);
    assert.deepEqual(shareMoney(money(-0.02), [30, 30, 30, 10]), [0, -0.01, -0.01, 0]);
  });

  it("refuses weights that are all 0, and shares nothing over no weights", () => {
    assert.throws(() => shareMoney(money(1), [0, 0]), /weights/);
    assert.deepEqual(shareMoney(money(1), []), []);
  });

  it("property: for random totals and weights every share is whole cents and the shares add up to the total", () => {
    let seed = 20261025;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let run = 0; run < 2000; run++) {
      const total = money((random() - 0.3) * 10 ** Math.floor(random() * 7));
      const weights = Array.from({ length: 1 + Math.floor(random() * 8) }, () =>
        random() < 0.2 ? Math.round(random() * 1e8) / 1e8 + 1e-8 : Math.round(random() * 100000) / 1000 + 0.001,
      );
      const shares = shareMoney(total, weights);
      assert.equal(shares.length, weights.length);
      for (const s of shares) {
        assert.equal(money(s), s, `${s} is not whole cents (${total} over ${JSON.stringify(weights)})`);
        assert.ok(total < 0 ? s <= 0 : s >= 0, `${s} has the wrong sign (${total} over ${JSON.stringify(weights)})`);
      }
      assert.equal(sumMoney(shares), total, `${total} over ${JSON.stringify(weights)}`);
    }
  });
});

describe("the amount of a trade and the dust limit", () => {
  it("is to the cent, unless that rounds to 0, then exact to 8 decimals", () => {
    assert.equal(exactAmount(1.234), 1.23);
    assert.equal(exactAmount(0.003), 0.003);
    assert.equal(exactAmount(0.000000012345), 0.00000001);
  });

  it("is 0 under the dust limit, half of the last decimal", () => {
    assert.equal(DUST_LIMIT, 5e-9);
    assert.equal(exactAmount(4.9e-9), 0);
    assert.equal(exactAmount(5e-9), 1e-8);
  });

  it("shares a sale amount to 8 decimals", () => {
    assert.deepEqual(shareExactAmount(0.00000003, [1, 1, 1, 1]), [0, 1e-8, 1e-8, 1e-8]);
    const shares = shareExactAmount(1000.01, [1, 1, 1]);
    assert.ok(Math.abs(shares[0] - 1000.01 / 3) < 1e-7);
    assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 1000.01) < 1e-9);
  });
});

describe("money() contract", () => {
  it("throws when the cents overflow, not only on a non-finite input", () => {
    assert.throws(() => money(1.8e307), RangeError);
    assert.throws(() => money(Infinity), RangeError);
  });
});
