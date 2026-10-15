// Output catalogs by language: every text the user reads —
// emails, reports, notes the engine writes — comes from here. Text the engine
// reads back (headings it parses, frontmatter keys) is format, not output, and
// is not localized.
import { config, type OutputLanguage } from "../config.js";
import { en } from "./en.js";
import { es } from "./es.js";

/** The shape of a catalog: the English one's, so every language has every key. */
export type Messages = typeof en;

const CATALOGS: Record<OutputLanguage, Messages> = { en, es };

/** Catalog for `language`; by default the configured one (OUTPUT_LANGUAGE). */
export function messages(language: OutputLanguage = config.output.language()): Messages {
  return CATALOGS[language];
}

const LANGUAGE_NAMES: Record<OutputLanguage, string> = { en: "English", es: "Spanish" };

/**
 * Closing line of every prompt to the reasoner. Prompts are in English; what
 * the reasoner writes for the owner comes back in the configured language,
 * while everything the engine parses keeps the shape its instructions give.
 */
export function responseLanguageInstruction(language: OutputLanguage = config.output.language()): string {
  return (
    `Write every free-text field of your answer in ${LANGUAGE_NAMES[language]}. ` +
    "Keep JSON keys, enum values, section headings and machine-readable lines exactly as your instructions specify."
  );
}

/** Number with exactly `decimals` decimals, in the catalog's locale. */
export function formatNumber(m: Messages, n: number, decimals = 2): string {
  return n.toLocaleString(m.locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
