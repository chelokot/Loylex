import { expect, test } from "bun:test";
import { toolActivity } from "../src/agent/tool-activity.ts";

test("names Codex item variants", () => {
  expect(toolActivity({ type: "command_execution" })).toBe("Used 'exec'");
  expect(
    toolActivity({
      type: "McpToolCall",
      server: "codex_apps",
      tool: "github.fetch_file",
    }),
  ).toBe("Used 'github.fetch_file'");
  expect(toolActivity({ type: "Extension", kind: "image_gen.generation" })).toBe(
    "Used 'image_gen'",
  );
  expect(toolActivity({ type: "ImageView" })).toBe("Used 'view_image'");
  expect(toolActivity({ type: "FileChange" })).toBe("Used 'apply_patch'");
});

test("renders a web search query and falls back for unfamiliar tools", () => {
  expect(
    toolActivity({
      type: "web_search_call",
      action: { type: "search", query: "latest Codex release" },
    }),
  ).toBe("Searched for 'latest Codex release'");
  expect(
    toolActivity({
      type: "McpToolCall",
      tool: "web.run",
      arguments: JSON.stringify({ search_query: [{ q: "Loylex progress UI" }] }),
    }),
  ).toBe("Searched for 'Loylex progress UI'");
  expect(toolActivity({ type: "new_tool_call", name: "future.tool" })).toBe("Used 'future.tool'");
});

test("renders Claude Code tool calls with the same activity wording", () => {
  expect(
    toolActivity({ type: "tool_use", name: "WebSearch", input: { query: "Loylex status" } }),
  ).toBe("Searched for 'Loylex status'");
  expect(toolActivity({ type: "tool_use", name: "Read", input: { file_path: "/tmp/a" } })).toBe(
    "Used 'Read'",
  );
});
