---
status: Proposed
date: 2026-10-25
decision-makers: Repository owner
---

# 0017. Money is a domain value in whole cents: one constructor, one way to share and format

**Decision**: an amount of the silo currency (cash, cost, result of a sale, the amount of a buy) is a branded number, `Money`, made only by `money()`, which rounds to whole cents; two amounts are compared with `===` (each is whole cents), a total is shared over weights by one function (the largest-remainder method) and an amount is written with two decimals by one function. We expect the defect where two parts of the engine disagree by a float-noise cent, or write their own tolerance, to be impossible by construction. Prices, exchange rates, units and percentages are not money and stay plain numbers.

## Context and problem statement

Counted on 2026-10-25 over the sources without tests (measured): 35 `toFixed(2)` calls in 15 files, with a money formatter used in 1 file; a cent tolerance written inline in 5 places (`0.005`, `0.01 + 1e-9`, `0.01 / price`, `CASH_EPSILON = 0.01`); and a sharing function that needed a loop to take back a cent left over by float noise. A review of the dust limit found the documented limit (`1e-8`) and the code (an amount that rounds to 0 at 8 decimals, that is under `5e-9`) disagreeing.

**Why it matters**: the owner trades real money on this output. A cent of drift between the Lots, the decision log and the evaluation makes the consistency checks refuse the file, which blocks recording and measuring.

## Decision drivers

- Almost no output changes: the numbers in `portfolio.md` and the decision log and the text of every report stay the same, except the changes listed in _Consequences_ (money given with sub-cent decimals is read to the cent; the sub-cent shares of a large sale may differ by `1e-8`).
- The value survives JSON, so a class is out.
- The compiler finds an amount that was not rounded.
- Position sizing and stop prices are trading rules and are not touched.

## Considered options

- **Branded number made only by `money()`**, with checked helpers for sums and differences (`addCounted`, `subtractCounted`, `sumCounted`), `shareMoney` and `formatMoney`; two `Money` values are compared with `===`.
- **Integer cents** stored and passed everywhere: exact, but changes every serialized format and every reader.
- **A helper module over plain numbers**: no type, so nothing stops a place from forgetting it.
- **Do nothing**.

## Decision outcome

Chosen option: "branded number made only by `money()`", because it is the only one that keeps every serialized number as it is and still makes the compiler reject an unrounded amount.

- `money(n)` rounds to whole cents (never negative zero) and throws on a value that is not finite or too large to count in cents. Cash, `Position.pl`, a lot's entry costs, a decision's `costs`, `pnl` and `entry_costs` carry `Money`; readers of `portfolio.md` make it from the cell. Sums and differences go through the checked helpers (`addCounted`, `subtractCounted`, `sumCounted`), which refuse with a message an amount too large to count in cents, so there is no float noise to clear.
- Two `Money` values are compared with `===`: each is a whole number of cents, so the same cent is the same number. `withinACent`, `overByMoreThanACent` and `isMoreThanACent` are the tolerances the engine states (an amount against `units x price`; a buy or a sale against its cash or position, compared exactly; a balance worth more than a cent). The units a cent or half a cent of price is worth come from `unitsWorthACent` and `unitsWorthHalfACent`.
- `shareMoney` shares a total over weights in whole cents by the largest-remainder method, in integers over the exact value of each weight (not rounded), so the shares are whole cents, none is negative and they add up to the total exactly, with no correction loop.
- Money is shared and formatted in one place for reports and emails: amounts are written with two decimals. A few locale formatters for prices, stops and profit and loss still exist beside it (they write the owner's `portfolio.md` cells and the numbers of some emails and charts); they format a value, they do not make or compare money.
- The amount of an exit is the exception: it is its exact share of the sale amount and keeps 8 decimals (`shareExactAmount`, `exactAmount`), so a lot of a few units of a low-priced asset does not get 0.00. The dust limit is one rule (`DUST_LIMIT`, tested by `isDust`, which `exactAmount` uses): an amount that rounds to 0 at 8 decimals, under `5e-9` of the silo currency, is 0 and cannot be recorded or sold. Sharing these exact amounts is exact up to about 90 million of the silo currency; beyond that the total itself is no longer exact. The input format states the same value as the code.
- The tickets of the sizing (`src/utils/sizing.ts`) keep plain numbers: sizing and stops are trading rules and out of this decision.

**What we give up**: every place that builds a snapshot from untyped data calls `money()`, and tests build amounts through it; a cast defeats the brand. The simple option (a helper module over plain numbers) is not enough because it leaves each place to remember it, which is how the inline tolerances arose. Integer cents would be exact but changes every format.

**Sequence**: after the ticker ([ADR-0016](0016-domain-values-are-branded-types-made-by-parsing.md)), which set the pattern. It departs from ADR-0016, which expected money to cover amounts, prices and units: this decision covers amounts only, because prices, exchange rates and units are not worth whole cents and a type for them is not clearly worth it today.

**Scope**: the engine and its tests; the input format restates the dust limit.

**Confidence**: medium-high. We would revisit if a second currency has to be added in one expression (a type per currency would be needed).

### Consequences

- Changed numbers (all on sub-cent input, none on data written in cents): a `costs`, `pnl` or `entry_costs` with more than two decimals, given to `decision:record` or read from a log line, is rounded to the cent (`costs: 1.234` is recorded as `1.23`, where it was `1.234`); for an `fx_conversion` the `fx_rate` computed from `received` follows it (`118 / (100 - 1.23)` instead of `118 / (100 - 1.234)`: 1.194695 instead of 1.194743). A `Cash`, `P/L` or `Entry costs` cell of `portfolio.md` with more than two decimals is read to the cent. The `Entry costs` of two lots differing by half a cent with float noise now compare equal. The exact sub-cent shares of a sale share the exact weights (the units sold), as before, but without float noise: on random cases (measured, 100000, totals up to 100000) 11 differed from the old function, all with a total over 1000 and by one unit of `1e-8` in two shares that the old float arithmetic ordered by noise; the cent shares did not differ in any case.
- Unchanged on purpose: the cap of a SELL against its position and of a BUY against its cash (`validateTicket` in `src/risk.ts`) and the cash thresholds of the silo performance keep their exact one-cent tolerance, unrounded, because they are ticket and measurement rules (`overByMoreThanACent`, `isMoreThanACent`).
- Good: the inline cent tolerances and the money `toFixed(2)` calls outside the sizing are gone; the sharing needs no correction loop.
- Bad: the tickets of the sizing still format with `toFixed(2)` until a decision opens them.
- Bad: a brand is erased at run time.

### Confirmation

Unit tests of `money.ts` including a property test (random totals and weights: every share is whole cents and they add up to the total), a test that compares the sharing with the old `allocateByWeight` (copied as an oracle) on weights with more than 8 decimals, a pin test of the numbers `decision:record` writes (written before the refactor, passing on both sides), tests of the changed numbers listed in _Consequences_ and the existing report tests unchanged.

**Success measure**: the `toFixed(2)` calls on money went from 35 to 0 (the ones left format non-money values or belong to `src/utils/sizing.ts`), and the cent tolerances written inline went from 5 to 0, on 2026-10-25 (measured by `grep`).

## Pros and cons of the options

### Branded number made only by `money()`

- Good: the compiler enforces it, nothing changes in the files, survives JSON.
- Bad: a cast defeats it.

### Integer cents

- Good: exact by construction.
- Bad: changes every serialized number and every reader.

### A helper module over plain numbers

- Good: small change.
- Bad: nothing makes a place use it.

### Do nothing

- Good: no work.
- Bad: the inline tolerances stay, and the dust limit stays documented wrongly.

## More information

Doubt review: not run. This record was written inside a subagent, which cannot launch the fresh-context reviewer; the pull request review stands in for it.
