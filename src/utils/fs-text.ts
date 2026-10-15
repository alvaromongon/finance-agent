// Reading vault text with normalized line endings.
import { readFile } from "node:fs/promises";
import { normalizeEol } from "./parse.js";

/**
 * Reads a UTF-8 text file normalizing CRLF → LF.
 *
 * Single entry point for reading vault Markdown: so the `vault-parser.ts`
 * parsers and the ad-hoc regexes in the rest of the engine always see LF,
 * whether running on Linux (GitHub Actions) or on a Windows checkout.
 */
export async function readTextFile(path: string): Promise<string> {
  return normalizeEol(await readFile(path, "utf8"));
}
