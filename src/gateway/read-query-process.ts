import { Database } from "bun:sqlite";
import {
  ReadQueryError,
  type ReadQueryParameters,
  type ReadQueryResult,
  readQuery,
  readQueryTimeoutMs,
} from "./read-query.ts";

type ReadQueryRequest = {
  databasePath: string;
  sql: string;
  params: ReadQueryParameters;
  maxRows: number;
};

type ReadQueryOutcome = { result: ReadQueryResult } | { error: string };

export async function runReadQuery(
  request: ReadQueryRequest,
  timeoutMs = readQueryTimeoutMs,
): Promise<ReadQueryResult> {
  const child = Bun.spawn([process.execPath, import.meta.path], {
    stdin: new Blob([JSON.stringify(request)]),
    stdout: "pipe",
    stderr: "inherit",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (child.signalCode === "SIGKILL") {
    throw new ReadQueryError(
      `query ran longer than the ${timeoutMs / 1000}-second limit and was stopped; narrow it with indexed filters such as chat_id with message_id or date ranges, and paginate`,
    );
  }
  if (exitCode !== 0) {
    throw new Error(`read-only query process exited with code ${exitCode}`);
  }
  const outcome = JSON.parse(output) as ReadQueryOutcome;
  if ("error" in outcome) {
    throw new ReadQueryError(outcome.error);
  }
  return outcome.result;
}

if (import.meta.main) {
  const request = (await Bun.stdin.json()) as ReadQueryRequest;
  const connection = new Database(request.databasePath, { readonly: true, strict: true });
  connection.exec("PRAGMA query_only = ON");
  let outcome: ReadQueryOutcome;
  try {
    outcome = { result: readQuery(connection, request.sql, request.params, request.maxRows) };
  } catch (error) {
    if (!(error instanceof ReadQueryError)) {
      throw error;
    }
    outcome = { error: error.message };
  }
  await Bun.write(Bun.stdout, JSON.stringify(outcome));
}
