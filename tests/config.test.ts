import { describe, expect, test } from "bun:test";
import { resolveModel, resolveReasoningEffort } from "../src/agent/config.ts";

describe("agent model configuration", () => {
  test("migrates previous Luna defaults to GPT-6.1 Sol", () => {
    expect(resolveModel("gpt-5.6-luna")).toBe("gpt-6.1-sol");
    expect(resolveModel("gpt-6-luna")).toBe("gpt-6.1-sol");
  });

  test("keeps other explicit model selections", () => {
    expect(resolveModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(resolveModel("gpt-6.1-sol")).toBe("gpt-6.1-sol");
  });

  test("defaults to GPT-6.1 Sol with low reasoning effort", () => {
    expect(resolveModel(undefined)).toBe("gpt-6.1-sol");
    expect(resolveReasoningEffort(undefined, undefined)).toBe("low");
  });

  test("migrates the old Luna maximum effort to low", () => {
    expect(resolveReasoningEffort("max", "gpt-5.6-luna")).toBe("low");
    expect(resolveReasoningEffort("max", "gpt-6-luna")).toBe("low");
  });

  test("preserves explicit effort choices", () => {
    expect(resolveReasoningEffort("high", "gpt-6-luna")).toBe("high");
    expect(resolveReasoningEffort("max", "gpt-5.6-sol")).toBe("max");
    expect(resolveReasoningEffort("max", undefined)).toBe("max");
  });
});
