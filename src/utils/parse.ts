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
 * Normalizes line endings to `\n` (CRLF and lone CR included).
 *
 * The vault is edited from Windows, Android and Linux, and although
 * `.gitattributes` forces LF in the working tree, any file coming from outside
 * (an editor, an API response, a copy-paste) can bring CRLF. The
 * `vault-parser.ts` parsers anchor blocks with a literal `\n` (```yaml\n,
 * ^---\n), so an unnormalized CRLF does not fail loudly: it makes
 * `extractYamlBlock` throw and the `applyXWatchlistEntry` functions return the
 * Markdown untouched without warning.
 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
