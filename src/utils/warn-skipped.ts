/**
 * What the readers that skip a row they cannot read do with the reason (ADR-0016): a console warning whose prefix
 * names the module that logs. Shared by the vault I/O module and the portfolio store.
 */
export function skippedWarner(module: string): (message: string) => void {
  return (message) => console.warn(`[${module}] WARNING: ${message}`);
}
