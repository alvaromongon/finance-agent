import { canCountInCents, money, type Money } from "../money.js";
import type { Currency } from "../types.js";

/**
 * Converts a Markdown table cell to a number.
 * Tolerates currency symbols, thousands separators and the European decimal comma.
 * Returns null for empty cells, placeholders ("—") or non-numeric ones ("TBD", "N/A").
 */
export function parseMarkdownNumber(raw: string | undefined): number | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (!s || s === "—" || s === "-" || /^(tbd|n\/?a)$/i.test(s)) return null;

  s = s.replace(/[€$£%\s\u00A0]/g, ""); // strips currency, %, spaces (incl. NBSP)
  if (!s) return null;

  if (s.includes(",") && s.includes(".")) {
    // Both present: the rightmost separator is the decimal one.
    //   european "1.234,56" → decimal comma → "1234.56"
    //   us       "2,500.00" → decimal point → "2500.00"
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * `parseMarkdownNumber` for an amount of the silo's currency: made `Money` of it, so rounded to the cent. A number
 * too large to count in cents (`1e307`) is as unreadable as "TBD": `null`, never a throw out of the reader (#83).
 */
export function parseMarkdownMoney<C extends Currency>(raw: string | undefined, currency: C): Money<C> | null {
  const n = parseMarkdownNumber(raw);
  return n === null || !canCountInCents(n) ? null : money(n, currency);
}
