import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listGeneratedImages,
  listGeneratedImagesForThread,
  newGeneratedImages,
  snapshotGeneratedImages,
} from "../src/agent/generated-images.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "loylex-generated-images-"));
  temporaryDirectories.push(path);
  return path;
}

test("detects only new image files in generated-image thread directories", async () => {
  const root = await temporaryRoot();
  const thread = join(root, "thread-1");
  await mkdir(thread);
  await writeFile(join(thread, "old.png"), "old");
  await writeFile(join(thread, "notes.txt"), "not an image");

  const before = await snapshotGeneratedImages(root);
  await writeFile(join(thread, "new.webp"), "new");
  await mkdir(join(root, "thread-2"));
  await writeFile(join(root, "thread-2", "another.jpg"), "another");

  const images = await newGeneratedImages(root, before);

  expect(images.map((image) => image.filename).sort()).toEqual(["another.jpg", "new.webp"]);
  expect((await listGeneratedImages(root)).map((image) => image.filename).sort()).toEqual([
    "another.jpg",
    "new.webp",
    "old.png",
  ]);
  expect(
    (await listGeneratedImagesForThread(root, "thread-2")).map((image) => image.filename),
  ).toEqual(["another.jpg"]);
  expect(await listGeneratedImagesForThread(root, "../outside")).toEqual([]);
});

test("treats a missing generated-image directory as empty", async () => {
  const root = await temporaryRoot();

  expect(await listGeneratedImages(join(root, "missing"))).toEqual([]);
  expect(await snapshotGeneratedImages(join(root, "missing"))).toEqual(new Map());
});
