// Spanish leaking into English output: accents, inverted marks and
// common words. A heuristic for "no Spanish left", not a language detector.
export const SPANISH = /[áéíóúñ¿¡]|\b(del|los|las|para|sin|objetivo|precio|en)\b/i;
