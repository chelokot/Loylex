import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayClient } from "../src/agent/gateway.ts";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

test("uploads a generated file without forcing a JSON content type", async () => {
  const root = await mkdtemp(join(tmpdir(), "loylex-agent-gateway-"));
  temporaryDirectories.push(root);
  const path = join(root, "result.png");
  await writeFile(path, "image");
  let requestBody: FormData | undefined;
  let requestHeaders: Headers | undefined;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("http://gateway/v1/telegram/upload");
    requestBody = init?.body as FormData;
    requestHeaders = new Headers(init?.headers);
    return Response.json({ chatId: -10042, messageId: 23 });
  }) as typeof fetch;

  const client = new GatewayClient("http://gateway", "bridge-token");
  await expect(
    client.uploadFile(-10042, path, { caption: "Результат", replyTo: 17, threadId: 12 }),
  ).resolves.toEqual({ chatId: -10042, messageId: 23 });

  expect(requestHeaders?.get("authorization")).toBe("Bearer bridge-token");
  expect(requestHeaders?.get("content-type")).toBeNull();
  expect(requestBody?.get("chat_id")).toBe("-10042");
  expect((requestBody?.get("file") as File).name).toBe("result.png");
  expect(requestBody?.get("caption")).toBe("Результат");
  expect(requestBody?.get("reply_to")).toBe("17");
  expect(requestBody?.get("thread_id")).toBe("12");
});
