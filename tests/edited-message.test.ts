import { describe, expect, test } from "bun:test";
import {
  editedInstructionPrompt,
  editedMessageForUpdate,
  editedMessageText,
} from "../src/gateway/edited-message.ts";
import type { TelegramMessage, TelegramUpdate } from "../src/shared/types.ts";

function message(text: string): TelegramMessage {
  return {
    message_id: 7,
    date: 1_700_000_007,
    edit_date: 1_700_000_008,
    chat: { id: -10042, type: "supergroup", title: "Test" },
    from: { id: 7, is_bot: false, first_name: "Artem" },
    text,
  };
}

describe("edited Telegram messages", () => {
  test("accepts only non-empty text edits", () => {
    const update: TelegramUpdate = { update_id: 1, edited_message: message("  новая задача  ") };

    expect(editedMessageText(update)).toBe("новая задача");
    expect(editedMessageForUpdate(update)).toEqual(update.edited_message ?? null);
    expect(editedInstructionPrompt("новая задача")).toContain("новая задача");
  });

  test("does not turn reactions, captions, or empty edits into requests", () => {
    expect(
      editedMessageForUpdate({
        update_id: 2,
        message_reaction: {
          chat: { id: -10042, type: "supergroup" },
          message_id: 7,
          date: 1_700_000_009,
          old_reaction: [],
          new_reaction: [],
        },
      }),
    ).toBeNull();
    const captionEdit = message("старая подпись");
    delete captionEdit.text;
    captionEdit.caption = "новая подпись";
    expect(editedMessageForUpdate({ update_id: 3, edited_message: captionEdit })).toBeNull();
    expect(editedMessageText({ update_id: 4, edited_message: message("   ") })).toBeNull();
    expect(
      editedMessageForUpdate({
        update_id: 5,
        edited_message: message("новая задача"),
        message_reaction: {
          chat: { id: -10042, type: "supergroup" },
          message_id: 7,
          date: 1_700_000_010,
          old_reaction: [],
          new_reaction: [],
        },
      }),
    ).toBeNull();
  });
});
