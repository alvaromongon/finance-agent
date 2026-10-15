// Smoke test: checks the external services separately, without touching the
// vault or sending emails. Useful to check connectivity before setting up Actions.
//
//   cp .env.example .env   # fill in your keys
//   npm run smoke-test
//
// - Yahoo Finance: works without any key.
// - Anthropic: only runs if ANTHROPIC_API_KEY is set; otherwise it is skipped.
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { YahooFinanceProvider } from "./providers/yahoo-finance.js";

// Liquid, well-known symbols from both silos: only connectivity is checked.
const TICKERS = ["SAP.DE", "AIR.PA", "KO", "JNJ"];

let failures = 0;

async function testYahoo(): Promise<void> {
  console.log("\n── Yahoo Finance ──────────────────────────────");
  try {
    const provider = new YahooFinanceProvider();
    const prices = await provider.getPrices(TICKERS);
    for (const t of TICKERS) {
      const p = prices.get(t);
      if (p != null) {
        console.log(`  ✓ ${t.padEnd(8)} ${p}`);
      } else {
        console.log(`  ✗ ${t.padEnd(8)} no price`);
        failures++;
      }
    }
    if (prices.size === 0) failures++;
  } catch (err) {
    console.error("  ✗ Error querying Yahoo Finance:", err);
    failures++;
  }
}

async function testAnthropic(): Promise<void> {
  console.log("\n── Anthropic (Claude) ─────────────────────────");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("  ⚠ ANTHROPIC_API_KEY not set — test skipped.");
    console.log("    Add it to your local .env to test the connection.");
    return;
  }
  try {
    const client = new Anthropic({ apiKey });
    const model = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";
    const res = await client.messages.create({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with just the word: OK" }],
    });
    const text = res.content.find((b) => b.type === "text");
    const reply = text?.type === "text" ? text.text.trim() : "(no text)";
    console.log(`  ✓ Model ${model} replied: "${reply}"`);
  } catch (err) {
    console.error("  ✗ Error calling Anthropic:", err);
    failures++;
  }
}

async function main(): Promise<void> {
  console.log("Finance Agent — smoke-test");
  await testYahoo();
  await testAnthropic();

  console.log("\n───────────────────────────────────────────────");
  if (failures > 0) {
    console.log(`Result: ${failures} failure(s). Check what is marked with ✗.`);
    process.exitCode = 1;
  } else {
    console.log("Result: all OK ✓");
  }
}

void main();
