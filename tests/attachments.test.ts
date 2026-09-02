import { afterEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { stageAttachments } from "../src/agent/attachments.ts";
import type { GatewayClient } from "../src/agent/gateway.ts";
import type { AgentJob } from "../src/shared/types.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function job(): AgentJob {
  return {
    id: 4242,
    updateId: 7,
    chatId: -10042,
    chatType: "private",
    messageId: 8,
    messageThreadId: null,
    userId: 9,
    prompt: "inspect the attachment",
    resumeThreadId: null,
    context: "",
    contextMode: "none",
    replyContext: null,
    attachments: [
      {
        kind: "document",
        value: {
          file_id: "file-4242",
          file_name: "private-note.txt",
          mime_type: "text/plain",
        },
      },
    ],
  };
}

test("attachment cleanup removes the staged file and directory", async () => {
  const gateway = {
    downloadMedia: async (fileId: string) => {
      expect(fileId).toBe("file-4242");
      return new TextEncoder().encode("transient attachment");
    },
  } as unknown as GatewayClient;

  const staged = await stageAttachments(gateway, job());
  const path = staged.files[0]?.path;
  expect(path).not.toBeNull();
  expect(path && existsSync(path)).toBe(true);
  const directory = path ? dirname(path) : null;

  await staged.cleanup();

  expect(path && existsSync(path)).toBe(false);
  expect(directory && existsSync(directory)).toBe(false);
});
