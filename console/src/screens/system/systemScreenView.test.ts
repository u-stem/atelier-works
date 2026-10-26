import { describe, expect, test } from "bun:test";
import { ApiFailure } from "../../api/errors.ts";
import {
  type FailureQuery,
  needsTabSwitch,
  shouldRunJump,
  systemFailedTabs,
} from "./systemScreenView.ts";

const OK: FailureQuery = { isError: false, error: null };
const NETWORK: FailureQuery = {
  isError: true,
  error: new ApiFailure({ kind: "network" }),
};
const UNAUTHORIZED: FailureQuery = {
  isError: true,
  error: new ApiFailure({ kind: "unauthorized" }),
};

const FINE = {
  status: OK,
  holds: OK,
  summary: OK,
  deployments: OK,
  config: OK,
};

describe("systemFailedTabs", () => {
  test("is false everywhere when every fetch is fine", () => {
    expect(systemFailedTabs(FINE)).toEqual({
      status: false,
      failures: false,
      history: false,
      config: false,
    });
  });

  test("blames the status and the holds on the status tab", () => {
    expect(systemFailedTabs({ ...FINE, holds: NETWORK }).status).toBe(true);
  });

  test("does not blame the holds on the other tabs", () => {
    const failed = systemFailedTabs({ ...FINE, holds: NETWORK });
    expect([failed.failures, failed.history]).toEqual([false, false]);
  });

  test("blames the summary on the failures tab only", () => {
    expect(systemFailedTabs({ ...FINE, summary: NETWORK })).toEqual({
      status: false,
      failures: true,
      history: false,
      config: false,
    });
  });

  test("blames the deployments on the history tab only", () => {
    expect(systemFailedTabs({ ...FINE, deployments: NETWORK })).toEqual({
      status: false,
      failures: false,
      history: true,
      config: false,
    });
  });

  test("blames the status on all three tabs, which read it", () => {
    expect(systemFailedTabs({ ...FINE, status: NETWORK })).toEqual({
      status: true,
      failures: true,
      history: true,
      config: false,
    });
  });

  test("leaves a login failure to the banner at the top", () => {
    expect(systemFailedTabs({ ...FINE, status: UNAUTHORIZED })).toEqual({
      status: false,
      failures: false,
      history: false,
      config: false,
    });
  });

  test("counts a failed refetch even when an older value remains", () => {
    expect(
      systemFailedTabs({ ...FINE, summary: { ...NETWORK, isError: true } })
        .failures,
    ).toBe(true);
  });
});

describe("systemFailedTabs for the config", () => {
  test("blames the config fetch on the config tab only", () => {
    expect(systemFailedTabs({ ...FINE, config: NETWORK })).toEqual({
      status: false,
      failures: false,
      history: false,
      config: true,
    });
  });

  test("does not blame the status fetch on the config tab", () => {
    expect(systemFailedTabs({ ...FINE, status: NETWORK }).config).toBe(false);
  });

  test("leaves a login failure of the config to the banner", () => {
    expect(systemFailedTabs({ ...FINE, config: UNAUTHORIZED }).config).toBe(
      false,
    );
  });
});

describe("shouldRunJump", () => {
  test("does nothing without a pending jump", () => {
    expect(shouldRunJump(null, "status")).toBe(false);
  });

  test("runs when the target tab is open", () => {
    expect(
      shouldRunJump(
        { tab: "failures", id: "audit-failures-heading" },
        "failures",
      ),
    ).toBe(true);
  });

  test("waits while another tab is still open", () => {
    expect(
      shouldRunJump(
        { tab: "failures", id: "audit-failures-heading" },
        "status",
      ),
    ).toBe(false);
  });
});

describe("needsTabSwitch", () => {
  test("switches to a tab that is not open", () => {
    expect(needsTabSwitch("failures", "status")).toBe(true);
  });

  test("stays on the open tab", () => {
    expect(needsTabSwitch("status", "status")).toBe(false);
  });
});
