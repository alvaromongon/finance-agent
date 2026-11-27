---
schema_version: 1
---

# Watchlist (example)

Assets the heartbeat scans every day for an entry setup.

This file is where you start: the first `npm run inbox:ingest` seeds the engine's store with it. From then on the
watchlist is engine state, changed with `watch` and `stop_watching` commands in `inbox/`, and this file is
generated from the store: do not edit it.

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
