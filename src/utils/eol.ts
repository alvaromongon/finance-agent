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
