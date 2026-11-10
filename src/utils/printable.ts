// Owner-supplied text as it is printed to the terminal (S4): the one escaping every message of the engine uses.

/**
 * `text` as a JSON string, quotes included: every control character (an ANSI sequence must not reach the
 * terminal), every double quote and every backslash is written as an escape sequence; the rest is left as it is.
 */
export const quoted = (text: string): string => JSON.stringify(text);

/** `quoted` without its quotes, for text that is already inside a sentence or a name. */
export const printable = (text: string): string => quoted(text).slice(1, -1);
