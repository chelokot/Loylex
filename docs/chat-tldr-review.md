# Chat TL;DR improvement

Reviewed public `ExposedCat/context-tg` at
`ed38ad2f89b01972d3967f9c2d3a9c9ed0c4d795` on 2026-10-09. Read the normal
agent definition, prompt-message formatter, and chat context paths. The normal
agent offers `search_chat`, `get_message_context`, and `read_last_messages`;
its instructions emphasize intent, surrounding topic context, concise informative
responses, and tables for comparisons. No dedicated dispute-summary algorithm
was found in those paths. Public source does not establish the deployed revision,
model settings, tool calls, or cause of any particular live response.

The reusable improvement is a narrow repository skill: recover the discussion's
opening, trace original claims and clarifications, separate dimensions such as
productivity and enjoyment, and distinguish substantive disagreement from answers
to different questions. It changes no model, authentication, routing, dependency,
or runtime integration. Existing AGENTS.md skill discovery applies to summary work.

Behavioral review used a bounded chronological archive range whose results were
not truncated. Source messages supported three distinct topics and a late
clarification of the societal-habituation claim. The review confirmed that a
summary must retain both a participant's reduced enjoyment and acknowledged
benefit from less routine work; neither entails rejection of the technology.
No private transcript or participant identifiers are stored here.

Reusable counterexamples for manual review:

- A says automation saves time; B agrees but enjoys the job less. Preserve both
  dimensions; do not frame B as denying the time savings.
- A predicts continuing rapid change; B predicts the technology becomes socially
  ordinary. Explain that familiarity and technical change can coexist without
  claiming they agree on the scale or consequences of future change.
- A cites successful adopters; B reports pressure on a profession. Neither example
  alone settles a universal income claim. Attribute the claims without inventing
  a winner.
- A late clarification narrows an earlier broad statement. Summarize the clarified
  position rather than repeating an opponent's earlier interpretation.

Validation: review the complete skill diff, frontmatter validation, repository
checks, and a live summary using the reconstructed discussion. Quality remains a
behavioral judgment; passing software checks cannot promise superior summaries.
Rollback is a normal revert of the skill addition.
