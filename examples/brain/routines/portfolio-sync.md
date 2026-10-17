# Portfolio sync (example)

How you keep `portfolio.md` in step with your broker and tell the engine what you did. The engine
integrates with no broker: it cannot know that an order filled or a stop was hit, so it warns
("portfolio.md has not been updated for N days") when `last_manual_sync` is older than
`PORTFOLIO_STALE_DAYS`. This guide is what that warning points to. You can follow it by hand, or
hand it to a Claude Code session as its instructions.

## The rule

Every event at the broker gets two changes, made together and committed together:

1. **`portfolio.md`**: the cash, the position row, the stop (format: `docs/input-format.md`).
2. **`logs/decisions.jsonl`**, through `npm run decision:record`, with the event as JSON on stdin.
   Never edit the log by hand.

The engine rebuilds each silo's value backwards from today's `portfolio.md` through the logged
events, to compare you with the shadow portfolio. If the two disagree (a trade in the log that
`portfolio.md` does not show, or the other way round), the evaluation warns about negative cash or
oversold units instead of reporting a wrong number.

The engine fills in the rest: id, rules version, benchmark price, rules broken, and the system
proposal the trade follows (that sets its `origin`). Omit `date` for today; give it (`YYYY-MM-DD`)
when you record something that happened earlier.

## Order that keeps the P&L right

Process the events in the order they happened at the broker, and inside each event follow the
order below. Update the cash and `last_manual_sync` last.

1. **Money in or out, and currency conversions, first.** Later buys are funded by them, and the
   shadow portfolio buys its benchmark with every flow on its own date, so a wrong or missing date
   shifts the comparison.
2. **A buy:** record it, then add the row.
3. **A sale:** record it **before you delete or reduce the row**. The engine computes the realized
   result from the average price still in `portfolio.md`; without the row it records the exit with
   no P&L (and the two-month rule and the evaluation lose the number).
4. **A stop change:** record it, then edit the `Stop loss` cell.
5. **Cash and timestamp:** set `Available cash` (and `Total cash`, if you keep it) to the
   broker's figures and `last_manual_sync` to now (ISO, UTC). This is the step that silences the
   stale warning.

Each command prints what it recorded and the rules it found broken; read that line, it is the
engine's feedback on your trade.

## Events

All examples run as `echo '<json>' | npm run decision:record`, or with the JSON in a file piped in.
`currency` is the silo (`EUR` or `USD`). Numbers are plain (`1234.56`), not localized.

### Deposit or withdrawal

Money you moved between your bank and the broker. Add or subtract it in `Available cash`.

```json
{ "type": "deposit", "currency": "EUR", "amount": 500, "date": "2026-10-12" }
```

```json
{ "type": "withdrawal", "currency": "USD", "amount": 200 }
```

### Currency conversion

`currency` is the silo the money **leaves**; `amount` is what you converted in that currency.
Give the rate you got (`fx_rate`: target currency per unit of source, before the fee) or what
arrived (`received`, in the target currency). Without `costs`, the fee defaults to
`BROKER_FX_CONVERSION_PCT`. Reduce the cash of the source silo and add what arrived to the other.

```json
{ "type": "fx_conversion", "currency": "EUR", "amount": 1000, "received": 1160, "costs": 5 }
```

### Buy

Give `price` and either `amount` or `units`, plus the initial `stop` (the base every R is
measured against). Then add the row to `Positions`: `Volume`, `Avg price` (as your broker reports it) and `Stop loss`. If you already hold the ticker, update the
volume and the weighted average price instead of adding a row.

```json
{ "type": "entry", "ticker": "KO", "currency": "USD", "price": 62, "units": 5, "stop": 58 }
```

A buy that follows a system proposal or an armed breakout within 10 days is attributed to the
system; any other is yours and is checked against the watchlist and the stop distance.

### Sell

Give `price` and `amount` or `units`. Record it first (see the order above), then delete the row,
or lower `Volume` if you sold part of it (the average price of the rest does not change). Set
`origin` to `sistema` only when the engine cannot infer that you followed its sell proposal. Add
`pnl` only if you want to override the one computed from `portfolio.md`.

```json
{ "type": "exit", "ticker": "SAP.DE", "currency": "EUR", "price": 195, "units": 2, "costs": 1.5 }
```

### Stop change

`stop` is the new level. Record it, then edit the `Stop loss` cell. A stop that your broker
executed is a sale: record an `exit` at the fill price instead.

```json
{ "type": "adjust_stop", "ticker": "KO", "currency": "USD", "stop": 60 }
```

## Checking your work

- `npm run decisions:evaluate` rewrites `logs/decisions-evaluation.md`; a silo that does not
  reconcile shows a warning there.
- A mistake in the log is fixed in a dedicated commit that edits that one line, when no automated
  run is in flight ([ADR-0006](https://github.com/alvaromongon/finance-agent/blob/main/docs/decisions/0006-single-append-only-decision-log.md)).

Old logs and queue files are covered in [Log retention](https://github.com/alvaromongon/finance-agent/blob/main/docs/log-retention.md).
