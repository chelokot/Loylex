import { afterEach, describe, expect, test } from "bun:test";
import { LeylobucksMode } from "../src/gateway/leylobucks-mode.ts";

describe("Loylebucks runtime mode", () => {
  let mode: LeylobucksMode;

  afterEach(() => {
    mode = new LeylobucksMode();
  });

  test("starts enabled without persistent state", () => {
    mode = new LeylobucksMode();
    expect(mode.isEnabled(100)).toBe(true);
    expect(mode.isEnabled(null)).toBe(true);
  });

  test("toggles independently per user and defaults new users to enabled", () => {
    mode = new LeylobucksMode();
    mode.setEnabled(100, false);

    expect(mode.isEnabled(100)).toBe(false);
    expect(mode.isEnabled(200)).toBe(true);

    mode.setEnabled(100, true);
    expect(mode.isEnabled(100)).toBe(true);
  });

  test("does not survive a new runtime instance", () => {
    mode = new LeylobucksMode();
    mode.setEnabled(100, false);

    expect(new LeylobucksMode().isEnabled(100)).toBe(true);
  });
});
