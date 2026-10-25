---
status: Proposed
date: 2026-10-25
decision-makers: Repository owner
---

# 0017. Money is a domain value in whole cents: one constructor, one comparison, one way to share and format

**Decision**: an amount of the silo currency (cash, cost, result of a sale, the amount of a buy) is a branded number, `Money`, made only by `money()`, which rounds to whole cents; two amounts are compared at the cent by one function, a total is shared over weights by one function (the largest-remainder method) and an amount is written with two decimals by one function. We expect the defect where two parts of the engine disagree by a float-noise cent, or write their own tolerance, to be impossible by construction. Prices, exchange rates, units and percentages are not money and stay plain numbers.

## Context and problem statement

Counted on 2026-10-25 over the sources without tests (measured): 35 `toFixed(2)` calls in 15 files, with a money formatter used in 1 file; a cent tolerance written inline in 5 places (`0.005`, `0.01 + 1e-9`, `0.01 / price`, `CASH_EPSILON = 0.01`); and a sharing function that needed a loop to take back a cent left over by float noise. A review of the dust limit found the documented limit (`1e-8`) and the code (an amount that rounds to 0 at 8 decimals, that is under `5e-9`) disagreeing.

**Why it matters**: the owner trades real money on this output. A cent of drift between the Lots, the decision log and the evaluation makes the consistency checks refuse the file, which blocks recording and measuring.

## Decision drivers

- No output changes: the numbers in `portfolio.md` and the decision log and the text of every report stay the same.
- The value survives JSON, so a class is out.
- The compiler finds an amount that was not rounded.
- Position sizing and stop prices are trading rules and are not touched.

## Considered options

- **Branded number made only by `money()`**, with helpers (add, subtract, sum, `sameCents`, `shareMoney`, `formatMoney`).
- **Integer cents** stored and passed everywhere: exact, but changes every serialized format and every reader.
- **A helper module over plain numbers**: no type, so nothing stops a place from forgetting it.
- **Do nothing**.

## Decision outcome

Chosen option: "branded number made only by `money()`", because it is the only one that keeps every serialized number as it is and still makes the compiler reject an unrounded amount.

- `money(n)` rounds to whole cents (never negative zero) and throws on a value that is not finite. Cash, `Position.pl`, a lot's entry costs, a decision's `costs`, `pnl` and `entry_costs` carry `Money`; readers of `portfolio.md` make it from the cell. Sums go through `sumMoney`/`addMoney`, so there is no float noise to clear.
- `sameCents` is the comparison of two amounts; `withinACent` and `overByMoreThanACent` are the two tolerances the engine states (an amount against `units x price`; a buy or a sale against its cash or position). The units a cent or half a cent of price is worth come from `unitsWorthACent` and `unitsWorthHalfACent`.
- `shareMoney` shares a total over weights in whole cents by the largest-remainder method, in integers (BigInt), so the shares are whole cents, none is negative and they add up to the total exactly, with no correction loop.
- `formatMoney` writes two decimals and is the only money formatter.
- The amount of an exit is the exception: it is its exact share of the sale amount and keeps 8 decimals (`shareExactAmount`, `exactAmount`), so a lot of a few units of a low-priced asset does not get 0.00. The dust limit is one rule: an amount that rounds to 0 at 8 decimals, under `5e-9` of the silo currency, is 0 and cannot be recorded or sold. The input format states the same value as the code.
- The tickets of the sizing (`src/utils/sizing.ts`) keep plain numbers: sizing and stops are trading rules and out of this decision.

**What we give up**: every place that builds a snapshot from untyped data calls `money()`, and tests build amounts through it; a cast defeats the brand. The simple option (a helper module over plain numbers) is not enough because it leaves each place to remember it, which is how the inline tolerances arose. Integer cents would be exact but changes every format.

**Sequence**: after the ticker ([ADR-0016](0016-domain-values-are-branded-types-made-by-parsing.md)), which set the pattern.

**Scope**: the engine and its tests; the input format restates the dust limit.

**Confidence**: medium-high. We would revisit if a second currency has to be added in one expression (a type per currency would be needed).

### Consequences

- Good: the inline cent tolerances and the money `toFixed(2)` calls outside the sizing are gone; the sharing needs no correction loop.
- Bad: the tickets of the sizing still format with `toFixed(2)` until a decision opens them.
- Bad: a brand is erased at run time.

### Confirmation

Unit tests of `money.ts` including a property test (random totals and weights: every share is whole cents and they add up to the total), a pin test of the numbers `decision:record` writes (written before the refactor, passing on both sides) and the existing report tests unchanged.

**Success measure**: money `toFixed(2)` calls outside the sizing and the tickets fell from 35 to 0 outside `src/utils/sizing.ts` and non-money values (prices, percentages, ATR), and inline cent tolerances from 5 to 0, on 2026-10-25 (measured by `grep`).

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
