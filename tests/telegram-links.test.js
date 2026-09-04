import { describe, expect, test } from "bun:test";
import { formatTelegramLinks, parseTelegramLinks } from "../tools/telegram-links/parser.js";

describe("Telegram link parser", () => {
  test("converts private links and groups messages by chat", () => {
    const result = parseTelegramLinks(
      [
        "https://t.me/c/1756869879/1218947",
        "https://t.me/c/1756869879/1218950",
        "https://t.me/c/987654321/42",
      ].join("\n"),
    );

    expect(formatTelegramLinks(result)).toBe("-1001756869879: 1218947, 1218950\n-100987654321: 42");
    expect(result.linkCount).toBe(3);
    expect(result.uniqueMessageCount).toBe(3);
    expect(result.invalidLines).toEqual([]);
  });

  test("accepts links embedded in text and ignores duplicate message IDs", () => {
    const result = parseTelegramLinks(
      "first: t.me/c/1756869879/1218947?single\nsecond: https://telegram.me/c/1756869879/1218947#fragment",
    );

    expect(formatTelegramLinks(result)).toBe("-1001756869879: 1218947");
    expect(result.linkCount).toBe(2);
    expect(result.uniqueMessageCount).toBe(1);
  });

  test("reports lines that are not private Telegram message links", () => {
    const result = parseTelegramLinks("https://t.me/example/12\nnot a link");

    expect(result.groups).toEqual([]);
    expect(result.invalidLines).toEqual([
      { lineNumber: 1, text: "https://t.me/example/12" },
      { lineNumber: 2, text: "not a link" },
    ]);
  });
});
