---
status: Accepted
date: 2026-10-15
decision-makers: Repository owner
---

# 0014. The SLO is the quality of the system's proposals against what actually happened, with a confidence bound; plus a bounded-cost operational SLO

- **Issue**: initial publication (v0.1.0)

**Decision**: the headline objective of this system is not speed. It is whether the system's **proposals** are good, judged against what actually happened afterwards, whether or not anyone executed them. Every proposal is evaluated in R and against the benchmark, with a lower confidence bound. Until the sample can tell, the status is "insufficient data" or "inconclusive" instead of pass or fail. The user's own portfolio (real value against a shadow portfolio, realised R) is measured too, but as a private metric. A small operational SLO bounds the reasoning cost per run.

## Context and problem statement

The engine never executes orders: it proposes, and a person decides. A user's question is "are its proposals better than doing nothing?". A latency SLO on a batch job that takes seconds answers nothing useful.

**Why it matters**: running the system costs attention, money in reasoning tokens and, above all, capital at risk. If the proposals don't beat the benchmark, the best decision is to stop using them.

## Decision drivers

- Market regime confounds absolute returns: a rising month makes every buy look good. Measure relative to a benchmark, and in R.
- Samples are small: about 1.5–2 entries per week (estimated, original deployment), and they overlap in time.
- Publishing a track record can read as marketing financial results, against the README's disclaimer.
- Everything is computed deterministically from the decision log ([ADR-0006](0006-single-append-only-decision-log.md)) by `decisions:evaluate`.

## Considered options

- A latency/throughput SLO, as for a service.
- Decision-quality SLIs with point targets and a minimum sample of 30.
- Decision-quality SLIs with confidence bounds, where the money comparison with the benchmark is the headline.
- Decision-quality SLIs with confidence bounds, where the evaluation of every proposal, executed or not, is the headline, and the user's portfolio is a private metric.

## Decision outcome

Chosen option: "proposal quality as headline, the user's portfolio as a private metric". The proposal measure judges the system alone. The user's execution does not enter it: fill, exit timing and moved stops are left out. It needs no money, account size or real trades, so it can be published without exposing anyone's portfolio.

| SLI                                  | Definition                                                                                                                                                                | Target                                                 | Status below the bound                                                               | Published           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------- |
| **1. Proposal quality** (headline)   | Mean plan R of every buy proposal, executed or not, over 60 sessions; shown next to the break-even hit rate 1/(1+R:R) and to the benchmark's return over the same windows | lower bound of a one-sided 90% bootstrap interval > 0R | "insufficient data" below 30 proposals; "inconclusive" while the interval contains 0 | yes, in R, no money |
| **2. Screening lift**                | Mean excess return at 60 sessions of ranked "interesting" candidates minus exploration candidates                                                                         | lower bound > 0                                        | same                                                                                 | yes                 |
| **3. Beats doing nothing** (private) | The user's real silo value against its shadow portfolio ([ADR-0009](0009-swing-framework-risk-sizing-and-measurement.md) §1), money-weighted, net of costs                | real ≥ shadow                                          | always reported                                                                      | no                  |
| **4. Executed expectancy** (private) | Mean net R of the system's closed trades                                                                                                                                  | lower bound > 0R                                       | same as 1                                                                            | no                  |
| **Operational**                      | Claude calls per heartbeat run, with providers stubbed                                                                                                                    | ≤ number of escalated signals (≤ 1 per signal)         | checked in CI                                                                        | —                   |

Every SLI is also reported by market regime, which is already stored on each decision.

**What we give up**: at about 1.5–2 proposals per week, 30 evaluated proposals take roughly 4–6 months including the 60-session window (estimated). Until then the honest status is "insufficient data". A wall-clock bound on the run is not a target: with stubs and shared CI runners it measures neither the provider nor Claude, and it would be flaky. It is kept only as a generous regression check (3× the median of measured runs).

**Sequence**: first the operational SLO (testable now), then confidence bounds and per-regime reporting in `decisions:evaluate`, then the corrections to the plan simulation listed below.

**Scope**: the README's SLO section, `decisions:evaluate`, and every user who reads its report.

**Confidence**: medium on the SLIs, low on the targets until real samples exist. Revisit once SLI 1 has 30 evaluated proposals.

### Consequences

- Good: users get a method to judge the system on their own data, reproducible from the example brain.
- Bad, accepted, to be fixed in the evaluator:
  - SLI 4 mixes the system's proposals with the user's execution. That is why it is private and not the headline. An "execution gap" measure (SLI 4 against SLI 1 on the same trades) and counting trades without an initial stop as failures are follow-ups.
  - The plan simulation assumes a fill at the proposal's entry and books a gap below the stop as exactly −1R. Open positions are left out of the closed-trade expectancy. All three bias towards looking good.
  - Observations overlap in time and repeat tickers. Intervals should use a block bootstrap.
  - Decision prices are stored as of the day, while history comes from Yahoo bars. A split inside the window can fake a stop or target hit, and the closes ignore dividends. Unverified: no adjustment handling was found in the code.

### Confirmation

- The operational SLO: a test or load test asserts the number of Claude calls per run against stubs ([`slo-operational.test.ts`](../../src/tests/slo-operational.test.ts)).
- SLIs 1–4: `decisions:evaluate` renders them ([#1](https://github.com/alvaromongon/finance-agent/issues/1) adds the bounds). `src/tests/decisions-evaluation.test.ts` checks the computation.

**Success measure**: the README shows each SLI's current status for the example brain, and a user can reproduce it with `npm run decisions:evaluate`.

## Pros and cons of the options

### Latency SLO

- Bad: says nothing about whether the system is worth using.

### Point targets with n ≥ 30

- Good: simple.
- Bad: with an R standard deviation of about 1–1.5 (estimated), the standard error at n = 30 is about 0.2–0.27R. A system with no edge then shows a positive mean about half of the time.
- Bad: a hit rate means nothing without the R:R. At 2:1, break-even is 33%.

## More information

**Publishing real results — deferred until there is data.** There is no real sample yet. The owner's direction (2026-10-15): what is publishable is the evaluation of the proposals (SLI 1 and 2), not the owner's portfolio. A proposal does not need to be executed to be checked against what happened. When it is published, it should be:

- **Pre-registered, not selected**: every proposal, including blocks and holds, appended by the workflow before its outcome is known, whatever the result. Publishing only what goes well would be cherry-picking.
- **In R, without money**: date, ticker, setup, entry, stop, target, horizon, rules version, conviction and eligibility verdict. No units, amounts or silo value.
- **Not a signal service**: published on a delay (for example weekly) with the not-financial-advice notice. Daily publication proves timing better, but reads like signals.

Options weighed before this direction: never publishing, or pre-committing to publish aggregates at n = 30 whatever their sign. A backtest is not an option: a model in the loop may have seen those prices in training. Revisit when SLI 1 has 30 evaluated proposals.

**Doubt review** (fresh-context reviewer, 2026-10-15). Ten findings:

- Adopted (they change the decision):
  - A confidence bound instead of point targets.
  - The money comparison with the benchmark as an SLI (later made private: see above).
  - Plan R instead of hit rate.
  - Lift with a defined target.
  - Claude calls instead of wall-clock time as the operational target.
  - Per-regime reporting.
- Accepted as bad consequences, to be fixed in the evaluator: execution mixing, gap and censoring bias, overlapping observations, price adjustment.
- Left to the owner: whether to publish real results. Deferred until there is data, with the direction above.
