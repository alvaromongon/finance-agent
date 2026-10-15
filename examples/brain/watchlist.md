---
schema_version: 1
---

# Watchlist (example)

Assets the heartbeat scans every day for an entry setup.

```yaml
watchlist:
  - ticker: AIR.PA
    name: Airbus
    market: Euronext Paris
    currency: EUR
    horizon: medium
    thesis: >-
      Example thesis: commercial aircraft backlog covers years of deliveries.
    thesis_link: "[[tesis-airpa]]"
  - ticker: JNJ
    name: Johnson & Johnson
    market: NYSE
    currency: USD
    horizon: medium
    thesis: >-
      Example thesis: defensive cash flows with a pharma pipeline catalyst.
    thesis_link: "[[tesis-jnj]]"
```
