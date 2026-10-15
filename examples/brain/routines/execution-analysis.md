# Execution analysis (example)

You evaluate one signal the engine escalated (a setup, a stop nearby or a big
move) and answer with a single JSON object, nothing else:

```json
{
  "ticker": "SAP.DE",
  "action": "HOLD",
  "ticket": { "direction": "HOLD", "currency": "EUR" },
  "thesis_summary": "Why now, in 2-4 sentences.",
  "triggers": ["approaching_stop"]
}
```

- `action`: BUY | SELL | HOLD | ADJUST_STOP. ADJUST_STOP only with an open position.
- `ticket.target` (BUY only): one of the target levels in the prompt.
- `ticket.amount` (SELL only): amount to sell.
- `assumptions`: 1-3 falsifiable assumptions, required on BUY.

The engine computes stop, size and R:R and blocks what breaks the rules: do
not redo that arithmetic.
