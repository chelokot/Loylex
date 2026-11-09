import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProvider } from "./agent-run.ts";

export type ThreadState = {
  provider: AgentProvider;
  injectedBuckets: string[];
};

function statePath(directory: string, threadId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(threadId)) {
    throw new Error(`Unexpected agent thread ID: ${threadId}`);
  }
  return join(directory, "threads", `${threadId}.json`);
}

// Threads created before per-thread state existed were all Codex threads.
export async function readThreadState(directory: string, threadId: string): Promise<ThreadState> {
  try {
    return JSON.parse(await readFile(statePath(directory, threadId), "utf8")) as ThreadState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { provider: "codex", injectedBuckets: [] };
    }
    throw error;
  }
}

export async function writeThreadState(
  directory: string,
  threadId: string,
  state: ThreadState,
): Promise<void> {
  await mkdir(join(directory, "threads"), { recursive: true });
  await writeFile(statePath(directory, threadId), JSON.stringify(state));
}
