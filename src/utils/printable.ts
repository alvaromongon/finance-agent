// Owner-supplied text as it is printed to the terminal (S4): the one escaping every message of the engine uses.

/**
 * `text` as a JSON string, quotes included: every control character (an ANSI sequence must not reach the
 * terminal), every double quote and every backslash is written as an escape sequence; the rest is left as it is.
 * A value that is not text (a YAML scalar of any type) is written the way JSON writes it, escaped the same.
 */
export const quoted = (value: unknown): string => JSON.stringify(value) ?? String(value);

/** `quoted` without its quotes, for text that is already inside a sentence or a name. */
export const printable = (text: string): string => quoted(text).slice(1, -1);
