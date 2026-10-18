import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hooksPath = resolve(import.meta.dir, "../.githooks");
const repositories: string[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

function git(repository: string, ...args: string[]) {
  return Bun.spawnSync(["git", ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" });
}

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "loylex-pre-commit-"));
  repositories.push(repository);
  git(repository, "init", "--quiet");
  git(repository, "config", "user.name", "Loylex");
  git(repository, "config", "user.email", "loylex@example.com");
  git(repository, "config", "core.hooksPath", hooksPath);
  return repository;
}

function commit(repository: string, files: Record<string, string | Uint8Array>) {
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(repository, path), content);
    git(repository, "add", path);
  }
  const result = git(repository, "commit", "--quiet", "-m", "change");
  return { committed: result.exitCode === 0, stderr: result.stderr.toString() };
}

test("blocks a staged file over 5000 tokens and explains how to split it", () => {
  const repository = createRepository();
  const result = commit(repository, { "large.ts": "x".repeat(20_001), "small.ts": "x" });

  expect(result.committed).toBe(false);
  expect(result.stderr).toContain("large.ts: 5001 tokens");
  expect(result.stderr).not.toContain("small.ts");
  expect(result.stderr).toContain("Split each file listed above");
  expect(git(repository, "rev-parse", "--verify", "HEAD").exitCode).not.toBe(0);
});

test("allows a file of exactly 5000 tokens", () => {
  expect(commit(createRepository(), { "limit.ts": "x".repeat(20_000) }).committed).toBe(true);
});

test("measures the staged content instead of the working tree", () => {
  const repository = createRepository();
  writeFileSync(join(repository, "file.ts"), "x".repeat(20_001));
  git(repository, "add", "file.ts");
  writeFileSync(join(repository, "file.ts"), "x");
  expect(git(repository, "commit", "--quiet", "-m", "large").exitCode).not.toBe(0);

  git(repository, "add", "file.ts");
  writeFileSync(join(repository, "file.ts"), "x".repeat(20_001));
  expect(git(repository, "commit", "--quiet", "-m", "small").exitCode).toBe(0);
});

test("ignores generated, binary, and deleted files", () => {
  const repository = createRepository();
  const binary = new Uint8Array(30_000);
  expect(
    commit(repository, {
      ".gitattributes": "bun.lock linguist-generated\n",
      "bun.lock": "x".repeat(30_000),
      "image.png": binary,
    }).committed,
  ).toBe(true);

  writeFileSync(join(repository, "legacy.ts"), "x".repeat(30_000));
  git(repository, "add", "legacy.ts");
  git(repository, "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "legacy");
  git(repository, "rm", "--quiet", "legacy.ts");
  expect(git(repository, "commit", "--quiet", "-m", "remove legacy").exitCode).toBe(0);
});
