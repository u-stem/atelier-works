import { describe, expect, test } from "bun:test";
import { holdsQueryKey } from "./holdsQueries.ts";
import { stopAllConfig, stopAllReleaseConfig } from "./stopAllConfig.ts";
import { systemStatusQueryKey } from "./systemQueries.ts";

const notices = { onNotice: () => undefined };

describe("stopAllConfig", () => {
  test("locks every stop on the same key", () => {
    const config = stopAllConfig(notices);
    expect(config.keyOf("one")).toBe(config.keyOf("two"));
  });

  test("shares the lock with the release", () => {
    expect(stopAllConfig(notices).keyOf("one")).toBe(
      stopAllReleaseConfig(notices).keyOf(null),
    );
  });

  test("reads the holds and the system status again", () => {
    expect(stopAllConfig(notices).invalidates).toEqual([
      holdsQueryKey,
      systemStatusQueryKey,
    ]);
  });
});
