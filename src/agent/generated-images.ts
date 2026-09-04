import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const imageExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export type GeneratedImage = {
  path: string;
  filename: string;
  mtimeMs: number;
  size: number;
};

export type GeneratedImageSnapshot = ReadonlyMap<string, Pick<GeneratedImage, "mtimeMs" | "size">>;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function directoryEntries(path: string): Promise<Dirent<string>[]> {
  try {
    return await readdir(path, { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
}

export async function listGeneratedImages(root: string): Promise<GeneratedImage[]> {
  const rootPath = resolve(root);
  const threadPaths = (await directoryEntries(rootPath))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(rootPath, entry.name));
  const images = (
    await Promise.all(threadPaths.map((threadPath) => imagesInThread(threadPath)))
  ).flat();
  return images.sort(
    (left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path),
  );
}

async function imagesInThread(threadPath: string): Promise<GeneratedImage[]> {
  const images: GeneratedImage[] = [];
  for (const fileEntry of await directoryEntries(threadPath)) {
    if (!fileEntry.isFile() || !imageExtensions.has(extname(fileEntry.name).toLowerCase())) {
      continue;
    }
    const path = join(threadPath, fileEntry.name);
    const metadata = await stat(path);
    images.push({
      path,
      filename: basename(path),
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
    });
  }
  return images;
}

export async function listGeneratedImagesForThread(
  root: string,
  threadId: string,
): Promise<GeneratedImage[]> {
  if (!/^[A-Za-z0-9_-]+$/.test(threadId)) {
    return [];
  }
  const images = await imagesInThread(join(resolve(root), threadId));
  return images.sort(
    (left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path),
  );
}

export async function snapshotGeneratedImages(root: string): Promise<GeneratedImageSnapshot> {
  return new Map(
    (await listGeneratedImages(root)).map((image) => [
      image.path,
      { mtimeMs: image.mtimeMs, size: image.size },
    ]),
  );
}

export async function newGeneratedImages(
  root: string,
  before: GeneratedImageSnapshot,
  threadId?: string,
): Promise<GeneratedImage[]> {
  const images =
    threadId === undefined
      ? await listGeneratedImages(root)
      : await listGeneratedImagesForThread(root, threadId);
  return images.filter((image) => !before.has(image.path));
}
