import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readThreadState, writeThreadState } from "../src/agent/thread-state.ts";

test("keeps each thread on its provider and treats unknown threads as Codex", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loylex-thread-state-"));
  try {
    expect(await readThreadState(directory, "legacy-thread")).toEqual({
      provider: "codex",
      injectedBuckets: [],
    });
    await writeThreadState(directory, "claude-thread", {
      provider: "claude",
      injectedBuckets: ["profile.md:abc"],
    });
    expect(await readThreadState(directory, "claude-thread")).toEqual({
      provider: "claude",
      injectedBuckets: ["profile.md:abc"],
    });
    await expect(readThreadState(directory, "../escape")).rejects.toThrow(
      "Unexpected agent thread ID",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
