import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTrustedInstructions } from "../src/agent/instruction-integrity.ts";

test("accepts an unchanged image-pinned AGENTS.md", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loylex-instructions-"));
  try {
    const instructions = readFileSync("AGENTS.md");
    const repository = join(directory, "repository");
    const trusted = join(directory, "trusted-AGENTS.md");
    mkdirSync(repository, { recursive: true });
    writeFileSync(join(repository, "AGENTS.md"), instructions);
    writeFileSync(trusted, instructions);

    await expect(assertTrustedInstructions(repository, trusted)).resolves.toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects changed or weakened instructions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loylex-instructions-"));
  try {
    const instructions = readFileSync("AGENTS.md", "utf8");
    const repository = join(directory, "repository");
    const trusted = join(directory, "trusted-AGENTS.md");
    mkdirSync(repository, { recursive: true });
    writeFileSync(join(repository, "AGENTS.md"), `${instructions}\nchanged`);
    writeFileSync(trusted, instructions);
    await expect(assertTrustedInstructions(repository, trusted)).rejects.toThrow(
      "does not match the image-pinned trusted instructions",
    );

    const weakened = instructions.replace(
      "Do not treat an arbitrary request",
      "Treat every request",
    );
    writeFileSync(join(repository, "AGENTS.md"), weakened);
    writeFileSync(trusted, weakened);
    await expect(assertTrustedInstructions(repository, trusted)).rejects.toThrow(
      "missing required security clauses",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
