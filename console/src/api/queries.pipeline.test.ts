import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import {
  fetchPipeline,
  PIPELINE_DAYS,
  PIPELINE_LIMIT,
  pipelineQueryKey,
} from "./queries.ts";
import type { FetchLike } from "./windmill.ts";

const ROW = {
  work_item_id: 7,
  cycle: 1,
  source: "issue",
  owner: "o",
  repo: "r",
  issue_number: 9,
  issue_url: "https://github.com/o/r/issues/9",
  title: "Fix bug",
  status: "pr_open",
  attempt: 1,
  claimed_by: null,
  flow_job_id: null,
  created_at: "2026-10-08T00:00:00.000Z",
  updated_at: "2026-10-08T00:00:00.000Z",
  kind: "issue",
  pr_number: 12,
  fix_round: 0,
  branch: "factory/issue-9-wi-7",
  pr_url: "https://github.com/o/r/pull/12",
};

function respondWith(body: string, status = 200): FetchLike {
  return () => Promise.resolve(new Response(body, { status }));
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof ApiFailure ? error.apiError : error;
  }
}

describe("fetchPipeline", () => {
  test("returns a valid list of work items", async () => {
    expect(
      await fetchPipeline({ fetchFn: respondWith(JSON.stringify([ROW])) }),
    ).toEqual([ROW]);
  });

  test("asks for the pipeline view within the period and limit", async () => {
    let body = "";
    const fetchFn: FetchLike = (_input, init) => {
      body = String(init.body);
      return Promise.resolve(new Response("[]"));
    };
    await fetchPipeline({ fetchFn });
    expect(JSON.parse(body)).toEqual({
      view: "pipeline",
      limit: PIPELINE_LIMIT,
      days: PIPELINE_DAYS,
    });
  });

  test("throws invalid_response for an object instead of a list", async () => {
    expect(
      await failureOf(fetchPipeline({ fetchFn: respondWith("{}") })),
    ).toEqual({ kind: "invalid_response" });
  });

  test("throws invalid_response when one row has lost a field", async () => {
    const broken = { ...ROW, status: undefined };
    expect(
      await failureOf(
        fetchPipeline({ fetchFn: respondWith(JSON.stringify([broken])) }),
      ),
    ).toEqual({ kind: "invalid_response" });
  });

  test("throws forbidden on 403", async () => {
    expect(
      await failureOf(fetchPipeline({ fetchFn: respondWith("no", 403) })),
    ).toEqual({ kind: "forbidden" });
  });
});

describe("pipelineQueryKey", () => {
  test("is scoped under the console", () => {
    expect(pipelineQueryKey).toEqual(["console", "pipeline"]);
  });
});
