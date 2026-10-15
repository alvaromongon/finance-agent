---
schema_version: 1
next_review: 2027-04-01
---

# Screening universe (example)

What the weekly screening ranks. Format: `docs/input-format.md`.

```yaml
universe:
  eur:
    - { ticker: SAP.DE, name: SAP, market: Xetra, currency: EUR }
    - { ticker: AIR.PA, name: Airbus, market: Euronext Paris, currency: EUR }
  usd:
    - { ticker: KO, name: Coca-Cola, market: NYSE, currency: USD }
    - { ticker: JNJ, name: Johnson & Johnson, market: NYSE, currency: USD }
  commodities: []
```
