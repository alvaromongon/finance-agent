---
status: Proposed
date: 2026-10-25
decision-makers: Repository owner
---

# 0017. Money is a domain value in whole cents, made, shared and compared in one way

**Decision**: an amount of a currency (cash, cost, result of a sale, the amount of a buy) is a branded number, a number that the compiler treats as a type of its own, made only by one constructor that rounds to whole cents and says the currency (`Money<"EUR">` or `Money<"USD">`); two amounts are equal exactly when they are the same number (each is whole cents), an amount in one currency cannot be added to, subtracted from or compared with one in another (the code does not compile), a total is shared over weights in one way (the largest-remainder method) and an amount in a report or an email is mostly written with two decimals in one way. We expect the defect where two parts of the engine disagree by a float-noise cent, or write their own tolerance, or mix the amounts of two silos, to be impossible by construction. Prices, exchange rates, units and percentages are not money and stay plain numbers.

## Context and problem statement

Counted on 2026-10-25 over the sources without tests (measured): 35 calls that write a number with two decimals, in 15 files, with a money formatter used in 1 file; a cent tolerance written inline in 5 places, each written by hand; and a sharing routine that needed a correction loop to take back a cent left over by float noise. A review of the dust limit found the limit the input format documented and the limit the code applied disagreeing by a factor of two.

The first version of this decision made the type say nothing of the currency: the cash of the EUR silo and the cash of the USD silo were the same type, so adding or comparing them compiled. The model every flow reads holds the amounts of one silo, in that silo's currency, and the evaluation and the Monday briefing read both silos side by side.

**Why it matters**: the owner trades real money on this output. A cent of drift between the Lots, the decision log and the evaluation makes the consistency checks refuse the file, which blocks recording and measuring. An amount of one currency taken for another is wrong by the whole exchange rate, not by a cent.

## Decision drivers

- Almost no output changes: the numbers in `portfolio.md` and the decision log and the text of every report stay the same, except the changes listed in _Consequences_ (money given with sub-cent decimals is read to the cent; the sub-cent shares of a large sale may differ by one unit of the eighth decimal).
- The value survives JSON, so a class is out.
- The compiler finds an amount that was not rounded.
- Position sizing and stop prices are trading rules and are not touched.
- Two silos hold two currencies: the compiler must refuse to mix an amount of one with an amount of the other.

## Considered options

- **Branded number made only by one constructor, with the currency in the type**, with checked helpers for sums and differences, one way to share a total and one formatter; two amounts are compared by plain equality.
- **An object with the amount and the currency** (`{ amount, currency }`): the currency is also there at run time, so a mix can be refused when it happens, but it changes every serialized number (the decision log, the lots) and every reader.
- **Integer cents** stored and passed everywhere: exact, but changes every serialized format and every reader.
- **A helper module over plain numbers**: no type, so nothing stops a place from forgetting it.
- **Do nothing**.

## Decision outcome

Chosen option: "branded number made only by one constructor, with the currency in the type", because it is the only one that keeps every serialized number as it is and still makes the compiler reject an unrounded amount and an amount of the wrong currency.

- The constructor takes the currency (`money(1.5, "EUR")`), rounds to whole cents (never negative zero) and refuses a currency that is not EUR or USD and a value that is not finite or too large to count in cents. The currency lives in the type only, as a second brand: `Money<"EUR">` is assignable to `Money<Currency>` (a currency known only at run time, as in a decision read from the log) and to nothing else. The checked helpers (`addCounted`, `subtractCounted`, `sumCounted`, `shareMoney`) take their currency from their first operand or their stated currency and refuse, at compile time, an operand of another one (the types refuse only `===` and an assignment between two currencies: `<`, `Math.max` and `+` on two amounts compile, `+` giving a plain number that has lost the check); no amount is made without a currency, so there is no `ZERO` but `zero(currency)`. The portfolio model (`PortfolioSnapshot<C>`, `Position<C>`, `Lot<C>`) is generic in the silo's currency, so every amount in it is `Money<C>`. Cash, the profit and loss of a position, the entry costs of a lot and the costs and result of a decision carry the branded amount; the readers of `portfolio.md` make it from the cell. Sums and differences go through checked helpers that refuse, with a message, an amount too large to count in cents, so there is no float noise to clear.
- Two amounts are compared by plain equality: each is a whole number of cents, so the same cent is the same number. The tolerances the engine states remain a short, named set: an amount against units times price agrees to a cent; a buy or a sale against its cash or position is compared unrounded, with one cent of room; a balance counts as money only above a cent. The units that a cent or half a cent of price is worth have their own helpers.
- A total is shared over weights in whole cents by the largest-remainder method, in integers over the exact value of each weight (not rounded), so the shares are whole cents, none is negative and they add up to the total exactly, with no correction loop.
- Amounts in reports and emails mostly go through one shared money formatting, but a few places (the digest profit and loss, the sizing ticket, the Monday briefing) write numbers their own way. Locale formatters for prices, stops and profit and loss remain beside it; they format a value, they do not make or compare money, and the one in the charts writes R multiples, not money.
- The amount of an exit is the exception: it is its exact share of the sale amount and keeps 8 decimals, so a lot of a few units of a low-priced asset does not get 0.00. The dust limit for an amount is one rule: an amount that rounds to 0 at 8 decimals, under half of the last decimal (5e-9 of the silo currency), is 0 and cannot be recorded. A sale has a second, higher floor on its proceeds (units times price), which are money and so counted in whole cents: a sale whose proceeds round to zero cents (under half a cent) is refused, as a buy of a sub-cent amount is. So a sale needs proceeds of at least half a cent, not just 5e-9. Sharing these exact amounts is exact up to about 90 million of the silo currency; beyond that the total itself is no longer exact. The input format states the same value as the code.
- The sizing of a position and its stop prices keep plain numbers: sizing and stops are trading rules and out of this decision.

**What we give up**: every place that builds a snapshot from untyped data calls the constructor and says the currency, and tests build amounts through it; a cast defeats the brand. The currency is erased at run time: where it is only known at run time (a loop over both silos, a decision read from the log) the amounts are `Money<Currency>` and the compiler cannot tell the silos apart, and `+` on two amounts gives a plain number that has lost the check. The simple option (a helper module over plain numbers) is not enough because it leaves each place to remember it, which is how the inline tolerances arose. Integer cents would be exact but changes every format.

**Sequence**: after the ticker ([ADR-0016](0016-domain-values-are-branded-types-made-by-parsing.md)), which set the pattern. It departs from ADR-0016, which expected money to cover amounts, prices and units: this decision covers amounts only, because prices, exchange rates and units are not worth whole cents and a type for them is not clearly worth it today.

**Scope**: the engine and its tests; the input format restates the dust limit.

**Confidence**: medium-high. The type per currency that this record expected to need if a second currency were added in one expression was added on 2026-11-03 (#130). We would revisit it for a check at run time if a mix through `Money<Currency>` is ever found in a review.

### Consequences

- Changed numbers (all on sub-cent input, none on data written in cents): a `costs`, `pnl` or `entry_costs` with more than two decimals, given to `decision:record` or read from a log line, is rounded to the cent (costs of 1.234 are recorded as 1.23, where they were 1.234); for a currency conversion the rate computed from the amount received follows it (1.194695 instead of 1.194743, for 100 sold, 1.234 of costs and 118 received). A cash, profit and loss or entry costs cell of `portfolio.md` with more than two decimals is read to the cent. The `Entry costs` of two lots differing by half a cent with float noise now compare equal. The exact sub-cent shares of a sale share the exact weights (the units sold), as before, but without float noise: on random cases (measured, 100000, totals up to 100000) 11 differed from the old function, all with a total over 1000 and by one unit of `1e-8` in two shares that the old float arithmetic ordered by noise; the cent shares did not differ in any case.
- Unchanged on purpose: the cap of a sale against its position and of a buy against its cash, and the cash thresholds of the silo performance, keep their exact one-cent tolerance, unrounded, because they are ticket and measurement rules.
- Good: an amount of the EUR silo cannot be added to, subtracted from or compared with an amount of the USD silo wherever the silo is a literal type, which is where each silo's model is read and used.
- Good: the inline cent tolerances are gone; amounts in reports and emails mostly go through one shared money formatting; the sharing needs no correction loop.
- Bad: a lot worth less than one cent (proceeds under half a cent at the price offered) cannot be closed by any valid sale command, because the sale is refused however its units are chosen; it stays in the portfolio until the lot is worth a cent or is removed by hand. Accepted: the alternative, letting a sale of nothing through, records a decision with no proceeds, and such lots are noise next to the consistency of refusing sub-cent money everywhere.
- Bad: the tickets of the sizing still write numbers in their own way until a decision opens them.
- Bad: a brand is erased at run time, so the check is a compile-time one and stops where the currency is only known at run time.
- Bad: every `money()` call says its currency, and a test that builds an amount has to choose one.

### Confirmation

Unit tests of the money rules including a property test (random totals and weights: every share is whole cents and they add up to the total), a test that compares the sharing with the previous sharing routine (kept as a reference in the test) on weights with more than 8 decimals, a pin test of the numbers `decision:record` writes (written before the refactor, passing on both sides), tests of the changed numbers listed in _Consequences_ and the existing report tests unchanged; type tests (lines that must not compile, marked `@ts-expect-error`, so the type check fails if one starts to compile) that an amount in one currency is not added to, subtracted from, summed with, compared with or assigned as one in another.

**Success measure**: the cent tolerances written inline went from 5 to 0, on 2026-10-25 (measured by a text search over the sources).

## Pros and cons of the options

### Branded number made only by one constructor, with the currency in the type

- Good: the compiler enforces it, nothing changes in the files, survives JSON.
- Bad: a cast defeats it, and the currency is not there at run time.

### An object with the amount and the currency

- Good: a mix is refused when it happens, whatever the types say.
- Bad: changes every serialized number and every reader, which is the cost that made integer cents a worse option.

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
