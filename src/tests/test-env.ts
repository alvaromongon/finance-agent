// Environment shared by every test file (loaded with --import before each
// one). The engine has no defaults for personal values, so the
// tests give neutral ones; a file that needs them unset clears them itself.
process.env.REFERENCE_TICKER_EUR ||= "EXSA.DE";
process.env.REFERENCE_TICKER_USD ||= "VOO";
