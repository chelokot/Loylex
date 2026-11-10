import type { AgentEvent } from "../shared/types.ts";
import type { GatewayClient } from "./gateway.ts";

// Progress is cosmetic: the final answer or failure is delivered separately. A rejected status
// update, such as a Telegram edit superseded by a newer one, must not fail the turn.
export async function reportProgress(
  gateway: Pick<GatewayClient, "event">,
  jobId: number,
  event: AgentEvent,
): Promise<void> {
  try {
    await gateway.event(jobId, event);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "warn",
        jobId,
        event: "progress_report_unavailable",
        kind: event.kind,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
