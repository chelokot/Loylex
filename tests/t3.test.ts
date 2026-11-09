import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBytes, runT3, saveExport, t3Request } from "../src/agent/t3.ts";

function exportApproval(text: string, textTruncated = false) {
  return { state: "succeeded", result: JSON.stringify({ items: [{ text, textTruncated }] }) };
}
function manifest(data = Buffer.from("hello\n")) {
  return {
    loylexExport: 1,
    path: "out.txt",
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    base64: data.toString("base64"),
  };
}

describe("T3 CLI approval routing", () => {
  test("connect is an ordinary immutable operation and status exposes no read tool", () => {
    expect(t3Request(["connect", "1811", "home", "https://home.example/mcp"])).toEqual({
      jobId: 1811,
      operation: {
        kind: "t3",
        machine: "home",
        action: "connect",
        arguments: { endpoint: "https://home.example/mcp" },
      },
    });
    expect(t3Request(["device-connect", "1819", "home", "laptop-fedora"]).operation).toMatchObject({
      action: "connect",
      arguments: { environmentName: "laptop-fedora" },
    });
    expect(t3Request(["status", "1811", "home", "mcp:t"]).operation).toEqual({
      kind: "t3-status",
      machine: "home",
      threadId: "mcp:t",
    });
    expect(t3Request(["connection", "1811", "home"]).operation).toEqual({
      kind: "t3-connection",
      machine: "home",
    });
  });
  test("messages and paths remain literal data", () => {
    const message = "Don't run this locally: $(echo example)\n`literal`";
    expect(t3Request(["run", "1811", "home", "p", message]).operation).toMatchObject({
      action: "launch",
      arguments: { projectId: "p", message },
    });
    expect(
      t3Request(["use", "1811", "home", "p", "C:\\Users\\Andrey\\project"]).operation,
    ).toMatchObject({
      action: "register",
      arguments: { workspaceRoot: "C:\\Users\\Andrey\\project" },
    });
  });
  test("bad arity, aliases, job IDs and pagination fail locally", () => {
    for (const args of [
      ["run", "1811", "home"],
      ["connection", "0", "home"],
      ["connection", "1.5", "home"],
      ["connection", "1", "../home"],
      ["read", "1", "home", "t", "-1"],
      ["projects", "1", "home", "no"],
    ]) {
      expect(() => t3Request(args)).toThrow();
    }
  });
  test("long item continuation asks for a new bounded read approval", () => {
    expect(t3Request(["continue", "1811", "home", "mcp:t", "item", "50000"]).operation).toEqual({
      kind: "t3",
      machine: "home",
      action: "read",
      arguments: { threadId: "mcp:t", itemId: "item", textOffset: 50000, maxCharsPerItem: 50000 },
    });
  });
  test("command sends a single request without retrying mutations", async () => {
    const calls: [string, RequestInit | undefined, boolean | undefined][] = [];
    await runT3(
      ["stop", "1811", "home", "mcp:t"],
      async <T>(path: string, init?: RequestInit, retry?: boolean) => {
        calls.push([path, init, retry]);
        return { state: "pending" } as T;
      },
    );
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe("/v1/approvals");
    expect(calls[0]?.[2]).toBeUndefined();
  });
});

describe("approved file export", () => {
  test("requires successful read, complete content, exact path, length and digest", () => {
    const data = manifest();
    expect(
      Buffer.from(exportBytes(exportApproval(JSON.stringify(data)), "out.txt")).toString(),
    ).toBe("hello\n");
    for (const value of [
      { ...data, size: 999 },
      { ...data, sha256: "0".repeat(64) },
      { ...data, path: "secret.txt" },
      { ...data, base64: "not base64" },
      { ...data, size: 32769 },
    ]) {
      expect(() => exportBytes(exportApproval(JSON.stringify(value)), "out.txt")).toThrow();
    }
    expect(() => exportBytes({ state: "pending" }, "out.txt")).toThrow();
    expect(() => exportBytes(exportApproval(JSON.stringify(data), true), "out.txt")).toThrow();
  });
  test("rejects conflicting exports and accepts empty files", () => {
    const first = JSON.stringify(manifest());
    const second = JSON.stringify(manifest(Buffer.from("different")));
    expect(() =>
      exportBytes(
        {
          state: "succeeded",
          result: JSON.stringify({ items: [{ text: first }, { text: second }] }),
        },
        "out.txt",
      ),
    ).toThrow();
    expect(
      exportBytes(exportApproval(JSON.stringify(manifest(Buffer.alloc(0)))), "out.txt").length,
    ).toBe(0);
  });
  test("never overwrites an existing file or follows a destination symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loylex-export-test-"));
    try {
      const path = join(directory, "file");
      await writeFile(path, "original");
      await expect(saveExport(path, new Uint8Array([1]))).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe("original");
      const link = join(directory, "link");
      await symlink(path, link);
      await expect(saveExport(link, new Uint8Array([2]))).rejects.toThrow();
      const fresh = join(directory, "fresh");
      await saveExport(fresh, new Uint8Array([3, 4]));
      expect([...(await readFile(fresh))]).toEqual([3, 4]);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
