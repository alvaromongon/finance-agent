---
schema_version: 2
last_manual_sync: 2026-10-09T18:00:00Z
account_env: demo
---

# Portfolio (example)

Fictitious portfolio for the demo. Prices are synthetic (`examples/market/`).
Format: `docs/input-format.md`. Each `Volume` is the sum of the `Units` of its lots, and each lot's
`Entry id` is an entry of `logs/decisions.jsonl`, of the lot's `Ticker`.

## EUR — Cash

| Item | Value |
|---|---|
| Available cash | 1.200,00 € |

## EUR — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| SAP.DE | 2 | 180,00 | 180,00 | 0,00 | 168,00 |

## EUR — Lots

| Ticker | Entry id | Date | Units | Entry units | Entry price | Initial stop | Entry costs | Origin | Rules version | Rules violations |
|---|---|---|---|---|---|---|---|---|---|---|
| SAP.DE | 20260915-sapde-entry-example | 2026-09-15 | 2 | 2 | 180,00 | 168,00 | — | sistema | 1.0 | — |

## USD — Cash

| Item | Value |
|---|---|
| Available cash | $900.00 |

## USD — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| KO | 5 | 62.00 | 62.00 | 0.00 | 58.00 |

## USD — Lots

| Ticker | Entry id | Date | Units | Entry units | Entry price | Initial stop | Entry costs | Origin | Rules version | Rules violations |
|---|---|---|---|---|---|---|---|---|---|---|
| KO | 20260916-ko-entry-example | 2026-09-16 | 5 | 5 | 62.00 | 58.00 | — | sistema | 1.0 | — |
