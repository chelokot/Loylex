import { describe, expect, test } from "bun:test";
import { resolveModel } from "../src/agent/config.ts";

describe("agent model configuration", () => {
  test("migrates the temporary legacy Luna pin to GPT-6 Luna", () => {
    expect(resolveModel("gpt-5.6-luna")).toBe("gpt-6-luna");
  });

  test("keeps other explicit model selections", () => {
    expect(resolveModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  test("defaults to GPT-6 Luna", () => {
    expect(resolveModel(undefined)).toBe("gpt-6-luna");
  });
});
