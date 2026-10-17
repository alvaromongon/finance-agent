// Loads and validates the configuration from environment variables.
import "dotenv/config";
import { DEFAULT_MAX_SESSION_AGE_HOURS } from "./utils/market-session.js";
import { MIN_STOP_ATR } from "./utils/atr-stop.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  // Treat an empty string as absent: in GitHub Actions an undefined secret is
  // injected as "" (not undefined), and we want the fallback in that case.
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

function optionalNoDefault(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const v = optional(name, String(fallback)).toLowerCase();
  if (v !== "true" && v !== "false") {
    throw new Error(`Environment variable ${name}="${v}" is neither true nor false`);
  }
  return v === "true";
}

/** Languages of the user-facing output: one catalog per language in `src/i18n/`. */
export const OUTPUT_LANGUAGES = ["en", "es"] as const;
export type OutputLanguage = (typeof OUTPUT_LANGUAGES)[number];

function optionalLanguage(name: string, fallback: OutputLanguage): OutputLanguage {
  const v = optional(name, fallback).trim().toLowerCase();
  if (!(OUTPUT_LANGUAGES as readonly string[]).includes(v)) {
    throw new Error(
      `Environment variable ${name}="${process.env[name]}" is invalid (values: ${OUTPUT_LANGUAGES.join(" | ")})`,
    );
  }
  return v as OutputLanguage;
}

// Fail at startup on an invalid language, before the run does any work: a
// heartbeat that only failed at its first render would lose its email.
optionalLanguage("OUTPUT_LANGUAGE", "en");

function optionalNumber(name: string, fallback: string): number {
  const v = optional(name, fallback);
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Environment variable ${name}="${v}" is not a valid number`);
  }
  return n;
}

export const config = {
  marketData: {
    // Market price provider. Change it here + GitHub Secrets to switch the
    // source without touching business logic.
    provider: optional("MARKET_DATA_PROVIDER", "yahoo-finance"),
    // Directory of the "fixtures" provider: one <TICKER>.json per ticker.
    fixturesDir: () => required("MARKET_FIXTURES_DIR"),
    // Maximum age (days) of portfolio.md before warning that it is stale.
    portfolioStaleDays: optionalNumber("PORTFOLIO_STALE_DAYS", "7"),
    // Maximum age (hours) of the last market tick to consider the session
    // current. See utils/market-session.ts for the choice of default: it
    // tolerates delayed Actions crons and still detects holidays.
    maxSessionAgeHours: optionalNumber("MARKET_SESSION_MAX_AGE_HOURS", String(DEFAULT_MAX_SESSION_AGE_HOURS)),
  },
  analyst: {
    // Escalation backend: "api" (calls Anthropic with ANTHROPIC_API_KEY, paid)
    // or "handoff" (issue 2/4: writes logs/pending/ for a Claude Code Routine
    // to resolve, no API cost). Change it here + GitHub vars to go back to
    // "api" without touching code if it pays off in the future.
    provider: optional("ANALYST_PROVIDER", "api"),
  },
  claude: {
    apiKey: () => required("ANTHROPIC_API_KEY"),
    model: optional("CLAUDE_MODEL", "claude-sonnet-4-6"),
    // Reasoning depth (adaptive thinking): low | medium | high | max.
    // Replaces the old budget_tokens (deprecated in Sonnet 4.6, rejected in
    // Opus 4.7+/Fable 5).
    effort: optional("CLAUDE_EFFORT", "high"),
    // Native web search in the reasoner (claude-analyst.ts) for the big_move
    // trigger: there the question is "what happened today?".
    analystWebSearch: optional("ANALYST_WEB_SEARCH", "true") === "true",
  },
  mail: {
    // Outgoing transport: "none" (email switched off: nothing is sent and
    // nothing fails, even with requireDelivery), "smtp" (direct send, GitHub Actions) or "outbox"
    // (writes the email as a file in logs/outbox/ for the
    // finance-agent-email-relay workflow to send — Routines cloud
    // environments, where the egress proxy only tunnels port 443 and direct
    // SMTP cannot connect). Values validated fail-fast in
    // mailer.ts. Lazy (like smtpUser/smtpPass) so tests can vary the
    // transport without re-importing the module.
    transport: () => optional("MAIL_TRANSPORT", "smtp"),
    // Mandatory delivery: when true, an email that cannot be delivered aborts
    // the run instead of degrading to "logs only" mode. The workflows that
    // really send (heartbeat, briefing, screening, relay) turn it on; locally
    // and in tests it stays false, where running without SMTP credentials is
    // legitimate. Lazy for the same reason as `transport`.
    requireDelivery: () => optional("MAIL_REQUIRE_DELIVERY", "false") === "true",
    smtpHost: optional("SMTP_HOST", "smtp.gmail.com"),
    smtpPort: optionalNumber("SMTP_PORT", "465"),
    smtpUser: () => required("SMTP_USER"),
    smtpPass: () => required("SMTP_PASS"),
    // Recipient and sender, without defaults: without a recipient
    // the email is not sent ("logs only" mode, like without credentials). The
    // sender falls back to the SMTP account. Lazy like the credentials.
    to: () => optionalNoDefault("ALERT_EMAIL_TO"),
    from: () => optionalNoDefault("ALERT_EMAIL_FROM") ?? optionalNoDefault("SMTP_USER"),
  },
  output: {
    // Language of what the user reads: emails, reports and notes the engine
    // writes. What the engine reads back is not localized: it is
    // format. Lazy so tests can set it per file.
    language: () => optionalLanguage("OUTPUT_LANGUAGE", "en"),
  },
  strategy: {
    stopProximityPct: optionalNumber("STOP_PROXIMITY_PCT", "3"),
    // Minimum stop distance in multiples of ATR14. Below it, the
    // heartbeat warns that noise will hit the stop. It blocks nothing: the
    // owner sets the real stop at their broker.
    stopMinAtr: optionalNumber("STOP_MIN_ATR", String(MIN_STOP_ATR)),
    bigMovePct: optionalNumber("BIG_MOVE_PCT", "5"),
    reanalysisPriceDeltaPct: optionalNumber("REANALYSIS_PRICE_DELTA_PCT", "3"),
  },
  // Swing-with-cutoff framework (ADR-0009). No environment variables on
  // purpose: changing a value is a rules change and goes through change
  // control (hypothesis, sample and `version` in strategies/base.md), not a
  // var. Read by utils/sizing.ts, decision.ts, the evaluation and the screening ranking and
  // utils/market-regime.ts.
  framework: {
    /** Loss down to the initial stop, in % of the silo value (cash + positions). */
    riskPerTradePct: 1,
    /** Hard cap on a position size, in % of the silo value. It also sets the USD buffer. */
    maxPositionPct: 25,
    /** Minimum R:R net of costs on the planned target; below it, `buy_blocked`. */
    minRewardRisk: 2,
    /** Drawdown from the silo NAV peak (net of flows) that pauses new entries. */
    drawdownPausePct: 15,
    /** Trades closed under C v1, both silos combined. */
    cutReviewTrades: 30,
    cutDecisionTrades: 50,
    /** Market regime per silo (ADR-0010): "SMA50 rising" = higher than this many sessions ago. */
    regime: { sma50SlopeSessions: 20 },
    /** Heartbeat setup detectors (ADR-0013): the only way in. */
    setups: {
      pullback: {
        /** Moving averages the pullback can touch. */
        smaPeriods: [20, 50],
        /** Sessions before today in which to look for the touch (N). */
        touchSessions: 5,
        /** Prior sessions in which to look for the high that is the pattern target. */
        swingSessions: 20,
      },
      breakout: {
        /** Base sessions (N). */
        baseSessions: 15,
        /** Maximum base range (high − low), in ATR14 (X). */
        maxBaseAtr: 3,
        /** The top of the base, at most this % below the 52-week high. */
        nearHighPct: 5,
        /** Breakout session volume against the `volumeSessions` average. */
        volumeMultiple: 1.5,
        volumeSessions: 50,
        /** Sessions before the base in which to measure the pole: target = top + pole. */
        poleSessions: 40,
      },
    },
    /** Weekly screening funnel (ADR-0012): filter 0, ranking and exploration. */
    screening: {
      /** Minimum sessions in the last Yahoo year: ≥ 1 year of history. */
      minSessions: 240,
      /** Median traded value (close × volume), in the security currency. */
      minMedianTurnover: 500_000,
      turnoverSessions: 50,
      /** Maximum calendar days since the last session: the data must be from this week. */
      maxStaleDays: 5,
      /** 6-month relative strength against the silo benchmark. */
      relativeStrengthSessions: 126,
      /** Top of the ranking per silo, exploration not included. */
      rankedBySilo: { EUR: 4, USD: 6 },
      /** Random candidates among the eligible not in by ranking, per silo. */
      explorationBySilo: 1,
      /** Fallback draw without a reliable ranking, per universe block: the split from before the ranking existed. */
      fallbackDraw: { eur: 3, usd: 7, commodities: 2 },
      /**
       * Conviction rubric of an interesting candidate (ADR-0012 §7): one point
       * per condition; high with `high` points or more, medium with `medium`, low otherwise.
       */
      conviction: {
        /** Top fraction of the silo in the ranking (top quintile). */
        topFraction: 0.2,
        /** Minimum net R:R of some current setup of the candidate. */
        minRewardRisk: 3,
        high: 3,
        medium: 2,
      },
      /**
       * Mechanical watchlist exit (ADR-0012 §8): prepare applies it with the
       * run's ranking. What falls out of this top fraction of the silo is removed…
       */
      keepTopFraction: 0.5,
      /** …or has spent at least this many weeks in the watchlist without any setup. */
      noSetupWeeks: 4,
    },
    costs: {
      /** Transaction tax on stock (not ETF) purchases, by Yahoo suffix. */
      purchaseTaxPctBySuffix: { ".PA": 0.4, ".MC": 0.2, ".MI": 0.1 },
    },
  },
  // What the broker allows and charges, not rules (ADR-0001): the engine
  // integrates with none and does not need to know which one it is, because
  // the owner syncs portfolio.md by hand. That is why, unlike the framework,
  // these do come from environment variables.
  broker: {
    /** Fractional units. `false` = whole shares. */
    fractionalShares: optionalBoolean("BROKER_FRACTIONAL_SHARES", true),
    /** Minimum order amount with fractional shares, in the silo currency. */
    minOrderValue: optionalNumber("BROKER_MIN_ORDER_VALUE", "10"),
    /**
     * Currency exchange between accounts: the default `decision:record` fee.
     * The 0.8% weekend and holiday fee cannot be inferred from a date without a
     * time: in that case the owner gives `costs` (ADR-0009 §7).
     */
    fxConversionPct: optionalNumber("BROKER_FX_CONVERSION_PCT", "0.5"),
  },
  // Accumulating ETF per silo: shadow portfolio, regime and relative
  // strength (ADR-0009). The owner's choice, not a rule: it comes from the
  // environment and has no default. Read on use, so a command
  // that never touches a benchmark does not need it.
  reference: {
    get EUR(): string {
      return required("REFERENCE_TICKER_EUR");
    },
    get USD(): string {
      return required("REFERENCE_TICKER_USD");
    },
  },
  paths: {
    // Directory with the data files (the "brain"). Required and without a
    // default; read on use so tests can set it per file.
    get vaultProjectDir(): string {
      return required("VAULT_PROJECT_DIR");
    },
    // Archived quarters of logs/decisions.jsonl (ADR-0006). Unset = there is
    // no archive and only the live file is read.
    decisionsArchiveDir: () => optionalNoDefault("DECISIONS_ARCHIVE_DIR"),
  },
} as const;
