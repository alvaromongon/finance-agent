# Decision log

Architecture decisions, in [MADR](https://adr.github.io/madr/) format. One file per decision. An
accepted decision is never rewritten: a new ADR supersedes it.

ADRs 0001–0013 are retroactive: they record decisions taken while the engine lived in the private
repository it was extracted from, without the owner's personal data.

| ADR                                                                 | Title                                                                                                | Status     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------- |
| [0001](0001-public-engine-private-data.md)                          | Public engine, private data: the user's repo calls reusable workflows pinned to a tag                | Accepted   |
| [0002](0002-escalate-to-claude-only-after-deterministic-filters.md) | Cheap deterministic filters first; escalate to Claude only when a signal fires                       | Accepted   |
| [0003](0003-state-as-versioned-markdown.md)                         | State as versioned Markdown in a data directory; localized output                                    | Accepted   |
| [0004](0004-handoff-mode-for-the-reasoner.md)                       | Handoff mode: the engine prepares and resolves, an agent session reasons                             | Accepted   |
| [0005](0005-email-outbox-and-relay.md)                              | Email outbox and relay for environments that can't open SMTP                                         | Accepted   |
| [0006](0006-single-append-only-decision-log.md)                     | A single append-only decision log in JSON Lines, including decisions not to act                      | Accepted   |
| [0007](0007-portfolio-is-the-source-of-truth-for-risk-watch.md)     | Ownership is first-class: the portfolio decides what is watched for risk                             | Accepted   |
| [0008](0008-market-data-freshness.md)                               | Market data freshness: batch quotes, a session guard by tick age, and a direct stop-breach alert     | Deprecated |
| [0009](0009-swing-framework-risk-sizing-and-measurement.md)         | Swing framework: size by risk, measure in net R against one benchmark per silo, control rule changes | Accepted   |
| [0010](0010-deterministic-entry-eligibility-filter.md)              | A deterministic entry-eligibility filter: trend, momentum and market regime                          | Deprecated |
| [0011](0011-stops-sized-in-atr.md)                                  | Stops are sized in ATR and set by the engine                                                         | Deprecated |
| [0012](0012-screening-funnel.md)                                    | Screening funnel: filter 0, ranking with exploration, conviction rubric, mechanical watchlist exit   | Deprecated |
| [0013](0013-entry-setups.md)                                        | Entry setups: deterministic pullback and breakout detectors replace buy zones                        | Deprecated |
| [0014](0014-decision-quality-slo.md)                                | The SLO is the quality of the system's proposals against what actually happened                      | Accepted   |
| [0015](0015-open-lots-live-in-the-portfolio.md)                     | Open lots live in the portfolio, written by the engine; every exit carries a snapshot of its lot     | Proposed   |
| [0016](0016-domain-values-are-branded-types-made-by-parsing.md)     | Domain values are branded types made only by parsing at the boundary, compared with `===`            | Proposed   |

ADRs record architecture only: decisions that survive changes to the spec and the code. The rules and
parameters that change with the code live in [`docs/flows.md`](../flows.md); an ADR whose content is that
kind of detail is `Deprecated` with a link there, and keeps its text as history.

New decisions are proposed in a pull request with status `Proposed`.
