import { describe, expect, test } from "bun:test";
import { type ApiError, ApiFailure } from "../api/errors.ts";
import {
  apiErrorOf,
  describeQueryFailure,
  isViewMismatch,
} from "./queryFailureView.ts";

const VIEW_MISMATCH: ApiError = {
  kind: "http",
  status: 422,
  detail:
    'console_query: "view" must be one of inbox, pipeline, agent_cost_daily (got "deployments")',
};

describe("apiErrorOf", () => {
  test("returns the classified error of an ApiFailure", () => {
    expect(apiErrorOf(new ApiFailure({ kind: "network" }))).toEqual({
      kind: "network",
    });
  });

  test("returns null for an unrelated error", () => {
    expect(apiErrorOf(new Error("boom"))).toBeNull();
  });
});

describe("isViewMismatch", () => {
  test("is true for a 422 about the view", () => {
    expect(isViewMismatch(VIEW_MISMATCH)).toBe(true);
  });

  test("is false for a 422 about something else", () => {
    expect(
      isViewMismatch({ kind: "http", status: 422, detail: "bad args" }),
    ).toBe(false);
  });

  test("is false for the same text with another status", () => {
    expect(isViewMismatch({ ...VIEW_MISMATCH, status: 400 })).toBe(false);
  });

  test("is false for a failed job with the same text", () => {
    expect(
      isViewMismatch({ kind: "job_failed", message: VIEW_MISMATCH.detail }),
    ).toBe(false);
  });
});

describe("describeQueryFailure for a view mismatch", () => {
  test("says the console and the backend may be out of step", () => {
    expect(describeQueryFailure(VIEW_MISMATCH).summary).toContain("版がずれて");
  });

  test("keeps the server text only in the detail", () => {
    expect(describeQueryFailure(VIEW_MISMATCH).detail).toBe(
      VIEW_MISMATCH.detail,
    );
  });

  test("does not put the server text in the summary", () => {
    expect(describeQueryFailure(VIEW_MISMATCH).summary).not.toContain(
      "must be one of",
    );
  });

  test("does not put the server text in the next step", () => {
    expect(describeQueryFailure(VIEW_MISMATCH).nextStep).not.toContain(
      "must be one of",
    );
  });

  test("tells the operator to reload the console", () => {
    expect(describeQueryFailure(VIEW_MISMATCH).nextStep).toContain(
      "読み込み直",
    );
  });
});

describe("describeQueryFailure", () => {
  test("keeps the status in the summary of another http error", () => {
    expect(
      describeQueryFailure({ kind: "http", status: 502, detail: "" }).summary,
    ).toContain("502");
  });

  test("puts the detail of another 4xx in the detail", () => {
    expect(
      describeQueryFailure({ kind: "http", status: 400, detail: "bad tag" })
        .detail,
    ).toBe("bad tag");
  });

  test("does not mention a version mismatch for another http error", () => {
    expect(
      describeQueryFailure({ kind: "http", status: 502, detail: "" }).summary,
    ).not.toContain("版がずれて");
  });

  test("puts the message of a failed job in the detail", () => {
    expect(
      describeQueryFailure({ kind: "job_failed", message: "db down" }).detail,
    ).toBe("db down");
  });

  test("keeps the message of a failed job out of the summary", () => {
    expect(
      describeQueryFailure({ kind: "job_failed", message: "db down" }).summary,
    ).not.toContain("db down");
  });

  test("has no detail when the server sent no text", () => {
    expect(describeQueryFailure({ kind: "network" }).detail).toBe("");
  });

  test("asks to log in again for unauthorized", () => {
    expect(describeQueryFailure({ kind: "unauthorized" }).summary).toContain(
      "ログイン",
    );
  });

  test("says the response did not arrive in time for a timeout", () => {
    expect(
      describeQueryFailure({ kind: "timeout_or_unknown" }).summary,
    ).toContain("時間内");
  });

  test("says the connection failed for a network failure", () => {
    expect(describeQueryFailure({ kind: "network" }).summary).toContain(
      "接続できませんでした",
    );
  });

  test("says the response was unreadable for an invalid response", () => {
    expect(
      describeQueryFailure({ kind: "invalid_response" }).summary,
    ).toContain("読み取れませんでした");
  });

  test("says the cause is unknown when the error is not classified", () => {
    expect(describeQueryFailure(null).summary).toBe("原因は不明です。");
  });

  test("gives a next step for every kind", () => {
    const errors: ApiError[] = [
      { kind: "unauthorized" },
      { kind: "forbidden" },
      { kind: "job_failed", message: "" },
      { kind: "timeout_or_unknown" },
      { kind: "http", status: 500, detail: "" },
      { kind: "network" },
      { kind: "invalid_response" },
    ];
    expect(
      errors.map((error) => describeQueryFailure(error).nextStep),
    ).not.toContain("");
  });
});
