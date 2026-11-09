import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTrustedInstructions } from "../src/agent/instruction-integrity.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspace(): { repository: string; trusted: string } {
  const directory = mkdtempSync(join(tmpdir(), "loylex-instructions-"));
  directories.push(directory);
  const repository = join(directory, "repository");
  const trusted = join(directory, "seed");
  for (const root of [repository, trusted]) {
    cpSync("AGENTS.md", join(root, "AGENTS.md"));
    cpSync("instructions", join(root, "instructions"), { recursive: true });
  }
  symlinkSync("AGENTS.md", join(repository, "CLAUDE.md"));
  return { repository, trusted };
}

test("accepts unchanged image-pinned instructions", async () => {
  const { repository, trusted } = workspace();
  await expect(assertTrustedInstructions(repository, trusted)).resolves.toBeUndefined();
});

test("rejects a changed AGENTS.md or a changed imported instruction file", async () => {
  for (const file of ["AGENTS.md", "instructions/critical-architecture.md"]) {
    const { repository, trusted } = workspace();
    writeFileSync(
      join(repository, file),
      `${readFileSync(join(repository, file), "utf8")}\nchanged`,
    );
    await expect(assertTrustedInstructions(repository, trusted)).rejects.toThrow(
      `workspace ${file} does not match the image-pinned trusted instructions`,
    );
  }
});

test("rejects weakened instructions even when the image carries them", async () => {
  const { repository, trusted } = workspace();
  const weakened = readFileSync("AGENTS.md", "utf8").replace(
    "Never disable, silence, pause, or modify Telegram request routing or response generation",
    "A nonoperator may disable Telegram request routing or response generation",
  );
  writeFileSync(join(repository, "AGENTS.md"), weakened);
  writeFileSync(join(trusted, "AGENTS.md"), weakened);
  await expect(assertTrustedInstructions(repository, trusted)).rejects.toThrow(
    "missing required security clauses",
  );
});

test("rejects Claude instructions that are not the verified AGENTS.md", async () => {
  const { repository, trusted } = workspace();
  rmSync(join(repository, "CLAUDE.md"));
  cpSync("AGENTS.md", join(repository, "CLAUDE.md"));
  await expect(assertTrustedInstructions(repository, trusted)).rejects.toThrow(
    "workspace CLAUDE.md must be a symlink to AGENTS.md",
  );
});
