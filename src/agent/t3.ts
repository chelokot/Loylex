import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";

export const t3Usage = `Usage: loylex t3 COMMAND JOB_ID MACHINE ...
  connect JOB_ID MACHINE HTTPS_MCP_URL
  connection JOB_ID MACHINE
  capabilities JOB_ID MACHINE
  projects JOB_ID MACHINE [CURSOR]
  use JOB_ID MACHINE PROJECT_ID EXACT_PROJECT_FOLDER
  run JOB_ID MACHINE PROJECT_ID MESSAGE
  send JOB_ID MACHINE PROJECT_ID THREAD_ID MESSAGE
  sessions JOB_ID MACHINE PROJECT_ID [CURSOR]
  status JOB_ID MACHINE THREAD_ID
  read JOB_ID MACHINE THREAD_ID [AFTER_POSITION]
  continue JOB_ID MACHINE THREAD_ID ITEM_ID TEXT_OFFSET
  export JOB_ID MACHINE PROJECT_ID RELATIVE_FILE_PATH
  stop JOB_ID MACHINE THREAD_ID
  disconnect JOB_ID MACHINE
  result APPROVAL_ID
  save-export APPROVAL_ID OUTPUT_FILE EXPECTED_RELATIVE_PATH
Every operation except connection/status needs its own live operator approval.
Connect: approve → open login button → choose Full access in T3 → done.
T3 access lasts up to 30 days. Reconnect after expiry/revocation.
Export starts a task for one non-secret project file up to 32 KiB. Approve read
separately (including each continuation), then save-export and upload the file.`;

function integer(value: string | undefined, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!value || !/^\d+$/.test(value)) throw new Error(t3Usage);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(t3Usage);
  return result;
}

export function t3Request(args: string[]): { jobId: number; operation: object } {
  const [command, job, machine, ...rest] = args;
  const jobId = integer(job);
  if (jobId < 1 || !machine || !/^[a-zA-Z0-9_-]{1,80}$/.test(machine)) throw new Error(t3Usage);
  const arity: Record<string, [number, number]> = {
    connect: [1, 1],
    connection: [0, 0],
    capabilities: [0, 0],
    projects: [0, 1],
    use: [2, 2],
    run: [2, 2],
    send: [3, 3],
    sessions: [1, 2],
    status: [1, 1],
    read: [1, 2],
    continue: [3, 3],
    export: [2, 2],
    stop: [1, 1],
    disconnect: [0, 0],
  };
  const range = command ? arity[command] : undefined;
  if (!range || rest.length < range[0] || rest.length > range[1]) throw new Error(t3Usage);
  if (command === "status")
    return { jobId, operation: { kind: "t3-status", machine, threadId: rest[0] } };
  if (command === "connection") return { jobId, operation: { kind: "t3-connection", machine } };
  const [first, second, third] = rest;
  let action = command;
  let arguments_: object;
  switch (command) {
    case "connect":
      arguments_ = { endpoint: first };
      break;
    case "projects":
      arguments_ = { cursor: integer(first, 0), limit: 20 };
      break;
    case "use":
      action = "register";
      arguments_ = { projectId: first, workspaceRoot: second };
      break;
    case "run":
      action = "launch";
      arguments_ = { projectId: first, title: "Задача из Telegram", message: second };
      break;
    case "send":
      arguments_ = { projectId: first, threadId: second, message: third };
      break;
    case "sessions":
      action = "list";
      arguments_ = { projectId: first, cursor: integer(second, 0), limit: 20 };
      break;
    case "read":
      arguments_ = { threadId: first, afterPosition: integer(second, 0), maxCharsPerItem: 50000 };
      break;
    case "continue":
      action = "read";
      arguments_ = {
        threadId: first,
        itemId: second,
        textOffset: integer(third),
        maxCharsPerItem: 50000,
      };
      break;
    case "export":
      arguments_ = { projectId: first, path: second };
      break;
    case "stop":
      action = "interrupt";
      arguments_ = { threadId: first };
      break;
    case "capabilities":
      arguments_ = {};
      break;
    case "disconnect":
      arguments_ = {};
      break;
    default:
      throw new Error(t3Usage);
  }
  return { jobId, operation: { kind: "t3", machine, action, arguments: arguments_ } };
}

export function exportBytes(approval: unknown, expectedPath: string): Uint8Array {
  const row = approval as { state?: string; result?: string };
  if (row?.state !== "succeeded" || typeof row.result !== "string")
    throw new Error("Approve and finish a T3 read before saving its export");
  const read = JSON.parse(row.result) as { items?: { text?: string; textTruncated?: boolean }[] };
  const candidates = new Map<string, Buffer>();
  for (const item of read.items ?? []) {
    if (typeof item.text !== "string" || item.textTruncated || item.text.length > 50000) continue;
    let value: {
      loylexExport?: number;
      path?: string;
      size?: number;
      sha256?: string;
      base64?: string;
    };
    try {
      value = JSON.parse(item.text);
    } catch {
      continue;
    }
    if (
      !value ||
      value.loylexExport !== 1 ||
      value.path !== expectedPath ||
      !Number.isSafeInteger(value.size) ||
      (value.size ?? -1) < 0 ||
      (value.size ?? 0) > 32768 ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.base64 !== "string" ||
      value.base64.length > 43692 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)
    )
      continue;
    const bytes = Buffer.from(value.base64, "base64");
    if (
      bytes.length !== value.size ||
      bytes.toString("base64") !== value.base64 ||
      createHash("sha256").update(bytes).digest("hex") !== value.sha256
    )
      continue;
    candidates.set(value.sha256, bytes);
  }
  if (candidates.size !== 1)
    throw new Error("No unambiguous complete export; approve the correct read/continuation");
  return [...candidates.values()][0] as Buffer;
}

export async function saveExport(path: string, data: Uint8Array): Promise<void> {
  // A remote filename never selects a local path. Exclusive create also refuses symlinks.
  const file = await open(path, "wx", 0o600);
  let complete = false;
  try {
    await file.writeFile(data);
    await file.sync();
    complete = true;
  } finally {
    await file.close();
    if (!complete) await unlink(path);
  }
}

export type T3GatewayRequest = <T = unknown>(
  path: string,
  init?: RequestInit,
  retry?: boolean,
) => Promise<T>;

export async function runT3(arguments_: string[], requestJson: T3GatewayRequest): Promise<void> {
  const [action, identifier, output, expectedPath] = arguments_;
  if (action === "help" || !action) {
    console.log(t3Usage);
    return;
  }
  if (action === "result" || action === "save-export") {
    if (!identifier || !/^[a-f0-9]{32}$/.test(identifier)) throw new Error(t3Usage);
    const result = await requestJson(`/v1/approvals/${identifier}`);
    if (action === "save-export") {
      if (!output || !expectedPath || arguments_.length !== 4) throw new Error(t3Usage);
      const data = exportBytes(result, expectedPath);
      await saveExport(output, data);
      console.log(JSON.stringify({ path: output, bytes: data.byteLength }));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }
  console.log(
    JSON.stringify(
      await requestJson("/v1/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(t3Request(arguments_)),
      }),
      null,
      2,
    ),
  );
  return;
}
