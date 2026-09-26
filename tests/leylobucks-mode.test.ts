import { afterEach, describe, expect, test } from "bun:test";
import { LeylobucksMode } from "../src/gateway/leylobucks-mode.ts";

describe("Loylebucks mode", () => {
  let mode: LeylobucksMode;
  let enabledByUser: Map<number, boolean>;

  afterEach(() => {
    mode = new LeylobucksMode({
      isEnabled: (userId) => enabledByUser.get(userId) ?? true,
      setEnabled: (userId, enabled) => enabledByUser.set(userId, enabled),
    });
  });

  function createMode(): LeylobucksMode {
    enabledByUser = new Map();
    return new LeylobucksMode({
      isEnabled: (userId) => enabledByUser.get(userId) ?? true,
      setEnabled: (userId, enabled) => enabledByUser.set(userId, enabled),
    });
  }

  test("starts enabled without stored state", () => {
    mode = createMode();
    expect(mode.isEnabled(100)).toBe(true);
    expect(mode.isEnabled(null)).toBe(true);
  });

  test("toggles independently per user and defaults new users to enabled", () => {
    mode = createMode();
    mode.setEnabled(100, false);

    expect(mode.isEnabled(100)).toBe(false);
    expect(mode.isEnabled(200)).toBe(true);

    mode.setEnabled(100, true);
    expect(mode.isEnabled(100)).toBe(true);
  });

  test("shares stored state across runtime instances", () => {
    mode = createMode();
    mode.setEnabled(100, false);

    const restartedMode = new LeylobucksMode({
      isEnabled: (userId) => enabledByUser.get(userId) ?? true,
      setEnabled: (userId, enabled) => enabledByUser.set(userId, enabled),
    });
    expect(restartedMode.isEnabled(100)).toBe(false);
  });
});
