---
status: Proposed
date: 2026-10-25
decision-makers: Repository owner
---

# 0016. Domain values are branded types made only by parsing at the boundary, compared with `===`

**Decision**: a domain value that has a canonical form (a ticker first, money next) is a branded type, a string or number that the compiler treats as a type of its own, and the only way to make one is a `parse` function at the boundary where the value enters; inside the engine two values are equal exactly when `===` says so. We expect the class of defect where two parts of the engine disagree on whether `TCK` and `tck` are the same asset to be impossible by construction, instead of caught one check at a time.

## Context and problem statement

The engine read a ticker as a plain string in about 15 files and each place decided for itself what "the same ticker" meant: about 22 comparisons used exact `===`, one check (the lots check) compared without case, about 12 places lower-cased a ticker for a file name or slug in slightly different ways (with and without removing dots), and 5 checked "non-empty string" separately. A review of the lots check found the consequence: the check treated `TCK` and `tck` as one ticker while the writers matched exactly, so recording an entry on `tck` appended a second `Positions` row for the same asset and every later `decision:record` and `decisions:evaluate` was refused.

**Why it matters**: the owner trades real money on this output. Counted on 2026-10-25 by `grep` over the sources without tests (measured): 42 lines handle a ticker by hand in 15 files. Each is a place where a future change can reintroduce the disagreement, and money (amounts, prices, units) has the same shape of problem with rounding and currency instead of case.

## Decision drivers

- Two tickers are the same asset exactly when they are the same string, everywhere, with no per-site rule.
- A wrong value is refused at the boundary with a clear message, before anything is written.
- Data already written by the owner in another case keeps working with no change to the files.
- The value survives JSON (the decision log, the analyst's answers), so a class instance is out.
- The compiler, not the reviewer, finds a place that forgot to parse.

## Considered options

- **Branded type made only by parsing**: `Ticker` is `string & brand`, `parseTicker` trims, checks the pattern and upper-cases it, and the domain types carry `Ticker`.
- **Normalize at every comparison**: keep `string` and compare through one helper (`sameTicker(a, b)`), key the maps by it.
- **Value class**: a `Ticker` object with `equals`.
- **Do nothing**: fix the lots check to compare exactly, like the writers.

## Decision outcome

Chosen option: "branded type made only by parsing", because it is the only one where the compiler rejects a value that was not parsed, it costs nothing at run time and it survives JSON.

- A ticker is trimmed, checked against the pattern (letters, digits and `. - ^ =`, with at least one letter or digit; `BRK-B`, `EXSA.DE`, `^GSPC`, `EURUSD=X` are tickers, `TC|K` and `-` are not) and upper-cased. The domain types (watchlist entry, position, lot, signal, recommendation, decision, benchmark) carry `Ticker`.
- Every boundary that reads a ticker parses it: the owner's `decision:record` input, `portfolio.md` (`Positions` and `Lots`), the decision log (live and archived), the watchlist, the screening universe and log, the pending files, the analyst's and the briefing's JSON, the command-line arguments and the benchmark configuration. A value that does not parse is refused with a message naming the source. Where the source tolerates a bad row (a `Lots` row, a decision-log line) it is skipped with the reason, as for any other bad value of that row.
- Reading is case-insensitive and writing is upper case: a ticker written in lower case in `portfolio.md` or in the log reads as its upper-case value, the files are not rewritten, and a row the engine writes carries the canonical ticker.
- File names and slugs derived from a ticker come from one module, and keep the names the engine already writes.
- Money (amount, price, units, with their rounding and currency) is the next value to follow this pattern, in its own change. Until then it stays a number.

**What we give up**: every place that builds a domain object from untyped data must call a parser, and tests build tickers through `parseTicker`; a ticker outside the pattern (an Indian ticker such as `M&M.NS`) is refused until the pattern is widened by a decision of its own. The simple option (normalize at each comparison) is not enough because it leaves 42 places that each have to remember to do it, which is how the defect arose.

**Sequence**: `Ticker` first, because it caused a blocking defect; money after, because its rules (rounding, currency) need their own design.

**Scope**: the engine and its tests; the input format gains a stated ticker pattern and the rule that tickers are read in any case.

**Confidence**: high for `Ticker`, medium for the pattern as a general recipe. We would revisit if parsing at the boundary turns out to hide a value the owner needs (the `&` ticker), or if a domain value appears whose canonical form depends on context (money in a currency), where a branded primitive is not enough.

### Consequences

- Good: a ticker that was not parsed does not compile; two tickers differing in case cannot exist inside the engine; one place defines a file name.
- Good: the case-insensitive comparison of the lots check is deleted, since the case can no longer differ.
- Bad: a brand is erased at run time, so a cast (`as Ticker`) can still defeat it; review is what remains.
- Bad: test code needs a parse call where it used to write a string literal.

### Confirmation

Unit tests of the parser (accepted and refused values, canonical form) and a component test that records an entry on `tck` against a portfolio holding `TCK` and checks one position row and that the next record is accepted. The type checker in the quality gate rejects an unparsed ticker in a domain type.

**Success measure**: the lines that lower-case, upper-case or trim a ticker by hand (`grep -rniE 'ticker.*(toLowerCase|toUpperCase|trim\(\))|(toLowerCase|toUpperCase|trim\(\)).*ticker' src`, tests excluded, the ticker module excluded) fell from 28 to 4 on 2026-10-25 (measured), the 4 left reading a table cell just before it is parsed; and recording an entry on a ticker in another case never creates a second position row (the named component test).

## Pros and cons of the options

### Branded type made only by parsing

- Good: the compiler enforces it; no cost at run time; survives JSON.
- Bad: a cast defeats it; parsing is needed at every boundary.

### Normalize at every comparison

- Good: no type change.
- Bad: every comparison and every map key must remember to use the helper; this is the state that produced the defect.

### Value class

- Good: methods (`equals`, `fileName`) live with the value.
- Bad: it does not survive JSON, so every read and write needs a conversion; equality is no longer `===`.

### Do nothing

- Good: no work.
- Bad: the disagreement between the check and the writers stays, in whichever direction it is resolved.

## More information

The ticker pattern comes from the Yahoo Finance symbols the engine reads (upper case, with `-`, `.`, `^` and `=`), checked in the sources on 2026-10-25. That Yahoo answers a lower-case symbol with the same instrument was not assumed: the engine now sends only upper-case symbols, and the check against the provider is recorded in the pull request.

Doubt review: not run. This record was written inside a subagent, which cannot launch the fresh-context reviewer the process asks for; the pull request review stands in for it.
