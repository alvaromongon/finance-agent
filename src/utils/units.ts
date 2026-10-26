/**
 * Units are fractions: below this the difference between two quantities of units is float noise,
 * not a mismatch (nor units). The one definition, shared by the lots check, the lot arithmetic and
 * the evaluation of the exits.
 */
export const UNITS_TOLERANCE = 1e-8;
