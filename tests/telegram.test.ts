import { afterEach, expect, test } from "bun:test";
import { TelegramClient } from "../src/gateway/telegram.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function requestBodyText(body: RequestInit["body"]): Promise<string> {
  return body === null || body === undefined ? "" : new Response(body).text();
}

type FetchHandler = (
  input: string | URL | Request,
  init?: RequestInit,
) => Response | Promise<Response>;

function withLatestUpdateResponse(handler: FetchHandler): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "http://93.115.18.57:9090/tg-ts-upd/vlatest/update") {
      return JSON.stringify({ status: "latest" }) as unknown as Response;
    }
    return handler(input, init);
  }) as typeof fetch;
}

test("does not downgrade a rejected rich send to an unformatted message", async () => {
  const requests: string[] = [];
  globalThis.fetch = withLatestUpdateResponse(async (input) => {
    requests.push(String(input));
    return Response.json(
      { ok: false, error_code: 400, description: "rich message rejected" },
      { status: 400 },
    );
  });

  const client = new TelegramClient("test-token");
  await expect(client.sendRich(42, "<details>formatted</details>")).rejects.toThrow(
    "sendRichMessage: rich message rejected",
  );

  expect(requests).toEqual(["https://api.telegram.org/bottest-token/sendRichMessage"]);
});

test("treats an idempotent rich edit as success", async () => {
  globalThis.fetch = withLatestUpdateResponse(async (_input: string | URL | Request) =>
    Response.json(
      {
        ok: false,
        error_code: 400,
        description:
          "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      },
      { status: 400 },
    ),
  );

  const client = new TelegramClient("test-token");
  const result = await client.editRich(42, 17, "<details>same</details>");

  expect(result.message_id).toBe(17);
  expect(result.chat.id).toBe(42);
});

test("sends rich message drafts with a stable draft ID", async () => {
  let requestBody: unknown;
  globalThis.fetch = withLatestUpdateResponse(async (input, init) => {
    expect(String(input)).toBe("https://api.telegram.org/bottest-token/sendRichMessageDraft");
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ ok: true, result: true });
  });

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
  globalThis.fetch = withLatestUpdateResponse(async (input, init) => {
    expect(String(input)).toBe("https://api.telegram.org/bottest-token/deleteMessage");
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ ok: true, result: true });
  });

  const client = new TelegramClient("test-token");
  await expect(client.deleteMessage(42, 17)).resolves.toBe(true);
  expect(requestBody).toEqual({ chat_id: 42, message_id: 17 });
});

test("sets a custom emoji reaction on a Telegram message", async () => {
  let requestBody: unknown;
  globalThis.fetch = withLatestUpdateResponse(async (input, init) => {
    expect(String(input)).toBe("https://api.telegram.org/bottest-token/setMessageReaction");
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ ok: true, result: true });
  });

  const client = new TelegramClient("test-token");
  await expect(client.setMessageReaction(42, 17, "🥴")).resolves.toBe(true);
  expect(requestBody).toEqual({
    chat_id: 42,
    message_id: 17,
    reaction: [{ type: "emoji", emoji: "🥴" }],
  });
});

test("sends a photo album with a caption on the first photo", async () => {
  let requestBody: string | undefined;
  let contentType = "";
  globalThis.fetch = withLatestUpdateResponse(async (input, init) => {
    expect(String(input)).toBe("https://api.telegram.org/bottest-token/sendMediaGroup");
    contentType = new Headers(init?.headers).get("content-type") ?? "";
    requestBody = await requestBodyText(init?.body);
    return Response.json({
      ok: true,
      result: [
        { message_id: 18, date: 1, chat: { id: 42, type: "supergroup" } },
        { message_id: 19, date: 1, chat: { id: 42, type: "supergroup" } },
      ],
    });
  });

  const client = new TelegramClient("test-token");
  await expect(
    client.sendMediaGroup(
      42,
      [new File(["one"], "one.png", { type: "image/png" }), new File(["two"], "two.png")],
      "Графики",
    ),
  ).resolves.toHaveLength(2);

  expect(requestBody).toBeDefined();
  expect(contentType).toContain("multipart/form-data; boundary=");
  expect(requestBody).toContain('content-disposition:form-data;name="chat_id"\r\n\r\n42');
  expect(requestBody).toMatch(/"type":"photo","media":"attach:\/\/[^"]+","caption":"Графики"/);
  expect(requestBody).toMatch(/filename=one\.png/);
  expect(requestBody).toMatch(/filename=two\.png/);
  expect(requestBody).toContain("one");
  expect(requestBody).toContain("two");
});

test("sends video files as video media in an album", async () => {
  let requestBody: string | undefined;
  let contentType = "";
  globalThis.fetch = withLatestUpdateResponse(async (input, init) => {
    expect(String(input)).toBe("https://api.telegram.org/bottest-token/sendMediaGroup");
    contentType = new Headers(init?.headers).get("content-type") ?? "";
    requestBody = await requestBodyText(init?.body);
    return Response.json({
      ok: true,
      result: [
        { message_id: 20, date: 1, chat: { id: 42, type: "supergroup" } },
        { message_id: 21, date: 1, chat: { id: 42, type: "supergroup" } },
      ],
    });
  });

  const client = new TelegramClient("test-token");
  await expect(
    client.sendMediaGroup(
      42,
      [new File(["one"], "one.mp4", { type: "video/mp4" }), new File(["two"], "two.mp4")],
      "Видео",
    ),
  ).resolves.toHaveLength(2);

  expect(requestBody).toBeDefined();
  expect(contentType).toContain("multipart/form-data; boundary=");
  expect(requestBody).toMatch(/"type":"video","media":"attach:\/\/[^"]+","caption":"Видео"/);
  expect(requestBody).toMatch(/filename=one\.mp4/);
  expect(requestBody).toMatch(/filename=two\.mp4/);
});
