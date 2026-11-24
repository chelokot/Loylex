import type { AgentEvent } from "../shared/types.ts";

export function eventStatusLine(event: AgentEvent): string {
  const text =
    event.kind === "command" || event.kind === "tool"
      ? event.text.replaceAll(/\s+/g, " ").trim()
      : event.text.trim();
  if (event.kind !== "tool" || !event.toolCallId) {
    return `${event.kind}: ${text}`;
  }
  const toolCallId = Array.from(event.toolCallId)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f && character !== "[" && character !== "]";
    })
    .join("")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return toolCallId ? `${event.kind}: ${text} [tool-call:${toolCallId}]` : `${event.kind}: ${text}`;
}
