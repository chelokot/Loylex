export type ToolItem = {
  type?: string;
  id?: string;
  text?: string;
  command?: string;
  exit_code?: number;
  exitCode?: number;
  name?: string;
  tool?: string;
  server?: string;
  actionName?: string;
  kind?: string;
  call_id?: string;
  callId?: string;
  action?: unknown;
  input?: unknown;
  arguments?: unknown;
  query?: unknown;
  queries?: unknown;
  function?: {
    name?: string;
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedType(value: unknown): string {
  return (stringValue(value) ?? "")
    .replaceAll(".", "_")
    .replaceAll("-", "_")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function printableText(value: string, removeBrackets = false): string {
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint >= 0x20 &&
        codePoint !== 0x7f &&
        (!removeBrackets || (character !== "[" && character !== "]"))
      );
    })
    .join("");
}

function safeToolName(value: string): string | null {
  const name = printableText(value).replaceAll(/\s+/g, " ").trim().slice(0, 120);
  return name || null;
}

function itemToolName(item: ToolItem): string | null {
  const type = normalizedType(item.type);
  const explicitName =
    stringValue(item.name) ??
    stringValue(item.tool) ??
    stringValue(item.function?.name) ??
    stringValue(item.actionName);

  if (type === "mcp_tool_call") {
    if (explicitName) {
      const server = stringValue(item.server);
      return safeToolName(
        server && !explicitName.includes(".") ? `${server}.${explicitName}` : explicitName,
      );
    }
    return safeToolName(stringValue(item.server) ?? "mcp_tool");
  }
  if (type === "extension") {
    const kind = stringValue(item.kind);
    if (!kind) {
      return null;
    }
    return safeToolName(kind === "image_gen.generation" ? "image_gen" : kind);
  }
  if (explicitName) {
    return safeToolName(explicitName);
  }

  switch (type) {
    case "command_execution":
      return "exec";
    case "file_change":
      return "apply_patch";
    case "image_view":
      return "view_image";
    case "image_generation_call":
      return "image_gen";
    case "web_search_call":
      return "web_search";
    case "file_search_call":
      return "file_search";
    case "computer_call":
      return "computer";
    case "custom_tool_call":
      return "custom_tool";
    default:
      return type.endsWith("_call") ? safeToolName(type.slice(0, -5)) : null;
  }
}

function compactToolText(value: string, limit = 400): string {
  return printableText(value).replaceAll(/\s+/g, " ").trim().slice(0, limit);
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function searchQueryFromValue(value: unknown, depth = 0): string | null {
  if (depth > 5) {
    return null;
  }
  const parsed = parsedJson(value);
  const directText = stringValue(parsed);
  if (directText) {
    return compactToolText(directText);
  }
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const query = searchQueryFromValue(entry, depth + 1);
      if (query) {
        return query;
      }
    }
    return null;
  }
  const object = record(parsed);
  if (!object) {
    return null;
  }
  for (const key of ["query", "q"]) {
    const query = stringValue(object[key]);
    if (query) {
      return compactToolText(query);
    }
  }
  for (const key of [
    "action",
    "arguments",
    "input",
    "parameters",
    "queries",
    "search_query",
    "searchQuery",
  ]) {
    const query = searchQueryFromValue(object[key], depth + 1);
    if (query) {
      return query;
    }
  }
  return null;
}

function isSearchTool(item: ToolItem, name: string): boolean {
  const type = normalizedType(item.type);
  const normalizedName = name.toLowerCase().replaceAll("-", "_");
  return (
    type.includes("web_search") ||
    normalizedName === "web.run" ||
    normalizedName.includes("web.search") ||
    normalizedName.includes("web_search") ||
    normalizedName.includes("search")
  );
}

function quoteActivityText(value: string): string {
  return value.replaceAll("'", "\\'");
}

export function toolActivity(item: ToolItem | undefined): string | null {
  const name = item ? itemToolName(item) : null;
  if (!item || !name) {
    return null;
  }
  if (isSearchTool(item, name)) {
    const query = searchQueryFromValue(item);
    if (query) {
      return `Searched for '${quoteActivityText(query)}'`;
    }
  }
  return `Used '${quoteActivityText(compactToolText(name, 120))}'`;
}
