---
status: "Deprecated — detail moved to [flows.md](../flows.md#market-data-freshness)"
date: 2026-10-15
decision-makers: Repository owner
---

# 0008. Market data freshness: batch quotes, a session guard by tick age, and a direct stop-breach alert

- **Issue**: initial publication (v0.1.0)

**Decision**:

- Quotes are fetched in batches of up to 20 symbols from Yahoo Finance `spark`, falling back to `chart` per ticker.
- The "market closed" guard looks at the age of the last tick (18 h by default, `MARKET_SESSION_MAX_AGE_HOURS`), not at calendar dates.
- The portfolio prices are refreshed before that guard.
- A price below a recorded stop sends a direct email, with no LLM and no cooldown.

## Context and problem statement

In the original deployment the guard compared the date of the last tick with the runner's date. GitHub Actions schedules run late under load: we observed delays of several hours, crossing midnight UTC. Between two dates in August 2026, 4 of 5 runs aborted as "market closed" after downloading correct prices (measured in the run logs). They ended green, so nothing showed it. The portfolio was refreshed after the guard, so it stayed four days stale.

**Why it matters**: a stop crossed on an open position must be seen the same day.

## Decision drivers

- A delayed schedule must not look like a holiday.
- Fewer requests from datacenter IPs, where Yahoo rate-limits hardest.
- An unofficial data source can change without notice. The heartbeat must degrade gracefully, not stop.

## Considered options

- Calendar-date guard and one request per ticker (do nothing).
- Tick-age guard, batch quotes with fallback, and a direct stop-breach alert.
- A paid market data provider.

## Decision outcome

Chosen option: "tick-age guard, batch quotes with fallback, direct alert". A late schedule (≤ 13 h in the worst observed case) is cleanly separated from a holiday (≥ 25 h) or a weekend (≥ 49 h).

**What we give up**: `spark` is as unofficial as `chart`. The automatic fallback is what makes depending on it acceptable. A stop-breach alert repeats on every run until the portfolio is synced: deliberate, because it means the account has not been checked.

**Scope**: the heartbeat and the Monday briefing.

**Confidence**: medium. Yahoo's endpoints are unofficial: revisit if they break, or when the market data provider is made pluggable for a paid one.

### Consequences

- Good: about 30 tickers go from about 30 requests to 2 per run (measured in the original deployment).
- Bad: the engine can't know whether the broker executed a stop. Only a manual sync answers that.

### Confirmation

`src/tests/yahoo-finance.test.ts` (batch and fallback), `src/tests/market-session.test.ts` (tick-age guard) and `src/tests/stop-breach.test.ts`.

**Success measure**: a late schedule is never classified as a closed market, enforced by `src/tests/market-session.test.ts`.

## More information

Retroactive record of a decision taken on 2026-09-01. `v7/finance/quote` was rejected because it answers 401 even with a crumb. Users must respect Yahoo Finance's terms of use (see the README).
