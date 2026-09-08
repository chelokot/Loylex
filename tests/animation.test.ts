import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { animationConversionArguments, prepareAnimationFile } from "../src/agent/animation.ts";

test("builds a fixed non-shell H.264 conversion command", () => {
  expect(animationConversionArguments("input.gif", "/tmp/animation.mp4")).toEqual([
    "ffmpeg",
    "-y",
    "-v",
    "error",
    "-i",
    "input.gif",
    "-an",
    "-c:v",
    "libopenh264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "/tmp/animation.mp4",
  ]);
});

test("leaves non-GIF animation files unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loylex-animation-test-"));
  const path = join(directory, "animation.mp4");
  await writeFile(path, "video");
  try {
    const prepared = await prepareAnimationFile(path);
    expect(prepared.path).toBe(path);
    expect(prepared.filename).toBe("animation.mp4");
    await prepared.cleanup();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
