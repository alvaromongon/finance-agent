// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { ScreeningResult } from "../utils/screening-helpers.js";
import type { ConvictionPoint } from "../types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyIndex,
  buildFriendlySummaryLines,
  buildScreeningEmailLines,
  buildScreeningEmailSubject,
  hasPendingExitCriteria,
  findTickersWithPendingExitCriteria,
  selectionWarningLines,
} from "../utils/screening-helpers.js";
import { en } from "../i18n/en.js";
import { SPANISH } from "./fixtures/spanish.js";
import { parseTicker as tk } from "../ticker.js";

describe("selectionWarningLines", () => {
  it("in English", () => {
    const text = selectionWarningLines(
      {
        fallbackReason: { code: "low_coverage", withData: 100, total: 190 },
        eligibleBySilo: { EUR: 0, USD: 3 },
        selectedBySilo: { EUR: 0, USD: 0 },
      },
      en,
    ).join("\n");
    assert.match(
      text,
      /NO RANKING: only 100 of 190 assets with data\. Candidates were drawn as before the ranking existed/,
    );
    assert.match(text, /EUR SILO WITHOUT CANDIDATES: no asset of the silo passes filter 0\./);
    assert.match(
      text,
      /USD SILO WITHOUT CANDIDATES: the 3 eligible in the ranking are in the watchlist or were rejected recently\./,
    );
    assert.doesNotMatch(text, SPANISH);
  });

  it("no warnings if there was a ranking and both silos have candidates", () => {
    assert.deepEqual(
      selectionWarningLines({
        fallbackReason: null,
        eligibleBySilo: { EUR: 20, USD: 60 },
        selectedBySilo: { EUR: 5, USD: 7 },
      }),
      [],
    );
  });

  it("with a ranking, tells a silo without eligibles apart from one with all eligibles excluded", () => {
    const text = selectionWarningLines({
      fallbackReason: null,
      eligibleBySilo: { EUR: 0, USD: 3 },
      selectedBySilo: { EUR: 0, USD: 0 },
    }).join("\n");
    assert.match(text, /SILO EUR SIN CANDIDATOS: ningún valor del silo pasa el filtro 0\./);
    assert.match(
      text,
      /SILO USD SIN CANDIDATOS: los 3 elegibles del ranking están en watchlist o descartados hace poco\./,
    );
    assert.doesNotMatch(text, /SIN RANKING/);
  });

  it("without a ranking, gives the reason and warns about the silos where no drawn candidate passes filter 0", () => {
    const text = selectionWarningLines({
      fallbackReason: { code: "low_coverage", withData: 100, total: 190 },
      selectedBySilo: { EUR: 0, USD: 7 },
    }).join("\n");
    assert.match(text, /SIN RANKING: solo 100 de 190 valores con datos\./);
    assert.match(text, /SILO EUR SIN CANDIDATOS: ningún valor sorteado del silo pasa el filtro 0\./);
    assert.doesNotMatch(text, /SILO USD/);
  });
});

describe("classifyIndex", () => {
  it("classifies NYSE/NASDAQ as S&P 500", () => {
    assert.equal(classifyIndex({ market: "NYSE", currency: "USD" }), "S&P 500");
    assert.equal(classifyIndex({ market: "NASDAQ", currency: "USD" }), "S&P 500");
  });

  it("classifies European markets as Eurostoxx 50", () => {
    assert.equal(classifyIndex({ market: "Euronext Paris", currency: "EUR" }), "Eurostoxx 50");
    assert.equal(classifyIndex({ market: "BME", currency: "EUR" }), "Eurostoxx 50");
  });

  it("classifies asset_class=commodity as Commodities regardless of the market", () => {
    assert.equal(classifyIndex({ market: "Xetra", currency: "EUR", asset_class: "commodity" }), "Commodities");
  });

  it("regression: a Xetra ETC without asset_class should NOT be labeled any more, but if the field were missing it falls back to the old heuristic", () => {
    // Documents the old behavior for a Xetra ticker without
    // asset_class: it falls into "Eurostoxx 50" (original heuristic). That is why
    // the commodities universe ALWAYS sets asset_class: commodity.
    assert.equal(classifyIndex({ market: "Xetra", currency: "EUR" }), "Eurostoxx 50");
  });
});

describe("buildScreeningEmailLines", () => {
  const result = (over: Partial<ScreeningResult>): ScreeningResult => ({
    ticker: tk("NVDA"),
    name: "NVIDIA",
    index: "S&P 500",
    currency: "USD",
    currentPrice: 100,
    interesting: true,
    conviction: "medium",
    convictionPoints: ["regime_favorable", "dated_catalyst"],
    reason: "Motivo.",
    thesis: "Tesis de IA.",
    horizon: "medium",
    nextCatalyst: "Earnings 19 nov 2026",
    invalidation: ["Recorte del capex de IA"],
    setups: [],
    rank: 2,
    ...over,
  });
  const ctx = { today: "2026-10-03", overdueReview: null, pendingExitCriteria: [] };

  it("in English", () => {
    const text = buildScreeningEmailLines(
      [
        result({ reason: "AI leader.", thesis: "AI capex thesis.", nextCatalyst: "Earnings 19 Nov 2026" }),
        result({
          ticker: tk("KO"),
          name: "Coca-Cola",
          interesting: false,
          reason: "No setup in sight.",
          rank: undefined,
          exploration: true,
        }),
      ],
      { ...ctx, overdueReview: "2026-09-30", pendingExitCriteria: ["NVDA"] },
      en,
    ).join("\n");
    assert.match(text, /Analyzed: 2 \| Added to watchlist: 1 \| Rejected: 1/);
    assert.match(text, /NVDA — NVIDIA {2}\[conviction: medium \(favorable regime, dated catalyst\) · ranking #2\]/);
    assert.match(text, /It will only be bought with a setup/);
    assert.match(text, /KO {10} \[exploration\] No setup in sight\./);
    assert.match(text, /REMINDER: THESES WITHOUT AN EXIT CRITERION/);
    assert.doesNotMatch(text, SPANISH);
    assert.equal(buildScreeningEmailSubject([result({})], en), "[Finance Agent] Screening — 1 new in watchlist");
  });

  it("separates the interesting ones with a current setup from those left to watch", () => {
    const text = buildScreeningEmailLines(
      [
        result({
          ticker: tk("AMD"),
          name: "AMD",
          setups: ["AMD: ruptura ARMADA — Buy Stop en 180 USD, objetivo 210 — ELEGIBLE"],
        }),
        result({}),
      ],
      ctx,
    ).join("\n");
    const [withSetup, watch] = text.split("── VIGILAR");
    assert.match(withSetup, /── CON SETUP ACTIVO O ARMADO/);
    assert.match(withSetup, /AMD — AMD/);
    assert.match(withSetup, /Setup: AMD: ruptura ARMADA — Buy Stop en 180 USD/);
    assert.doesNotMatch(withSetup, /NVDA/);
    assert.match(
      watch,
      /NVDA — NVIDIA {2}\[convicción: medium \(régimen favorable, catalizador fechado\) · ranking #2\]/,
    );
  });

  it("skips the empty section and no longer carries market notes", () => {
    const text = buildScreeningEmailLines([result({})], ctx).join("\n");
    assert.doesNotMatch(text, /CON SETUP ACTIVO/);
    assert.doesNotMatch(text, /Notas:/);
  });
});

describe("buildFriendlySummaryLines", () => {
  const base = {
    ticker: tk("BAS.DE"),
    name: "BASF",
    conviction: "medium" as const,
    convictionPoints: ["top_quintile", "regime_favorable"] as ConvictionPoint[],
    setups: [],
    thesis: "Tesis de reestructuración.",
    reason: "Motivo técnico.",
    nextCatalyst: null,
  };

  it("explains that a setup, not a zone, decides the buy", () => {
    const lines = buildFriendlySummaryLines(base);
    assert.ok(lines.some((l) => l.includes("setup") && l.includes("ADR-0013")));
  });

  it("shows the conviction with the rubric points behind it", () => {
    const lines = buildFriendlySummaryLines(base);
    assert.equal(lines[0], "BAS.DE — BASF  [convicción: medium (quintil superior, régimen favorable)]");
    assert.equal(
      buildFriendlySummaryLines({ ...base, convictionPoints: [], conviction: "low" })[0],
      "BAS.DE — BASF  [convicción: low]",
    );
  });

  it("with current setups lists them instead of the waiting sentence", () => {
    const lines = buildFriendlySummaryLines({
      ...base,
      setups: ["BAS.DE: retroceso en tendencia confirmado a 45 EUR — ELEGIBLE"],
    });
    assert.ok(lines.includes("Setup: BAS.DE: retroceso en tendencia confirmado a 45 EUR — ELEGIBLE"));
    assert.ok(!lines.some((l) => l.includes("ADR-0013")));
  });

  it("uses the thesis when there is one, not the technical reason", () => {
    const lines = buildFriendlySummaryLines(base);
    assert.ok(lines.includes("Tesis de reestructuración."));
  });

  it("falls back to the technical reason if there is no thesis", () => {
    const lines = buildFriendlySummaryLines({ ...base, thesis: null });
    assert.ok(lines.includes("Motivo técnico."));
  });

  it("includes the next catalyst only if present", () => {
    const withCatalyst = buildFriendlySummaryLines({ ...base, nextCatalyst: "Earnings ~ago 2026" });
    assert.ok(withCatalyst.some((l) => l.includes("Earnings ~ago 2026")));

    const withoutCatalyst = buildFriendlySummaryLines(base);
    assert.ok(!withoutCatalyst.some((l) => l.startsWith("Próximo catalizador")));
  });
});

describe("hasPendingExitCriteria", () => {
  it("detects exit_criteria: pending in the frontmatter", () => {
    assert.equal(
      hasPendingExitCriteria("---\nschema_version: 1\nexit_criteria: pending\n---\n## Cuándo dejaría de ser válida\n"),
      true,
    );
  });

  it("detects nothing without the field, even if the body says it is pending", () => {
    assert.equal(
      hasPendingExitCriteria(
        "---\nschema_version: 1\n---\n## Cuándo dejaría de ser válida\n\nSi rompe soporte en 41.4 con volumen alto.\n",
      ),
      false,
    );
    assert.equal(
      hasPendingExitCriteria("---\nschema_version: 1\n---\n(pendiente de definir — completar manualmente)\n"),
      false,
    );
  });
});

describe("findTickersWithPendingExitCriteria", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "screening-helpers-test-"));
    await mkdir(join(dir, "tesis"), { recursive: true });
    const thesisNote = (status: string, pending: boolean) =>
      `---\nschema_version: 1\nstatus: ${status}\n${pending ? "exit_criteria: pending\n" : ""}---\n## Cuándo dejaría de ser válida\n`;

    await Promise.all([
      // active with placeholder → must appear
      writeFile(join(dir, "tesis", "tesis-basde.md"), thesisNote("active", true)),
      // archived with placeholder → must NOT appear
      writeFile(join(dir, "tesis", "tesis-vst.md"), thesisNote("archived", true)),
      // active with the criterion already filled in → must NOT appear
      writeFile(join(dir, "tesis", "tesis-nem.md"), thesisNote("active", false)),
      // file that is not a thesis → ignored
      writeFile(join(dir, "tesis", "watchlist.md"), "# Watchlist"),
    ]);
  });

  after(async () => {
    await rm(dir, { recursive: true });
  });

  it("returns only the active tickers with an unfilled placeholder", async () => {
    const pending = await findTickersWithPendingExitCriteria(dir);
    assert.deepEqual(pending, ["BASDE"]);
  });

  it("returns an empty array in a directory without thesis files", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "screening-helpers-empty-"));
    try {
      assert.deepEqual(await findTickersWithPendingExitCriteria(emptyDir), []);
    } finally {
      await rm(emptyDir, { recursive: true });
    }
  });

  it("returns an empty array for a nonexistent directory", async () => {
    assert.deepEqual(await findTickersWithPendingExitCriteria("/tmp/no-existe-jamas"), []);
  });

  it("rejects a thesis without schema_version, naming the file", async () => {
    const oldDir = await mkdtemp(join(tmpdir(), "screening-helpers-old-"));
    try {
      await mkdir(join(oldDir, "tesis"));
      await writeFile(join(oldDir, "tesis", "tesis-old.md"), "---\nstatus: active\n---\n");
      await assert.rejects(findTickersWithPendingExitCriteria(oldDir), /tesis\/tesis-old\.md.*schema_version/);
    } finally {
      await rm(oldDir, { recursive: true });
    }
  });
});
