import { expect, spyOn, test } from "bun:test";
import { reportProgress } from "../src/agent/progress.ts";
import type { AgentEvent } from "../src/shared/types.ts";

const event: AgentEvent = { kind: "status", text: "Команда завершена" };

test("forwards a progress event to the gateway", async () => {
  const posted: Array<[number, AgentEvent]> = [];
  await reportProgress(
    {
      event: async (jobId, sent) => {
        posted.push([jobId, sent]);
        return { ok: true };
      },
    },
    7,
    event,
  );

  expect(posted).toEqual([[7, event]]);
});

test("keeps the turn running when the gateway rejects a progress event", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      reportProgress(
        {
          event: async () => {
            throw new Error(
              'Gateway 500: {"error":"editMessageText: Bad Request: canceled by new edit message request"}',
            );
          },
        },
        7,
        event,
      ),
    ).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(1);
  } finally {
    errors.mockRestore();
  }
});
