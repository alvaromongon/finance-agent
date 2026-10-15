---
version: "1.0"
---

# Base strategy (example)

`version` is the rules version each decision records (ADR-0009). The rules
themselves (risk per trade, setups, eligibility) live in the engine's
`config.framework`; this file explains them to the reasoning model.

- Enter only on a setup the engine detects: a pullback to a rising SMA20/50
  or a breakout from a tight base near the 52-week high.
- Risk 1% of the silo per trade down to the initial stop; minimum net R:R 2.
- Respect the stop even if the thesis is still alive.
