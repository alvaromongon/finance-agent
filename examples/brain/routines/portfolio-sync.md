# Portfolio sync (example)

How you keep `portfolio.md` in step with your broker and tell the engine what you did. The engine
integrates with no broker: it cannot know that an order filled or a stop was hit, so it warns
("portfolio.md has not been updated for N days") when `last_manual_sync` is older than
`PORTFOLIO_STALE_DAYS`. This guide is what that warning points to. You can follow it by hand, or
hand it to a Claude Code session as its instructions. The file format is
[`docs/input-format.md`](https://github.com/alvaromongon/finance-agent/blob/main/docs/input-format.md#portfoliomd).

## The rule

Every event at the broker is told to the engine through `npm run decision:record`, with the event
as JSON on stdin. That command appends to the
[decision log](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#decision-log)
(`logs/decisions.jsonl`; never edit it by hand) and, for a buy or a sale, keeps the
[lots](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#lot) in
`portfolio.md` for you:

| Event               | `decision:record` writes                                                                                                             | You edit by hand               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| Deposit, withdrawal | the log                                                                                                                              | `Available cash`               |
| Currency conversion | the log                                                                                                                              | `Available cash` of both [silos](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#silo) |
| Buy | the log, a new row in `Lots`, `Volume` and `Avg price` of the position, and `Stop loss` (new position only) | `Available cash`               |
| Sale                | the log, shrinks or removes the `Lots` rows it consumes, recomputes `Volume` and `Avg price`, deletes the position with its last lot | `Available cash`               |
| Stop change         | the log                                                                                                                              | the `Stop loss` cell           |
| Any sync            | -                                                                                                                                    | `last_manual_sync`             |

So you no longer edit position rows. What you do is **reconcile**: after the events, compare each
position's `Volume` with your broker. If they differ (a split, a partial fill, a trade you never
recorded), correct `Lots` by hand so that the `Units` of a ticker's lots add up to the broker's
figure, and commit that on its own, as a correction commit. Editing `Volume` alone does not work:
`decision:record` refuses a portfolio whose `Volume` is not the sum of its lots' `Units`, or whose
lots disagree with the log, and reports everything it found in one round.

The engine rebuilds each silo's
value backwards from today's `portfolio.md` through the logged events, to compare you with the
[shadow portfolio](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#shadow-portfolio).
If the two disagree (a trade in the log that `portfolio.md` does not show, or the other way
round), the evaluation warns about negative cash or oversold units instead of reporting a wrong
number.

The engine fills in the rest: id, [rules version](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#rules-version), [benchmark price](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#benchmark),
rules broken, and the system
proposal the trade follows (that sets its `origin`). Omit `date` for today; give it (`YYYY-MM-DD`)
when you record something that happened earlier.

## Order that keeps the P&L right

Order the events by date; within a date, flows first. Process them in that order, and commit the
log and `portfolio.md` together.

1. **Money in or out, and currency conversions, first within their date.** Later buys are funded by them, and the
   shadow portfolio buys its benchmark with every flow on its own date, so a wrong or missing date
   shifts the comparison.
2. **Buys and sales, in the order they happened.** Record each with its command; the engine
   adds the lot and the position for a buy, and takes the result from the lots' own entry prices
   for a sale, so the order against your own edits does not matter. A sale dated before a lot it
   would consume is refused. The order does matter between trades of the same ticker: a sale
   consumes the oldest lot first, and the log has no time of day, so the order in which you run
   the commands is the order of two trades on the same date. For a sale followed by a buy-back of
   the same ticker on the same day, record the sale first: the other way round, a sale larger than
   your older lots would consume the lot you have just bought.
3. **A stop change:** record it, then edit the `Stop loss` cell.
4. **Cash and timestamp:** set `Available cash` (and `Total cash`, if you keep it) to the
   broker's figures and `last_manual_sync` to now (ISO, UTC). This is the step that silences the
   stale warning.
5. **Reconcile** each position's `Volume` against the broker (see above).

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

Give `price` and either `amount` or `units` (if you give both they must agree to the cent), plus
the initial `stop`: the base every [R](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#r)
is measured against.

```json
{ "type": "entry", "ticker": "KO", "currency": "USD", "price": 62, "units": 5, "stop": 58 }
```

`decision:record` adds the buy as a new row in `Lots` and creates the ticker's row in
`Positions` (with the stop as `Stop loss`), or, if you already hold the ticker, updates its
`Volume` and its weighted `Avg price`. **A second buy of a held ticker is a new lot**, a trade of
its own: its R is measured from its own price and stop, and the first lot is not touched. The
engine does not touch cash: lower `Available cash` by what the buy cost.

When you add to a position you already hold (a scale-in), `decision:record` writes the second
buy's `stop` into its lot only. It leaves the position's `Stop loss` cell as it was, so if the
stop of the position changes with the buy, edit `Stop loss` by hand.

Every buy is checked against the watchlist, the [setup](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#setup) and the stop, and the rules it breaks are
recorded with it as these codes:

- `not_in_watchlist`: the ticker is not in `watchlist.md` for that silo;
- `entry_without_setup`: it is in the watchlist but no system setup
  (proposal or armed breakout) precedes the buy. The two codes never come together: the first
  one wins;
- `no_stop`: you gave no `stop`;
- `stop_below_min_atr`: the stop is closer to the price than the minimum distance in ATR
  (`STOP_MIN_ATR`; checked only when the ATR can be fetched);
- `overrode_block`: the buy follows a `buy_blocked` proposal of the system.

A buy that follows a system proposal or an armed breakout within 10 days is attributed to the
system (`origin` `sistema`). Any other buy is yours (`propietario`), and so is one that follows a
`buy_blocked` proposal. The buy needs `portfolio.md` to exist: without it the lot would be lost,
so it is refused.

### Sell

Give `price` and `amount` or `units`. `decision:record` sells the ticker's lots first in, first
out (the oldest entry first) and writes one `exit` per lot it consumes, each with its own result
from that lot's entry price. It removes a lot it uses up, shrinks the one it only partly sells,
recomputes `Volume` and `Avg price`, and deletes the position's row with its last lot. A sale of a
ticker with no lots, or of more units than are open, is refused and nothing is recorded: first
reconcile `Lots` with the broker.

```json
{ "type": "exit", "ticker": "SAP.DE", "currency": "EUR", "price": 195, "units": 2, "costs": 1.5 }
```

Do not pass `related_id` on a sale: the lots decide which entries it closes, and the command
refuses it. Set `origin` to `sistema` only when the engine cannot infer that you followed its sell
proposal. Add `pnl` only if you want to override the computed result: that figure is
`(price - entry price) * units` per lot and ignores `costs`, so pass `pnl` explicitly if you want
it net of fees (the two-month rule triggers on `pnl < 0`).

### Stop change

`stop` is the new level. Record it, then edit the `Stop loss` cell of the position: this event
changes no table. A stop that your broker executed is a sale: record an `exit` at the fill price
instead.

```json
{ "type": "adjust_stop", "ticker": "KO", "currency": "USD", "stop": 60 }
```

## Checking your work

- `npm run decisions:evaluate` rewrites `logs/decisions-evaluation.md`; a silo that does not
  reconcile shows a warning there.
- A mistake in the log is fixed in a dedicated commit that edits that one line, when no automated
  run is in flight. The same goes for `Lots`: a hand correction is a commit of its own, so the
  history shows what you changed and why.

Old logs and queue files are covered in [Log retention](https://github.com/alvaromongon/finance-agent/blob/main/docs/log-retention.md).
