---
name: chat-tldr
description: Summarize a chat discussion or dispute (TL;DR, тлдр, итоги спора), preserving each participant's actual claims and identifying disagreements or crossed questions.
---

# Chat TL;DR

Reconstruct the argument, rather than compressing the latest insults or adjudicating
who won. A good summary lets someone who missed the conversation understand what
each side meant and where their answers diverged.

## Establish coverage

Use the requested reply target, participants, topic, and time range to define scope.
Recent injected context may contain only the end of a long dispute. If its opening
claim or a referenced example is missing, read the relevant chronological archive
range with `loylex query`; follow reply parents and extend backwards until the
opening is clear. Read `skills/telegram/SKILL.md` for the query contract. Check
`truncated` and paginate. Stop at the topic boundary, rather than summarizing
unrelated nearby conversations. State partial coverage when a gap remains.

Earlier bot summaries are interpretations to check against original participants'
messages, not substitutes for those messages.

## Reconstruct before writing

For each substantive topic, identify each participant's claim, their supporting
example, and any concession or later clarification. Keep message IDs as internal
evidence; include them in the answer only when useful or requested.

- Preserve distinctions between personal experience and a general claim, current
  conditions and predictions, possibility and inevitability, and improved speed,
  income, quality, or enjoyment. One does not establish the others.
- Describe a claim the other side actually made. Do not attribute the opponent's
  paraphrase, a hypothetical example, sarcasm, or an insult as a literal belief.
- Test whether the sides contradict each other on the same question. When they
  answer different questions, name both questions and explain the mismatch. Allow
  real disagreement and a mismatch to coexist; do not force every dispute into
  either category.
- Treat predictions as the speaker's predictions. Do not turn confidence or
  repetition into evidence, diagnose participants, or invent symmetrical blame.

## Deliver the summary

Lead with the actual subject and central disagreement. For several topics and two
or more positions, a compact topic-by-participant table is often useful; otherwise
use a short paragraph or bullets. Follow with the most consequential mismatch or
unresolved question and the outcome (agreement, remaining disagreement, or no
resolution). Omit repeated abuse and incidental banter. Mention escalation only
when it explains the outcome. A brief joke may close the answer when appropriate,
but must not supply a motive or distort a position.

Before sending, check that every attributed position has original-message support,
later clarifications survived compression, and the opening framing fits the whole
requested discussion. Separate your analysis from the participants' claims. A
summary request does not need outside fact-checking unless the user also asks for
an assessment of truth.
