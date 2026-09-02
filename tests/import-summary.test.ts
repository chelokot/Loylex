import { expect, test } from "bun:test";
import { importSummary } from "../src/gateway/import-summary.ts";

test("import diagnostics contain no chat identifier", () => {
  const summary = importSummary(3, "/data/loylex.sqlite");

  expect(summary).toEqual({ imported: 3, database: "/data/loylex.sqlite" });
  expect("chatId" in summary).toBe(false);
  expect(JSON.stringify(summary)).not.toContain("-10042");
});
