import { rename, rm } from "node:fs/promises";
import { basename, extname } from "node:path";
import { prepareAnimationFile } from "./animation.ts";
import { retryTransient } from "./retry.ts";
import type { T3GatewayRequest } from "./t3.ts";

type MediaRequest = (path: string, init?: RequestInit, retry?: boolean) => Promise<Response>;

async function downloadMedia(fileId: string, output: string, request: MediaRequest): Promise<void> {
  const temporary = `${output}.loylex-part`;
  try {
    await retryTransient(async () => {
      await rm(temporary, { force: true });
      const response = await request(`/v1/media?file_id=${encodeURIComponent(fileId)}`);
      await Bun.write(temporary, response);
      await rename(temporary, output);
    });
  } finally {
    await rm(temporary, { force: true });
  }
}

async function uploadLocalFile(
  chatId: string,
  path: string,
  caption: string[],
  endpoint: string,
  requestJson: T3GatewayRequest,
): Promise<unknown> {
  const prepared = await prepareAnimationFile(path);
  try {
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("file", Bun.file(prepared.path), prepared.filename);
    if (caption.length > 0) {
      form.set("caption", caption.join(" "));
    }
    return await requestJson(endpoint, { method: "POST", body: form }, false);
  } finally {
    await prepared.cleanup();
  }
}

export async function runMediaCommand(
  command: string | undefined,
  arguments_: string[],
  request: MediaRequest,
  requestJson: T3GatewayRequest,
): Promise<boolean> {
  if (command === "media") {
    const [fileId, output] = arguments_;
    if (!fileId || !output) {
      throw new Error("Usage: loylex media FILE_ID OUTPUT_PATH");
    }
    await downloadMedia(fileId, output, request);
    console.log(output);
    return true;
  }
  if (command === "upload") {
    const [chatId, path, ...caption] = arguments_;
    if (!chatId || !path) {
      throw new Error("Usage: loylex upload CHAT_ID FILE [CAPTION]");
    }
    const endpoint =
      extname(path).toLowerCase() === ".gif"
        ? "/v1/telegram/upload-animation"
        : "/v1/telegram/upload";
    const result = await uploadLocalFile(chatId, path, caption, endpoint, requestJson);
    console.log(JSON.stringify(result, null, 2));
    return true;
  }
  if (command === "upload-animation") {
    const [chatId, path, ...caption] = arguments_;
    if (!chatId || !path) {
      throw new Error("Usage: loylex upload-animation CHAT_ID FILE [CAPTION]");
    }
    const result = await uploadLocalFile(
      chatId,
      path,
      caption,
      "/v1/telegram/upload-animation",
      requestJson,
    );
    console.log(JSON.stringify(result, null, 2));
    return true;
  }
  if (command === "upload-voice") {
    const [chatId, path, ...caption] = arguments_;
    if (!chatId || !path) {
      throw new Error("Usage: loylex upload-voice CHAT_ID FILE [CAPTION]");
    }
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("file", Bun.file(path), basename(path));
    if (caption.length > 0) {
      form.set("caption", caption.join(" "));
    }
    const result = await requestJson(
      "/v1/telegram/upload-voice",
      { method: "POST", body: form },
      false,
    );
    console.log(JSON.stringify(result, null, 2));
    return true;
  }
  if (command === "upload-album") {
    let paths = arguments_;
    let caption: string | undefined;
    const captionIndex = arguments_.findIndex(
      (argument) => argument === "--caption" || argument.startsWith("--caption="),
    );
    if (captionIndex >= 0) {
      const argument = arguments_[captionIndex];
      if (argument === undefined) {
        throw new Error("Usage: loylex upload-album CHAT_ID FILE... [--caption CAPTION]");
      }
      if (argument === "--caption") {
        if (captionIndex !== arguments_.length - 2) {
          throw new Error("Usage: loylex upload-album CHAT_ID FILE... [--caption CAPTION]");
        }
        caption = arguments_[captionIndex + 1];
      } else {
        caption = argument.slice("--caption=".length);
        if (captionIndex !== arguments_.length - 1) {
          throw new Error("Usage: loylex upload-album CHAT_ID FILE... [--caption CAPTION]");
        }
      }
      paths = arguments_.slice(0, captionIndex);
    }
    const [chatId, ...files] = paths;
    if (!chatId || files.length < 2 || files.length > 10) {
      throw new Error("Usage: loylex upload-album CHAT_ID FILE... [--caption CAPTION]");
    }
    const form = new FormData();
    form.set("chat_id", chatId);
    for (const path of files) {
      form.append("file", Bun.file(path), basename(path));
    }
    if (caption !== undefined) {
      form.set("caption", caption);
    }
    const result = await requestJson(
      "/v1/telegram/upload-album",
      {
        method: "POST",
        body: form,
      },
      false,
    );
    console.log(JSON.stringify(result, null, 2));
    return true;
  }
  return false;
}
