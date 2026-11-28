import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CURRENCIES, type AnySilo, type Currency, type PortfolioSnapshot } from "../types.js";
import type { Decision } from "../decisions.js";
import {
  DUST_LIMIT,
  addCounted,
  asNumber,
  maxMoney,
  minMoney,
  countedInCents,
  exactAmount,
  formatMoney,
  isCountedRefusal,
  money,
  shareExactAmount,
  shareMoney,
  subtractCounted,
  sumCounted,
  zero,
  type Money,
  unitsWorthACent,
  unitsWorthHalfACent,
  withinACent,
} from "../money.js";

describe("money", () => {
  it("rounds to whole cents", () => {
    assert.equal(money(1.234, "EUR"), 1.23);
    assert.equal(money(1.236, "EUR"), 1.24);
    assert.equal(money(-1.236, "EUR"), -1.24);
    assert.equal(money(100, "EUR"), 100);
  });

  it("is never negative zero", () => {
    assert.ok(Object.is(money(-0.001, "EUR"), 0));
    assert.equal(JSON.stringify(money(-0.001, "EUR")), "0");
  });

  it("refuses what is not a finite number", () => {
    assert.throws(() => money(NaN, "EUR"), /finite/);
    assert.throws(() => money(Infinity, "EUR"), /finite/);
    assert.throws(() => money("1" as unknown as number, "EUR"), /finite/);
  });

  it("adds, subtracts and sums without float noise", () => {
    assert.equal(addCounted(money(0.1, "EUR"), money(0.2, "EUR"), "x"), 0.3);
    assert.equal(subtractCounted(money(0.3, "EUR"), money(0.1, "EUR"), "x"), 0.2);
    assert.equal(sumCounted([money(0.1, "EUR"), money(0.2, "EUR"), money(0.3, "EUR")], "x", "EUR"), 0.6);
    assert.equal(sumCounted([], "x", "EUR"), 0);
  });

  it("compares two Money with ===, the same cent being the same number", () => {
    assert.ok(money(0.1 + 0.2, "EUR") === money(0.3, "EUR"));
    assert.ok(money(10.001, "EUR") === money(10, "EUR"));
    assert.ok(money(10.01, "EUR") !== money(10, "EUR"));
  });
});

describe("money carries its currency (#130, ADR-0017)", () => {
  it("is made in a currency, and refuses to be made without one", () => {
    assert.equal(money(1.234, "USD"), 1.23);
    assert.throws(() => money(1, undefined as unknown as Currency), /needs a currency/);
    assert.throws(() => money(1, "GBP" as unknown as Currency), /needs a currency/);
  });

  it("keeps the currency through the checked helpers: one currency in, the same one out", () => {
    const sum: Money<"USD"> = addCounted(money(0.1, "USD"), money(0.2, "USD"), "x");
    const difference: Money<"USD"> = subtractCounted(sum, money(0.1, "USD"), "x");
    const total: Money<"USD"> = sumCounted([sum, difference], "x", "USD");
    const shares: Money<"USD">[] = shareMoney(total, [1, 1]);
    assert.deepEqual([sum, difference, total, shares], [0.3, 0.2, 0.5, [0.25, 0.25]]);
  });

  // The currency is only in the type: these lines are checked by `npm run typecheck`, and `@ts-expect-error`
  // itself fails it if the line ever compiles.
  it("does not compile an amount in one currency added to, subtracted from, summed with or compared to another", () => {
    const eur = money(10, "EUR");
    const usd = money(10, "USD");
    // @ts-expect-error EUR and USD amounts cannot be added
    addCounted(eur, usd, "x");
    // @ts-expect-error EUR and USD amounts cannot be subtracted
    subtractCounted(usd, eur, "x");
    // @ts-expect-error a sum of EUR amounts is not a USD amount
    sumCounted([eur], "x", "USD");
    // @ts-expect-error EUR and USD amounts cannot be compared
    const same = eur === usd;
    assert.equal(same, true, "the brand is erased at run time: only the type tells them apart");
    // @ts-expect-error a USD amount is not a EUR amount
    const asEur: Money<"EUR"> = usd;
    assert.equal(asEur, 10);
  });

  it("is an amount of a currency known only at run time when the currency is a Currency", () => {
    const silo: Currency = "EUR";
    const amount: Money = money(5, silo);
    const eur: Money<"EUR"> = money(5, "EUR");
    assert.equal(addCounted(amount, eur, "x"), 10);
  });
});

describe("an amount is not a number to the compiler (#145)", () => {
  const silo = <C extends Currency>(currency: C, cash: number): PortfolioSnapshot<C> => ({
    currency,
    cash: money(cash, currency),
    positions: [],
    lots: [],
    syncedAt: "2026-11-28T00:00:00.000Z",
  });

  // Checked by `npm run typecheck`: `@ts-expect-error` fails it if the line ever compiles. At run time an amount is a
  // number, so every line below runs and gives the number it would give; only the compiler tells the currencies apart.
  it("does not compile + or - on amounts, in the same currency or in two", () => {
    /* eslint-disable @typescript-eslint/restrict-plus-operands -- the lines are the ones that must not compile */
    const eur = money(10, "EUR");
    const usd = money(5, "USD");
    // @ts-expect-error a sum with + is a plain number that has lost the currency: addCounted keeps it
    const plain = eur + eur;
    // @ts-expect-error EUR and USD amounts cannot be added with +
    const mixed = eur + usd;
    // @ts-expect-error EUR and USD amounts cannot be subtracted with -
    const difference = usd - eur;
    assert.deepEqual([plain, mixed, difference], [20, 15, -5]);
    /* eslint-enable @typescript-eslint/restrict-plus-operands */
  });

  it("does not compile an amount where a plain number is wanted, or Math.max and Math.min on amounts", () => {
    const eur = money(10, "EUR");
    // @ts-expect-error Math.max takes numbers: maxMoney takes two amounts of one currency
    const larger = Math.max(eur, money(3, "EUR"));
    // @ts-expect-error Math.min takes numbers: minMoney takes two amounts of one currency
    const smaller = Math.min(eur, money(3, "EUR"));
    // @ts-expect-error an amount is not a number: asNumber is the way out, in the open
    const plain: number = eur;
    // @ts-expect-error arithmetic on an amount and a number needs the number out of the amount first
    const doubled = eur * 2;
    assert.deepEqual([larger, smaller, plain, doubled], [10, 3, 10, 20]);
  });

  it("does not compile two currencies compared with <, <=, > or >=, and compares one currency", () => {
    const eur = money(10, "EUR");
    const usd = money(5, "USD");
    // @ts-expect-error EUR and USD amounts cannot be ordered
    const mixed = eur > usd;
    assert.equal(mixed, true);
    assert.ok(
      money(3, "EUR") < eur && eur >= money(10, "EUR"),
      "two amounts of one currency compare with the operators",
    );
  });

  it("takes the larger and the smaller of two amounts of one currency, and refuses two currencies", () => {
    const small = money(3, "USD");
    const large = money(10, "USD");
    assert.equal(maxMoney(small, large), 10);
    assert.equal(minMoney(large, small), 3);
    assert.equal(minMoney(zero("USD"), small), 0);
    // @ts-expect-error EUR and USD amounts have no larger
    maxMoney(small, money(1, "EUR"));
    // @ts-expect-error EUR and USD amounts have no smaller
    minMoney(money(1, "EUR"), small);
  });

  it("is a number at run time: it round-trips JSON and asNumber is the identity", () => {
    const amount = money(12.34, "EUR");
    assert.equal(JSON.stringify({ amount }), '{"amount":12.34}');
    assert.equal(asNumber(amount), 12.34);
    assert.equal(asNumber(7), 7);
  });

  it("keeps the two silos apart in a loop over both: an amount of one is not added to a total of the other", () => {
    const silos: AnySilo[] = [silo("EUR", 100), silo("USD", 40)];
    let eurTotal = zero("EUR");
    let usdTotal = zero("USD");
    for (const s of silos) {
      if (s.currency === "EUR") eurTotal = addCounted(eurTotal, s.cash, "the EUR total");
      else usdTotal = addCounted(usdTotal, s.cash, "the USD total");
    }
    assert.deepEqual([eurTotal, usdTotal], [100, 40]);

    // Never called: these are the mixes the compiler must refuse.
    const mixes = (s: AnySilo): void => {
      // @ts-expect-error the silo of this turn may be the USD one: its cash is not a EUR amount
      eurTotal = addCounted(eurTotal, s.cash, "the EUR total");
      // @ts-expect-error the cash of a EUR silo is not a USD amount, wherever the silo came from
      if (s.currency === "EUR") usdTotal = addCounted(usdTotal, s.cash, "the USD total");
    };
    assert.equal(typeof mixes, "function");
  });

  it("walks the silos of a store by currency with each silo's own type", () => {
    const store: { readonly [C in Currency]?: PortfolioSnapshot<C> } = { EUR: silo("EUR", 100), USD: silo("USD", 40) };
    const cashes = CURRENCIES.flatMap((c) => store[c]?.cash ?? []);
    // @ts-expect-error the cash of one silo or the other is not an amount of the EUR silo
    const eurCashes: Money<"EUR">[] = cashes;
    assert.deepEqual(eurCashes, [100, 40]);
    // @ts-expect-error the EUR silo's cash is not a USD amount
    const usdCash: Money<"USD"> | undefined = store.EUR?.cash;
    assert.equal(usdCash, 100);
  });

  it("makes a decision's money the amount of its silo's currency", () => {
    const exit = { currency: "USD", costs: money(1, "USD") } as Decision<"USD">;
    const cost: Money<"USD"> | undefined = exit.costs;
    // @ts-expect-error the costs of a USD decision are not a EUR amount
    const euros: Money<"EUR"> | undefined = exit.costs;
    assert.deepEqual([cost, euros], [1, 1]);
  });
});

describe("countedInCents and the counted sums (#87)", () => {
  it("is money(n) for a value that counts in cents", () => {
    assert.equal(countedInCents(1.234, "the thing", "EUR"), 1.23);
  });

  it("refuses a value too large to count in cents with an Error naming it, not a RangeError", () => {
    for (const n of [5e306, Infinity, -Infinity]) {
      assert.throws(
        () => countedInCents(n, "the thing", "EUR"),
        (err: Error) => {
          assert.equal(err.constructor, Error);
          assert.match(err.message, /^the thing is too large to count in cents; got: [^(]*$/);
          assert.doesNotMatch(err.message, /nothing was recorded/);
          assert.ok(isCountedRefusal(err));
          return true;
        },
      );
    }
  });

  it("calls NaN not a number, not too large", () => {
    assert.throws(
      () => countedInCents(NaN, "the thing", "EUR"),
      (err: Error) => {
        assert.equal(err.constructor, Error);
        assert.match(err.message, /the thing is not a number; got: NaN/);
        assert.doesNotMatch(err.message, /too large/);
        return true;
      },
    );
  });

  it("adds, subtracts and sums like the plain helpers when the result counts", () => {
    assert.equal(addCounted(money(0.1, "EUR"), money(0.2, "EUR"), "x"), 0.3);
    assert.equal(subtractCounted(money(0.3, "EUR"), money(0.1, "EUR"), "x"), 0.2);
    assert.equal(sumCounted([money(0.1, "EUR"), money(0.2, "EUR"), money(0.3, "EUR")], "x", "EUR"), 0.6);
  });

  it("refuses a total too large to count with the named message", () => {
    const big = money(1e306, "EUR");
    const refusal = (err: Error) =>
      err.constructor === Error && err.message.startsWith("x is too large to count in cents");
    assert.throws(() => addCounted(big, money(1e306, "EUR"), "x"), refusal);
    assert.throws(() => subtractCounted(big, money(-1e306, "EUR"), "x"), refusal);
    assert.throws(() => sumCounted([big, big], "x", "EUR"), refusal);
  });
});

describe("withinACent", () => {
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
    assert.equal(formatMoney(money(1.5, "EUR")), "1.50");
    assert.equal(formatMoney(money(-0.004, "EUR")), "0.00");
    assert.equal(formatMoney(money(1234.567, "EUR")), "1234.57");
  });
});

describe("shareMoney: whole cents, never negative, adding up exactly", () => {
  it("shares 0.02 over lots of 30/30/30/10 as 0, 0.01, 0.01, 0", () => {
    assert.deepEqual(shareMoney(money(0.02, "EUR"), [30, 30, 30, 10]), [0, 0.01, 0.01, 0]);
  });

  it("gives the leftover cents to the largest remainders, the later one on a tie", () => {
    assert.deepEqual(shareMoney(money(1, "EUR"), [1, 1, 1]), [0.33, 0.33, 0.34]);
    assert.deepEqual(shareMoney(money(100, "EUR"), [10, 5]), [66.67, 33.33]);
  });

  it("a negative total gives shares that are all <= 0 and add up to it", () => {
    assert.deepEqual(shareMoney(money(-100, "EUR"), [10, 5]), [-66.67, -33.33]);
    assert.deepEqual(shareMoney(money(-0.02, "EUR"), [30, 30, 30, 10]), [0, -0.01, -0.01, 0]);
  });

  it("refuses weights that are all 0, and shares nothing over no weights", () => {
    assert.throws(() => shareMoney(money(1, "EUR"), [0, 0]), /weights/);
    assert.deepEqual(shareMoney(money(1, "EUR"), []), []);
  });

  it("property: for random totals and weights every share is whole cents and the shares add up to the total", () => {
    let seed = 20261025;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let run = 0; run < 2000; run++) {
      const total = money((random() - 0.3) * 10 ** Math.floor(random() * 7), "EUR");
      const weights = Array.from({ length: 1 + Math.floor(random() * 8) }, () =>
        random() < 0.2 ? Math.round(random() * 1e8) / 1e8 + 1e-8 : Math.round(random() * 100000) / 1000 + 0.001,
      );
      const shares = shareMoney(total, weights);
      assert.equal(shares.length, weights.length);
      const where = `${asNumber(total)} over ${JSON.stringify(weights)}`;
      for (const s of shares) {
        assert.equal(money(asNumber(s), "EUR"), s, `${asNumber(s)} is not whole cents (${where})`);
        assert.ok(
          total < zero("EUR") ? s <= zero("EUR") : s >= zero("EUR"),
          `${asNumber(s)} has the wrong sign (${where})`,
        );
      }
      assert.equal(sumCounted(shares, "x", "EUR"), total, where);
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
    assert.throws(() => money(1.8e307, "EUR"), RangeError);
    assert.throws(() => money(Infinity, "EUR"), RangeError);
  });
});
