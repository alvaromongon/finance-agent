/**
 * The engine's store of the portfolio as text (#132): plain decimal numbers, every amount with its currency, a
 * strict reader that refuses what it cannot read whole, and the Markdown view generated from it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { money } from "../money.js";
import { parseTicker as tk } from "../ticker.js";
import {
  decodeStore,
  encodeStore,
  plainDecimal,
  renderView,
  withLotChange,
  withPrices,
  type PortfolioStore,
} from "../utils/portfolio-json.js";
import { lot, stateOf } from "./fixtures/inbox.js";

const store = (): PortfolioStore => {
  const { EUR, USD } = stateOf(
    { eurCash: 1200, usdCash: 900.5 },
    {
      EUR: [
        lot("EUR", {
          ticker: "SAP.DE",
          units: 2,
          entryPrice: 180,
          initialStop: 168,
          entryId: "20260915-sapde-entry-ab12cd34",
        }),
      ],
      USD: [
        lot("USD", {
          ticker: "KO",
          units: 0.00000001,
          entryPrice: 0.00001234,
          entryCosts: money(1.5, "USD"),
          rulesViolations: ["no_stop", "overrode_block"],
        }),
      ],
    },
  );
  return {
    silos: { EUR: { ...EUR, totalCash: money(1300, "EUR") }, USD },
    accountEnv: "demo",
    unmoved: [{ file: "2026-11-12.yaml", sha256: "ab".repeat(32), at: "2026-11-12T10:00:00.000Z" }],
    pendingDecisions: ['{"id":"x","amount":1e-8}'],
  };
};

describe("plainDecimal: a number as plain decimal text that reads back as itself", () => {
  it("never writes an exponent", () => {
    assert.equal(plainDecimal(1e-8), "0.00000001");
    assert.equal(plainDecimal(-1.5e-7), "-0.00000015");
    assert.equal(plainDecimal(1.5e21), "1500000000000000000000");
    assert.equal(plainDecimal(12.5), "12.5");
    assert.equal(plainDecimal(0), "0");
    assert.equal(plainDecimal(-0), "0");
    assert.equal(plainDecimal(1234567.891), "1234567.891");
  });

  it("reads back as the same number", () => {
    for (const n of [1e-8, 4e-9, 0.1 + 0.2, 123456789.12345679, 2 ** -30, 1e21, 9.99e-7]) {
      assert.equal(Number(plainDecimal(n)), n);
      assert.doesNotMatch(plainDecimal(n), /e/i);
    }
  });

  it("refuses a number that is not finite", () => {
    assert.throws(() => plainDecimal(Number.NaN), RangeError);
    assert.throws(() => plainDecimal(Number.POSITIVE_INFINITY), RangeError);
  });
});

describe("the store text", () => {
  it("writes plain decimal numbers and every amount with its currency, and reads back what it wrote", () => {
    const text = encodeStore(store());
    // Not even in the decision lines in transit: they are held as the text the log writes, not as numbers.
    assert.doesNotMatch(text.replace(/"pending_decisions"[\s\S]*?\]/, ""), /\de-?\d/i, "no exponent in a number");
    assert.match(text, /"cash": "1200\.00 EUR"/);
    assert.match(text, /"entry_costs": "1\.50 USD"/);
    assert.match(text, /"units": "0\.00000001"/);
    assert.deepEqual(decodeStore(text, "state/portfolio.json"), store());
  });

  it("keeps a silo the portfolio does not have absent", () => {
    const only = { silos: { EUR: store().silos.EUR }, unmoved: [], pendingDecisions: [] } satisfies PortfolioStore;
    const read = decodeStore(encodeStore(only), "state/portfolio.json");
    assert.deepEqual(Object.keys(read.silos), ["EUR"]);
    assert.equal(read.accountEnv, undefined);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test edits a document of a shape it makes
  const mutate = (change: (doc: any) => void): string => {
    const doc = JSON.parse(encodeStore(store()));
    change(doc);
    return JSON.stringify(doc);
  };
  const refuses = (text: string, pattern: RegExp): void =>
    assert.throws(() => decodeStore(text, "state/portfolio.json"), pattern);

  it("refuses what it cannot read whole, naming the file and the field", () => {
    refuses("{not json", /state\/portfolio\.json: file: is not valid JSON/);
    refuses(
      mutate((d) => (d.schema_version = 2)),
      /schema_version: must be 1/,
    );
    refuses(
      mutate((d) => (d.silos.EUR.cash = "1200 EUR")),
      /silos\.EUR\.cash: must be an amount in cents and its currency/,
    );
    refuses(
      mutate((d) => (d.silos.EUR.cash = "1200.00 USD")),
      /silos\.EUR\.cash: is in USD, not in the silo's EUR/,
    );
    refuses(
      mutate((d) => (d.silos.USD.lots[0].units = "1e-8")),
      /silos\.USD\.lots\[0\]\.units: must be a plain decimal number/,
    );
    refuses(
      mutate((d) => (d.silos.EUR.positions[0].ticker = "TC|K")),
      /silos\.EUR\.positions\[0\]\.ticker/,
    );
    refuses(
      mutate((d) => (d.silos.EUR.lots[0].origin = "alguien")),
      /silos\.EUR\.lots\[0\]\.origin: unknown origin/,
    );
    refuses(
      mutate((d) => (d.silos.GBP = d.silos.EUR)),
      /silos\.GBP: is not a silo/,
    );
    refuses(
      mutate((d) => delete d.unmoved_batches),
      /unmoved_batches: must be a list/,
    );
    refuses(
      mutate((d) => (d.pending_decisions = [1])),
      /pending_decisions\[0\]: must be text/,
    );
  });
});

describe("the Markdown view", () => {
  it("is generated from the store: cash, positions and lots per silo, in the number format of each silo", () => {
    const view = renderView(store());
    assert.match(view, /^---\nschema_version: 2\nlast_manual_sync: 2026-10-01T00:00:00Z\naccount_env: demo\n---/);
    assert.match(view, /do not edit it/);
    assert.match(view, /\| Available cash \| 1200,00 € \|/);
    assert.match(view, /\| Total cash \| 1300,00 € \|/);
    assert.match(view, /\| Available cash \| \$900\.50 \|/);
    assert.match(view, /\| SAP\.DE \| 2 \| 180,00 \| 180,00 \| 0,00 \| 168,00 \|/);
    assert.match(view, /20260915-sapde-entry-ab12cd34 \| 2026-06-15 \| 2 \| 2 \| 180,00 \| 168,00 \| — \| propietario/);
    assert.match(view, /no_stop, overrode_block/);
  });

  it("leaves out a silo the portfolio does not have, and makes a cell that would break a row harmless", () => {
    const { EUR } = store().silos;
    const odd = { ...EUR!, lots: [{ ...EUR!.lots[0], rulesVersion: "1.0|x\ny" }] };
    const view = renderView({ silos: { EUR: odd }, unmoved: [], pendingDecisions: [] });
    assert.doesNotMatch(view, /USD/);
    assert.match(view, /\| 1\.0\/x\/y \|/);
  });
});

describe("the edits of a silo", () => {
  const silo = () => store().silos.EUR!;

  it("withLotChange: the lots replace the silo's, the position of the ticker is changed, created or deleted", () => {
    const sap = lot("EUR", { ticker: "SAP.DE", units: 3, entryPrice: 180, entryId: "second" });
    const more = withLotChange(silo(), [...silo().lots, sap], { ticker: tk("SAP.DE"), volume: 5, avgPrice: 180 });
    assert.equal(more.lots.length, 2);
    assert.deepEqual(
      more.positions.map((p) => [p.ticker, p.volume, p.avgPrice, p.stopLoss]),
      [["SAP.DE", 5, 180, 168]],
    );

    const bought = lot("EUR", { ticker: "BMW.DE", units: 1, entryPrice: 90, entryId: "bmw" });
    const created = withLotChange(silo(), [...silo().lots, bought], {
      ticker: tk("BMW.DE"),
      volume: 1,
      avgPrice: 90,
      newStopLoss: 80,
      currentPrice: 91,
    });
    assert.deepEqual(
      created.positions.map((p) => [p.ticker, p.volume, p.currentPrice, p.stopLoss]),
      [
        ["SAP.DE", 2, 180, 168],
        ["BMW.DE", 1, 91, 80],
      ],
    );

    const sold = withLotChange(silo(), [], { ticker: tk("SAP.DE"), volume: 0 });
    assert.deepEqual([sold.lots, sold.positions], [[], []]);
  });

  it("withPrices: current price and P/L of the priced positions, null when nothing changes", () => {
    const priced = withPrices(silo(), new Map([[tk("SAP.DE"), 171.25]]))!;
    assert.deepEqual(
      priced.positions.map((p) => [p.currentPrice, p.pl]),
      [[171.25, -17.5]],
    );
    assert.equal(withPrices(priced, new Map([[tk("SAP.DE"), 171.25]])), null);
    assert.equal(withPrices(silo(), new Map([[tk("OTHER"), 1]])), null);
    assert.equal(withPrices(silo(), new Map([[tk("SAP.DE"), Number.NaN]])), null);
  });

  it("withPrices keeps the P/L a row had when the new one is too large to count in cents", () => {
    const huge = withPrices(silo(), new Map([[tk("SAP.DE"), 1e307]]))!;
    assert.deepEqual(
      huge.positions.map((p) => [p.currentPrice, p.pl]),
      [[1e307, 0]],
    );
  });
});
