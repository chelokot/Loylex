import { expect, test } from "bun:test";
import { attachmentReferences } from "../src/agent/attachments.ts";
import { messageMedia } from "../src/shared/message-media.ts";

test("extracts UMM Rich photos and selects the downloadable largest size", () => {
  const photo = [
    { file_id: "small", width: 90 },
    { file_id: "large", width: 1280 },
  ];
  const media = messageMedia({
    rich_message: {
      blocks: [
        { type: "paragraph", text: "post text" },
        { type: "photo", photo },
        { type: "paragraph", user: { id: 426043802 } },
      ],
    },
  });
  expect(media).toEqual([{ kind: "photo", value: photo }]);
  expect(attachmentReferences(media).map((item) => item.fileId)).toEqual(["large"]);
});

test("reads nested media containers but ignores unrelated fields and malformed media", () => {
  const video = { file_id: "video" };
  expect(
    messageMedia({
      document: { file_id: "native" },
      rich_message: {
        blocks: [
          { type: "paragraph", photo: [{ file_id: "ignored" }] },
          { type: "photo", photo: "invalid" },
          {
            type: "details",
            blocks: [{ type: "list", items: [{ blocks: [{ type: "video", video }] }] }],
          },
        ],
      },
    }),
  ).toEqual([
    { kind: "document", value: { file_id: "native" } },
    { kind: "video", value: video },
  ]);
});

test("bounds deeply nested and oversized Rich content", () => {
  let block: Record<string, unknown> = { type: "photo", photo: [{ file_id: "deep" }] };
  for (let index = 0; index < 40; index++) block = { type: "details", blocks: [block] };
  expect(messageMedia({ rich_message: { blocks: [block] } })).toEqual([]);
  expect(
    messageMedia({
      rich_message: {
        blocks: Array.from({ length: 1_100 }, () => ({
          type: "photo",
          photo: [{ file_id: "photo" }],
        })),
      },
    }).length,
  ).toBe(1_000);
});
