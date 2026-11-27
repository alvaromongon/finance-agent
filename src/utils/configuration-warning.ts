// The warning that a configuration file does not validate (#142), shared by the heartbeat digest and the briefing email.
import { messages, type Messages } from "../i18n/index.js";
import type { ConfigurationProblem } from "../configuration.js";
// A reason can quote the owner's file: it is printed escaped, so no control character reaches the email (S4).
import { printable } from "./printable.js";

/** The lines of the warning; none when every file validates. */
export function configurationWarningLines(
  problems: readonly ConfigurationProblem[],
  m: Messages = messages(),
): string[] {
  if (problems.length === 0) return [];
  const t = m.configurationWarning;
  return [
    ...t.intro,
    ...problems.flatMap((p) => [
      p.usingLastValid ? t.usingLastValid(p.file) : t.noLastValid(p.file),
      ...p.errors.map((e) => t.error(printable(e.field), printable(e.reason))),
    ]),
    ...t.outro,
  ];
}
