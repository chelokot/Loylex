import type { JsonObject, JsonValue } from "./types.ts";

const telegramApiNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const telegramApiMaxFileCount = 10;
export const telegramApiMaxFileBytes = 50 * 1024 * 1024;
export const telegramApiMaxTotalFileBytes = 100 * 1024 * 1024;

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number") {
    return true;
  }
  if (typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== "object") {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value);
}

export function isTelegramApiMethod(value: unknown): value is string {
  return typeof value === "string" && telegramApiNamePattern.test(value);
}

export function isTelegramApiFieldName(value: unknown): value is string {
  return typeof value === "string" && telegramApiNamePattern.test(value);
}
