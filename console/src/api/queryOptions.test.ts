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

  test("leaves the refetch on mount to the stale time", () => {
    expect("refetchOnMount" in systemStatusQueryOptions()).toBe(false);
  });
});
