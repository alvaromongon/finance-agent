/**
 * The sharing of money (`shareMoney`, `shareExactAmount`) must give what `allocateByWeight` gave before
 * #79, on the exact float weights (the units sold from each lot), not on weights rounded to 8 decimals.
 * `oracle` is that function copied from `main` (faf482b).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { money, shareExactAmount, shareMoney } from "../money.js";

function oracle(total: number, weights: readonly number[], decimals: number): number[] {
  const unit = 10 ** decimals;
  const sign = total < 0 ? -1 : 1;
  const cents = Math.round(Math.abs(total) * unit);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (cents * w) / weightSum);
  const shares = exact.map(Math.floor);
  const byRemainder = exact
    .map((x, i) => ({ i, remainder: x - shares[i] }))
    .sort((a, b) => b.remainder - a.remainder || b.i - a.i);
  let left = cents - shares.reduce((a, b) => a + b, 0);
  for (let k = 0; left !== 0 && k < 2 * byRemainder.length; k++) {
    const { i } =
      left > 0 ? byRemainder[k % byRemainder.length] : byRemainder[byRemainder.length - 1 - (k % byRemainder.length)];
    if (left > 0) {
      shares[i]++;
      left--;
    } else if (shares[i] > 0) {
      shares[i]--;
      left++;
    }
  }
  return shares.map((n) => (n === 0 ? 0 : (sign * n) / unit));
}

// A deterministic generator, so a failure is reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("sharing equals main's allocateByWeight on weights with more than 8 decimals", () => {
  it("the reproduction: lots of 1.5 and 2 units, 300 sold at 97.13", () => {
    const weights = [1.5, 300 / 97.13 - 1.5];
    assert.deepEqual(shareExactAmount(300, weights), oracle(300, weights, 8));
    assert.deepEqual(shareExactAmount(300, weights), [145.695, 154.305]);
  });

  it("the reproduction: small crypto-like weights over 5000", () => {
    const weights = [0.00012345678912, 0.00098765432198];
    assert.deepEqual(shareExactAmount(5000, weights), oracle(5000, weights, 8));
    assert.equal(shareExactAmount(5000, weights)[0], 555.55555105);
  });

  it("many random cases, in exact amounts and in cents", () => {
    const next = rng(79);
    const cases = 20000;
    for (let c = 0; c < cases; c++) {
      const n = 1 + Math.floor(next() * 4);
      const scale = 10 ** (-5 + Math.floor(next() * 8));
      const weights = Array.from({ length: n }, () => next() * scale + 1e-12);
      const total = Math.round(next() * 1e7) / 100;
      const sign = next() < 0.1 ? -1 : 1;
      const exact = shareExactAmount(sign * total, weights);
      const expected = oracle(sign * total, weights, 8);
      if (total < 1000) {
        assert.deepEqual(exact, expected, `exact ${c}`);
      } else {
        // Over 1e11 units the float quotients of main carry noise of their own in the last unit: the
        // order of near-equal remainders may differ, by one unit of 1e-8 at most, with the same total.
        exact.forEach((x, i) => assert.ok(Math.abs(x - expected[i]) < 1.5e-8, `exact ${c}: ${x} vs ${expected[i]}`));
        assert.ok(Math.abs(exact.reduce((a, b) => a + b, 0) - Math.abs(sign * total) * sign) < 1e-6, `sum ${c}`);
      }
      assert.deepEqual(
        shareMoney(money(sign * total), weights),
        oracle(sign * total, weights, 2),
        `cents ${c}: ${JSON.stringify({ total, weights })}`,
      );
    }
  });
});
