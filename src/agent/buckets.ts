import { createHash } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";

type Bucket = {
  file: string;
  always?: boolean;
  terms?: string[];
};

type BucketIndex = {
  buckets: Bucket[];
};

export type SelectedBuckets = {
  text: string;
  keys: string[];
};

function safePath(root: string, relative: string): string | null {
  if (isAbsolute(relative)) {
    return null;
  }
  const resolved = normalize(join(root, relative));
  return resolved.startsWith(`${normalize(root)}/`) ? resolved : null;
}

// Bucket keys include the content digest, so an edited bucket is shown to the thread again.
export async function loadBuckets(
  memoryPath: string,
  input: string,
  alreadyInjected: ReadonlySet<string>,
): Promise<SelectedBuckets> {
  const bucketRoot = join(memoryPath, "buckets");
  const indexFile = Bun.file(join(bucketRoot, "index.json"));
  if (!(await indexFile.exists())) {
    return { text: "", keys: [] };
  }
  const index = (await indexFile.json()) as BucketIndex;
  const normalizedInput = input.toLocaleLowerCase();
  const selected = index.buckets.filter(
    (bucket) =>
      bucket.always ||
      bucket.terms?.some((term) => normalizedInput.includes(term.toLocaleLowerCase())),
  );
  const contents: string[] = [];
  const keys: string[] = [];
  for (const bucket of selected) {
    const path = safePath(bucketRoot, bucket.file);
    if (!path) {
      continue;
    }
    const file = Bun.file(path);
    if (!(await file.exists())) {
      continue;
    }
    const content = await file.text();
    const key = `${bucket.file}:${createHash("sha256").update(content).digest("hex")}`;
    if (alreadyInjected.has(key)) {
      continue;
    }
    keys.push(key);
    contents.push(`## Memory bucket: ${bucket.file}\n\n${content}`);
  }
  return { text: contents.join("\n\n"), keys };
}
