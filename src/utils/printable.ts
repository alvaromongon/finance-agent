// Owner-supplied text as it is printed to the terminal (S4): the one escaping every message of the inbox uses.

/**
 * `text` with the escapes of a JSON string and without its quotes: every control character (an ANSI sequence
 * must not reach the terminal), every double quote and every backslash is written as an escape sequence; the
 * rest is left as it is.
 */
export const printable = (text: string): string => JSON.stringify(text).slice(1, -1);
