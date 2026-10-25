import { describe, expect, test } from "bun:test";
import {
  deploymentsQueryKey,
  deploymentsQueryOptions,
  pipelineQueryKey,
  pipelineQueryOptions,
  requirementsIndexQueryKey,
  requirementsIndexQueryOptions,
} from "./queries.ts";
import {
  refetchSystemStatusOnMount,
  SYSTEM_STATUS_REUSE_MS,
  systemStatusQueryKey,
  systemStatusQueryOptions,
} from "./systemQueries.ts";

describe("deploymentsQueryOptions", () => {
  test("uses the deployments key", () => {
    expect(deploymentsQueryOptions().queryKey).toEqual(deploymentsQueryKey);
  });

  test("treats the history as fresh for a minute", () => {
    expect(deploymentsQueryOptions().staleTime).toBe(60_000);
  });
});

describe("pipelineQueryOptions", () => {
  test("uses the pipeline key", () => {
    expect(pipelineQueryOptions().queryKey).toEqual(pipelineQueryKey);
  });

  test("treats the list as fresh for 30 seconds", () => {
    expect(pipelineQueryOptions().staleTime).toBe(30_000);
  });
});

describe("requirementsIndexQueryOptions", () => {
  test("uses the requirements index key", () => {
    expect(requirementsIndexQueryOptions().queryKey).toEqual(
      requirementsIndexQueryKey,
    );
  });

  test("treats the list as fresh for 30 seconds", () => {
    expect(requirementsIndexQueryOptions().staleTime).toBe(30_000);
  });
});

describe("systemStatusQueryOptions", () => {
  test("uses the system status key", () => {
    expect(systemStatusQueryOptions().queryKey).toEqual(systemStatusQueryKey);
  });

  test("treats the status as fresh for 30 seconds", () => {
    expect(systemStatusQueryOptions().staleTime).toBe(30_000);
  });

  test("decides on every mount whether to refetch", () => {
    expect(typeof systemStatusQueryOptions().refetchOnMount).toBe("function");
  });
});

describe("refetchSystemStatusOnMount", () => {
  const NOW = 1_000_000;

  test("reuses data fetched just now, such as a prefetch", () => {
    expect(refetchSystemStatusOnMount(NOW - 1_000, NOW)).toBe(false);
  });

  test("reuses data one millisecond inside the window", () => {
    expect(
      refetchSystemStatusOnMount(NOW - SYSTEM_STATUS_REUSE_MS + 1, NOW),
    ).toBe(false);
  });

  test("refetches data exactly at the window", () => {
    expect(refetchSystemStatusOnMount(NOW - SYSTEM_STATUS_REUSE_MS, NOW)).toBe(
      "always",
    );
  });

  test("refetches old data so a resolved notice does not stay", () => {
    expect(refetchSystemStatusOnMount(NOW - 20_000, NOW)).toBe("always");
  });

  test("refetches when nothing has been fetched yet", () => {
    expect(refetchSystemStatusOnMount(0, NOW)).toBe("always");
  });

  test("keeps the window shorter than the stale time", () => {
    expect(SYSTEM_STATUS_REUSE_MS).toBeLessThan(
      systemStatusQueryOptions().staleTime,
    );
  });
});
