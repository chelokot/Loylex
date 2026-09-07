import { afterEach, expect, test } from "bun:test";
import { TelegramClient } from "../src/gateway/telegram.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("does not downgrade a rejected rich send to an unformatted message", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    return Response.json(
      { ok: false, error_code: 400, description: "rich message rejected" },
      { status: 400 },
    );
  }) as typeof fetch;

  const client = new TelegramClient("test-token");
  await expect(client.sendRich(42, "<details>formatted</details>")).rejects.toThrow(
    "sendRichMessage: rich message rejected",
  );

  expect(requests).toEqual(["https://api.telegram.org/bottest-token/sendRichMessage"]);
});

test("treats an idempotent rich edit as success", async () => {
  globalThis.fetch = (async (_input: string | URL | Request) =>
    Response.json(
      {
        ok: false,
        error_code: 400,
        description:
          "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      },
      { status: 400 },
    )) as unknown as typeof fetch;

  const client = new TelegramClient("test-token");
  const result = await client.editRich(42, 17, "<details>same</details>");

  expect(result?.message_id).toBe(17);
  expect(result?.chat.id).toBe(42);
});

test("reports a missing rich message without failing the job", async () => {
  globalThis.fetch = (async (_input: string | URL | Request) =>
    Response.json(
      {
        ok: false,
        error_code: 400,
        description: "Bad Request: message to edit not found",
      },
      { status: 400 },
    )) as unknown as typeof fetch;

  const client = new TelegramClient("test-token");
  await expect(client.editRich(42, 17, "<details>working</details>")).resolves.toBeNull();
});

test("sends rich message drafts with a stable draft ID", async () => {
  let requestBody: unknown;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://api.telegram.org/bottest-token/sendRichMessageDraft");
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;

  const client = new TelegramClient("test-token");
  await expect(
    client.sendRichMessageDraft(42, "<details>working</details>", {
      draftId: 7,
      threadId: null,
      canStop: true,
    }),
  ).resolves.toBe(true);

  expect(requestBody).toEqual({
    chat_id: 42,
    draft_id: 7,
    rich_message: { markdown: "<details>working</details>" },
    can_stop: true,
  });
});

test("deletes a Telegram message", async () => {
  let requestBody: unknown;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://api.telegram.org/bottest-token/deleteMessage");
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;

  const client = new TelegramClient("test-token");
  await expect(client.deleteMessage(42, 17)).resolves.toBe(true);
  expect(requestBody).toEqual({ chat_id: 42, message_id: 17 });
});

test("treats an already deleted Telegram message as success", async () => {
  globalThis.fetch = (async (_input: string | URL | Request) =>
    Response.json(
      {
        ok: false,
        error_code: 400,
        description: "Bad Request: message to delete not found",
      },
      { status: 400 },
    )) as unknown as typeof fetch;

  const client = new TelegramClient("test-token");
  await expect(client.deleteMessage(42, 17)).resolves.toBe(true);
});

test("sets a custom emoji reaction on a Telegram message", async () => {
  let requestBody: unknown;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://api.telegram.org/bottest-token/setMessageReaction");
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;

  const client = new TelegramClient("test-token");
  await expect(client.setMessageReaction(42, 17, "🥴")).resolves.toBe(true);
  expect(requestBody).toEqual({
    chat_id: 42,
    message_id: 17,
    reaction: [{ type: "emoji", emoji: "🥴" }],
  });
});

test("sends a photo album with a caption on the first photo", async () => {
  let requestBody: FormData | undefined;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://api.telegram.org/bottest-token/sendMediaGroup");
    requestBody = init?.body as FormData;
    return Response.json({
      ok: true,
      result: [
        { message_id: 18, date: 1, chat: { id: 42, type: "supergroup" } },
        { message_id: 19, date: 1, chat: { id: 42, type: "supergroup" } },
      ],
    });
  }) as typeof fetch;

  const client = new TelegramClient("test-token");
  await expect(
    client.sendMediaGroup(
      42,
      [new File(["one"], "one.png", { type: "image/png" }), new File(["two"], "two.png")],
      "Графики",
    ),
  ).resolves.toHaveLength(2);

  expect(requestBody).toBeDefined();
  expect(requestBody?.get("chat_id")).toBe("42");
  expect(JSON.parse(String(requestBody?.get("media")))).toEqual([
    { type: "photo", media: "attach://file0", caption: "Графики" },
    { type: "photo", media: "attach://file1" },
  ]);
  expect((requestBody?.get("file0") as File).name).toBe("one.png");
  expect((requestBody?.get("file1") as File).name).toBe("two.png");
});

test("sends video files as video media in an album", async () => {
  let requestBody: FormData | undefined;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://api.telegram.org/bottest-token/sendMediaGroup");
    requestBody = init?.body as FormData;
    return Response.json({
      ok: true,
      result: [
        { message_id: 20, date: 1, chat: { id: 42, type: "supergroup" } },
        { message_id: 21, date: 1, chat: { id: 42, type: "supergroup" } },
      ],
    });
  }) as typeof fetch;

  const client = new TelegramClient("test-token");
  await expect(
    client.sendMediaGroup(
      42,
      [new File(["one"], "one.mp4", { type: "video/mp4" }), new File(["two"], "two.mp4")],
      "Видео",
    ),
  ).resolves.toHaveLength(2);

  expect(requestBody).toBeDefined();
  expect(JSON.parse(String(requestBody?.get("media")))).toEqual([
    { type: "video", media: "attach://file0", caption: "Видео" },
    { type: "video", media: "attach://file1" },
  ]);
});

test("sends a document in the requested Telegram thread and reply", async () => {
  let requestBody: FormData | undefined;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://api.telegram.org/bottest-token/sendDocument");
    requestBody = init?.body as FormData;
    return Response.json({
      ok: true,
      result: { message_id: 22, date: 1, chat: { id: 42, type: "supergroup" } },
    });
  }) as typeof fetch;

  const client = new TelegramClient("test-token");
  await expect(
    client.sendDocument(
      42,
      new File(["image"], "result.png", { type: "image/png" }),
      "result.png",
      null,
      { replyTo: 17, threadId: 12 },
    ),
  ).resolves.toMatchObject({ message_id: 22 });

  expect(requestBody).toBeDefined();
  expect(requestBody?.get("chat_id")).toBe("42");
  expect((requestBody?.get("document") as File).name).toBe("result.png");
  expect(JSON.parse(String(requestBody?.get("reply_parameters")))).toEqual({
    message_id: 17,
    allow_sending_without_reply: true,
  });
  expect(requestBody?.get("message_thread_id")).toBe("12");
});
