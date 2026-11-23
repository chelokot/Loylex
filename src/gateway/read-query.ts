import type { Database } from "bun:sqlite";

export const defaultReadQueryRows = 1_000;
export const maxReadQueryRows = 10_000;
export const maxReadQuerySqlLength = 100_000;
export const maxReadQueryResultBytes = 8_000_000;
export const readQueryTimeoutMs = 60_000;

export type ReadQueryValue = string | number | null;
export type ReadQueryParameters = ReadQueryValue[] | Record<string, ReadQueryValue>;

export type ReadQueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
};

export class ReadQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadQueryError";
  }
}

type SqlToken = {
  value: string;
  depth: number;
  kind: "word" | "symbol";
};

const readOnlyStatementKinds = new Set(["SELECT", "VALUES"]);
const explainModifiers = new Set(["QUERY", "PLAN"]);
const mutatingStatementKinds = new Set([
  "ALTER",
  "ATTACH",
  "BEGIN",
  "COMMIT",
  "CREATE",
  "DELETE",
  "DETACH",
  "DROP",
  "END",
  "INSERT",
  "PRAGMA",
  "REINDEX",
  "RELEASE",
  "REPLACE",
  "ROLLBACK",
  "SAVEPOINT",
  "VACUUM",
  "UPDATE",
]);
const bodyStatementKinds = new Set([...readOnlyStatementKinds, ...mutatingStatementKinds]);

function isSqlWordStart(character: string): boolean {
  return /[A-Za-z_]/.test(character);
}

function isSqlWordCharacter(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== quote) {
      index += 1;
      continue;
    }
    if (sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  throw new ReadQueryError("query contains an unterminated quoted value");
}

function skipBracketQuoted(sql: string, start: number): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== "]") {
      index += 1;
      continue;
    }
    if (sql[index + 1] === "]") {
      index += 2;
      continue;
    }
    return index + 1;
  }
  throw new ReadQueryError("query contains an unterminated quoted identifier");
}

function tokenize(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let depth = 0;
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (character === undefined) {
      break;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) {
        throw new ReadQueryError("query contains an unterminated comment");
      }
      index = end + 2;
      continue;
    }
    if (character === "'") {
      index = skipQuoted(sql, index, character);
      continue;
    }
    if (character === '"' || character === "`") {
      index = skipQuoted(sql, index, character);
      continue;
    }
    if (character === "[") {
      index = skipBracketQuoted(sql, index);
      continue;
    }
    if (character === "(") {
      tokens.push({ value: character, depth, kind: "symbol" });
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ")") {
      if (depth === 0) {
        throw new ReadQueryError("query contains an unmatched closing parenthesis");
      }
      depth -= 1;
      tokens.push({ value: character, depth, kind: "symbol" });
      index += 1;
      continue;
    }
    if (character === ";") {
      tokens.push({ value: character, depth, kind: "symbol" });
      index += 1;
      continue;
    }
    if (isSqlWordStart(character)) {
      const start = index;
      index += 1;
      while (index < sql.length) {
        const next = sql[index];
        if (next === undefined || !isSqlWordCharacter(next)) {
          break;
        }
        index += 1;
      }
      tokens.push({ value: sql.slice(start, index).toUpperCase(), depth, kind: "word" });
      continue;
    }
    index += 1;
  }
  if (depth !== 0) {
    throw new ReadQueryError("query contains an unmatched opening parenthesis");
  }
  return tokens;
}

function topLevelBodyKind(tokens: SqlToken[], start: number): string | null {
  for (const token of tokens.slice(start + 1)) {
    if (token.kind === "word" && token.depth === 0 && bodyStatementKinds.has(token.value)) {
      return token.value;
    }
  }
  return null;
}

function statementKind(tokens: SqlToken[]): string | null {
  const firstIndex = tokens.findIndex((token) => token.kind === "word");
  const first = tokens[firstIndex];
  if (!first || first.depth !== 0) {
    return null;
  }
  if (first.value === "WITH") {
    return topLevelBodyKind(tokens, firstIndex);
  }
  if (first.value === "EXPLAIN") {
    const words = tokens
      .slice(firstIndex + 1)
      .filter((token) => token.kind === "word" && token.depth === 0)
      .map((token) => token.value);
    let index = 0;
    while (index < words.length && explainModifiers.has(words[index] ?? "")) {
      index += 1;
    }
    const explained = words[index];
    if (explained === "WITH") {
      return topLevelBodyKind(
        tokens,
        tokens.findIndex(
          (token) => token.kind === "word" && token.depth === 0 && token.value === "WITH",
        ),
      );
    }
    return explained ?? null;
  }
  return first.value;
}

function assertSingleStatement(tokens: SqlToken[]): void {
  const semicolons = tokens.filter((token) => token.value === ";");
  if (semicolons.length > 1) {
    throw new ReadQueryError("only one SQL statement is allowed");
  }
  const semicolon = semicolons[0];
  if (semicolon && tokens[tokens.length - 1] !== semicolon) {
    throw new ReadQueryError("multiple SQL statements are not allowed");
  }
}

export function validateReadOnlyQuery(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new ReadQueryError("sql is required");
  }
  if (trimmed.length > maxReadQuerySqlLength) {
    throw new ReadQueryError(`sql must be at most ${maxReadQuerySqlLength} characters`);
  }
  const tokens = tokenize(trimmed);
  assertSingleStatement(tokens);
  const kind = statementKind(tokens);
  if (!kind || !readOnlyStatementKinds.has(kind)) {
    throw new ReadQueryError(
      "only SELECT, VALUES, read-only WITH, and read-only EXPLAIN queries are allowed",
    );
  }
  if (
    tokens.some(
      (token) =>
        token.kind === "word" && token.depth === 0 && mutatingStatementKinds.has(token.value),
    )
  ) {
    throw new ReadQueryError("mutating SQL statements are not allowed");
  }
}

export function isReadQueryValue(value: unknown): value is ReadQueryValue {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export function isReadQueryParameters(value: unknown): value is ReadQueryParameters {
  if (Array.isArray(value)) {
    return value.every(isReadQueryValue);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.entries(value).every(([key, parameter]) => {
    const validName = /^(?:[$:@][A-Za-z_][A-Za-z0-9_]*|\?[0-9]+)$/.test(key);
    return validName && isReadQueryValue(parameter);
  });
}

export function readQuery(
  connection: Database,
  sql: string,
  parameters: ReadQueryParameters = [],
  maxRows = defaultReadQueryRows,
): ReadQueryResult {
  validateReadOnlyQuery(sql);
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > maxReadQueryRows) {
    throw new ReadQueryError(`maxRows must be an integer from 1 to ${maxReadQueryRows}`);
  }

  let statement: ReturnType<Database["query"]> | null = null;
  try {
    statement = connection.query(sql);
    const rows: Record<string, unknown>[] = [];
    let resultBytes = 0;
    let truncated = false;
    const rowsIterator = Array.isArray(parameters)
      ? statement.iterate(...parameters)
      : statement.iterate(parameters);
    const encoder = new TextEncoder();
    for (const row of rowsIterator) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      const rowBytes = encoder.encode(JSON.stringify(row)).byteLength;
      if (resultBytes + rowBytes > maxReadQueryResultBytes) {
        if (rows.length === 0) {
          throw new ReadQueryError(
            `the first result row exceeds the ${maxReadQueryResultBytes}-byte result limit`,
          );
        }
        truncated = true;
        break;
      }
      rows.push(row as Record<string, unknown>);
      resultBytes += rowBytes;
    }
    return { columns: statement.columnNames, rows, truncated };
  } catch (error) {
    if (error instanceof ReadQueryError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ReadQueryError(`read-only query failed: ${message}`);
  } finally {
    statement?.finalize();
  }
}
