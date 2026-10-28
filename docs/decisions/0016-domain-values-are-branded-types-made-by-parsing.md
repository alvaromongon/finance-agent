---
status: Proposed
date: 2026-10-25
decision-makers: Repository owner
---

# 0016. Domain values are branded types made only by parsing at the boundary, compared by plain equality

**Decision**: a domain value that has a canonical form (a ticker first, money next) is a branded type, a string or number that the compiler treats as a type of its own, and the only way to make one is to parse it at the boundary where the value enters; inside the engine two values are equal exactly when they are the same string (or number). We expect the class of defect where two parts of the engine disagree on whether `TCK` and `tck` are the same asset to be impossible by construction, instead of caught one check at a time.

## Context and problem statement

The engine read a ticker as a plain string in about 15 files and each place decided for itself what "the same ticker" meant: about 22 comparisons used exact equality, one check (the consistency check between the lots and the positions) compared without case, about 12 places lower-cased a ticker for a file name or slug in slightly different ways (with and without removing dots), and 5 checked "non-empty string" separately. A review of that check found the consequence: it treated `TCK` and `tck` as one ticker while the writers matched exactly, so recording an entry on `tck` appended a second `Positions` row for the same asset and every later `decision:record` and `decisions:evaluate` was refused.

**Why it matters**: the owner trades real money on this output. Counted on 2026-10-25 by a text search over the sources without tests (measured): 42 lines handle a ticker by hand in 15 files. Each is a place where a future change can reintroduce the disagreement, and money (amounts, prices, units) has the same shape of problem with rounding and currency instead of case.

## Decision drivers

- Two tickers are the same asset exactly when they are the same string, everywhere, with no per-site rule.
- A wrong value is refused at the boundary with a clear message, before anything is written.
- Data already written by the owner in another case keeps working with no change to the files.
- The value survives JSON (the decision log, the analyst's answers), so a class instance is out.
- The compiler, not the reviewer, finds a place that forgot to parse.

## Considered options

- **Branded type made only by parsing**: a ticker is a string with a brand, the one way to make it trims the text, checks the pattern and upper-cases it, and the domain types carry the branded ticker.
- **Normalize at every comparison**: keep `string` and compare through one shared helper, key the maps by it.
- **Value class**: a ticker object with its own equality method.
- **Do nothing**: fix the consistency check to compare exactly, like the writers.

## Decision outcome

Chosen option: "branded type made only by parsing", because it is the only one where the compiler rejects a value that was not parsed, it costs nothing at run time and it survives JSON.

- A ticker is trimmed, checked against the pattern (letters, digits and `. - ^ =`, with at least one letter or digit, no two dots in a row and no leading dot; `BRK-B`, `EXSA.DE`, `^GSPC`, `EURUSD=X` are tickers, `TC|K`, `-`, `A..B` and `.A` are not) and upper-cased. The domain types (watchlist entry, position, lot, signal, recommendation, decision, benchmark) carry the branded ticker.
- Every boundary that reads a ticker parses it: the owner's `decision:record` input, `portfolio.md` (`Positions` and `Lots`), the decision log (live and archived), the watchlist, the screening universe and log, the pending files, the analyst's and the briefing's JSON, the command-line arguments and the benchmark configuration. A value that does not parse is never accepted, and what happens next follows [ADR-0015](0015-open-lots-live-in-the-portfolio.md) ("a typo must never switch off stop alerts"). For `portfolio.md`, `decision:record` (for the silo it records) and `decisions:evaluate` (for both silos) refuse the file, naming the source, when a `Positions` row has a ticker that does not parse, and refuse the silo, through the lots check, when a `Lots` row has one; `decision:record` also refuses a watchlist entry of either silo that does not parse. Every other reader (the heartbeat, `pending:resolve`, the Monday briefing, the weekly screening) skips that `Positions` row, watchlist entry, screening-universe entry or screening-log row with a warning naming it and carries on, and the heartbeat digest repeats the warning in every run while it lasts for the skipped `Positions` rows and watchlist entries. Those readers also skip a `Lots` row; of them only the heartbeat reports it, among its `Lots` problems, and the others drop it without a warning. A decision-log line (live or archived) whose ticker does not parse is different: every reader skips it with a console warning, `decision:record` and `decisions:evaluate` included, and the digest does not repeat it; a lot whose entry was that line is then refused by the lots check. A benchmark whose ticker does not parse is dropped from its decision-log line with a console warning, and the decision is kept. The reader of a command-line argument, a pending file or a screening candidate refuses, since the command cannot run without it.
- Reading is case-insensitive and writing is upper case: a ticker written in lower case in `portfolio.md` or in the log reads as its upper-case value, the files are not rewritten, and a row the engine writes carries the canonical ticker.
- File names and slugs derived from a ticker come from one place, and keep the names the engine already writes.
- Money (amount, price, units, with their rounding and currency) is the next value to follow this pattern, in its own change. Until then it stays a number.

**What we give up**: every place that builds a domain object from untyped data must call a parser, and tests build tickers through the same parsing; a ticker outside the pattern (an Indian ticker such as `M&M.NS`) is skipped by the readers that carry on (and refused by the two commands that write or measure, for `portfolio.md`) until the pattern is widened by a decision of its own. The simple option (normalize at each comparison) is not enough because it leaves 42 places that each have to remember to do it, which is how the defect arose.

**Sequence**: `Ticker` first, because it caused a blocking defect; money after, because its rules (rounding, currency) need their own design.

**Scope**: the engine and its tests; the input format gains a stated ticker pattern and the rule that tickers are read in any case.

**Confidence**: high for `Ticker`, medium for the pattern as a general recipe. We would revisit if parsing at the boundary turns out to hide a value the owner needs (the `&` ticker), or if a domain value appears whose canonical form depends on context (money in a currency), where a branded primitive is not enough.

### Consequences

- Good: a ticker that was not parsed does not compile; two tickers differing in case cannot exist inside the engine; one place defines a file name.
- Good: the case-insensitive comparison of the lots check is deleted, since the case can no longer differ.
- Bad: a brand is erased at run time, so a type cast can still defeat it; review is what remains. Two casts are left in the sources, one inside the parsing itself and one after the analyst's validation has recorded the error.
- Bad: test code needs a parsing step where it used to write a string literal.

### Confirmation

Unit tests of the parsing (accepted and refused values, canonical form) and a component test that records an entry on `tck` against a portfolio holding `TCK` and checks one position row and that the next record is accepted. The type checker in the quality gate rejects an unparsed ticker in a domain type.

**Success measure**: the lines that lower-case, upper-case or trim a ticker by hand (a text search over the sources, tests excluded and the parsing itself excluded) fell from 28 to 4 on 2026-10-25 (measured), the 4 left reading a table cell just before it is parsed; and recording an entry on a ticker in another case never creates a second position row (the named component test).

## Pros and cons of the options

### Branded type made only by parsing

- Good: the compiler enforces it; no cost at run time; survives JSON.
- Bad: a cast defeats it; parsing is needed at every boundary.

### Normalize at every comparison

- Good: no type change.
- Bad: every comparison and every map key must remember to use the helper; this is the state that produced the defect.

### Value class

- Good: methods (equality, a file name) live with the value.
- Bad: it does not survive JSON, so every read and write needs a conversion; equality is no longer plain equality.

### Do nothing

- Good: no work.
- Bad: the disagreement between the check and the writers stays, in whichever direction it is resolved.

## More information

The ticker pattern comes from the Yahoo Finance symbols the engine reads (upper case, with `-`, `.`, `^` and `=`), checked in the sources on 2026-10-25. That Yahoo answers a lower-case symbol with the same instrument was not assumed: the engine now sends only upper-case symbols, and the check against the provider is recorded in the pull request.

Doubt review: not run. This record was written inside a subagent, which cannot launch the fresh-context reviewer the process asks for; the pull request review stands in for it.
