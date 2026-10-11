import { describe, expect, test } from "bun:test";
import { type ApiError, ApiFailure } from "../api/errors.ts";
import {
  apiErrorOf,
  describeQueryFailure,
  isViewMismatch,
} from "./queryFailureView.ts";

const MISMATCH_TEXT =
  'console_query: "view" must be one of inbox, pipeline, agent_cost_daily (got "deployments")';

const VIEW_MISMATCH: ApiError = {
  kind: "http",
  status: 422,
  detail: MISMATCH_TEXT,
};

const VIEW_MISMATCH_AS_JOB_FAILURE: ApiError = {
  kind: "job_failed",
  message: MISMATCH_TEXT,
};

const SYSTEM_STATUS_MISMATCH: ApiError = {
  kind: "http",
  status: 422,
  detail:
    'console_query: "view" must be one of inbox, pipeline (got "system_status")',
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
  test("is true for an http error about the view", () => {
    expect(isViewMismatch(VIEW_MISMATCH)).toBe(true);
  });

  test("is true for a failed job about the view", () => {
    expect(isViewMismatch(VIEW_MISMATCH_AS_JOB_FAILURE)).toBe(true);
  });

  test("is true whatever the http status is", () => {
    expect(isViewMismatch({ ...VIEW_MISMATCH, status: 400 })).toBe(true);
  });

  test("is false for an http error about something else", () => {
    expect(
      isViewMismatch({ kind: "http", status: 422, detail: "bad args" }),
    ).toBe(false);
  });

  test("is false for a failed job about something else", () => {
    expect(isViewMismatch({ kind: "job_failed", message: "db down" })).toBe(
      false,
    );
  });

  test("is false for an error without server text", () => {
    expect(isViewMismatch({ kind: "network" })).toBe(false);
  });
});

describe("describeQueryFailure for a view mismatch", () => {
  test("says the console and the backend may be out of step", () => {
    expect(describeQueryFailure(VIEW_MISMATCH).summary).toContain("版がずれて");
  });

  test("says so for a failed job as well", () => {
    expect(
      describeQueryFailure(VIEW_MISMATCH_AS_JOB_FAILURE).summary,
    ).toContain("版がずれて");
  });

  test("keeps the server text only in the detail", () => {
    expect(describeQueryFailure(VIEW_MISMATCH).detail).toBe(MISMATCH_TEXT);
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

  test("tells the operator to wait for the next update first", () => {
    expect(describeQueryFailure(VIEW_MISMATCH).nextStep).toContain(
      "反映は10分ごとなので、しばらく待ってから開き直してください",
    );
  });

  test("tells the operator to compare the two versions", () => {
    expect(describeQueryFailure(VIEW_MISMATCH).nextStep).toContain(
      "「反映した版」と「Consoleの取り込み」の版を見比べ",
    );
  });

  test("tells the operator to wait even when system_status failed", () => {
    expect(describeQueryFailure(SYSTEM_STATUS_MISMATCH).nextStep).toContain(
      "しばらく待ってから開き直してください",
    );
  });

  test("points to the system screen to check the last update", () => {
    expect(describeQueryFailure(VIEW_MISMATCH).nextStep).toContain(
      "システムの画面",
    );
  });

  test("points to the self_update job log", () => {
    expect(describeQueryFailure(VIEW_MISMATCH).nextStep).toContain(
      "self_updateのジョブのログ",
    );
  });

  test("does not point to the system screen when system_status failed", () => {
    expect(describeQueryFailure(SYSTEM_STATUS_MISMATCH).nextStep).not.toContain(
      "システムの画面",
    );
  });

  test("still points to the self_update job log when system_status failed", () => {
    expect(describeQueryFailure(SYSTEM_STATUS_MISMATCH).nextStep).toContain(
      "self_updateのジョブのログ",
    );
  });
});

describe("describeQueryFailure detail", () => {
  test("replaces control characters in the server text", () => {
    expect(
      describeQueryFailure({
        kind: "http",
        status: 400,
        detail: "bad\u0007tag",
      }).detail,
    ).toBe("bad�tag");
  });

  test("replaces bidirectional controls in the server text", () => {
    expect(
      describeQueryFailure({ kind: "job_failed", message: "a‮b" }).detail,
    ).toBe("a�b");
  });

  test("replaces zero-width characters in the server text", () => {
    expect(
      describeQueryFailure({ kind: "job_failed", message: "a​b" }).detail,
    ).toBe("a�b");
  });

  test("keeps line breaks in the server text", () => {
    expect(
      describeQueryFailure({ kind: "job_failed", message: "a\nb" }).detail,
    ).toBe("a\nb");
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

  test("points a 4xx to the worker tag and permissions through the detail", () => {
    expect(
      describeQueryFailure({ kind: "http", status: 400, detail: "bad tag" })
        .nextStep,
    ).toContain(
      "詳細の文を手がかりに、Windmillのworkerのtagと権限、またはジョブのログを確かめて",
    );
  });

  test("points a 4xx without a detail to the worker tag and permissions", () => {
    expect(
      describeQueryFailure({ kind: "http", status: 400, detail: "" }).nextStep,
    ).toBe(
      "Windmillのworkerのtagと権限、またはジョブのログを確かめてください。",
    );
  });

  test("points forbidden to the account permissions as well", () => {
    expect(describeQueryFailure({ kind: "forbidden" }).nextStep).toContain(
      "アカウントの権限",
    );
  });

  test("points an invalid response to the self_update log when the system screen does not open", () => {
    expect(
      describeQueryFailure({ kind: "invalid_response" }).nextStep,
    ).toContain(
      "システムの画面が開けないときは、Windmillでself_updateのジョブのログを確かめてください",
    );
  });

  test("points an invalid response to the version check", () => {
    expect(
      describeQueryFailure({ kind: "invalid_response" }).nextStep,
    ).toContain("「反映した版」と「Consoleの取り込み」の版を見比べ");
  });

  test("points a failed job to the job log through the detail", () => {
    expect(
      describeQueryFailure({ kind: "job_failed", message: "db down" }).nextStep,
    ).toContain("詳細の文を手がかりに、Windmillでジョブのログを確かめて");
  });

  test("points a failed job without a message to the job log", () => {
    expect(
      describeQueryFailure({ kind: "job_failed", message: "" }).nextStep,
    ).toBe("Windmillでジョブのログを確かめてください。");
  });

  test("does not tell a failed job to wait and reopen", () => {
    expect(
      describeQueryFailure({ kind: "job_failed", message: "db down" }).nextStep,
    ).not.toContain("時間をおいて");
  });

  test("tells a 5xx to retry later", () => {
    expect(
      describeQueryFailure({ kind: "http", status: 502, detail: "" }).nextStep,
    ).toContain("時間をおいて");
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

  test("says the request was refused for forbidden", () => {
    expect(describeQueryFailure({ kind: "forbidden" }).summary).toContain(
      "断られ",
    );
  });

  test("points forbidden to the Origin and Host checks", () => {
    expect(describeQueryFailure({ kind: "forbidden" }).nextStep).toContain(
      "OriginやHostなどの検査",
    );
  });

  test("does not send forbidden to an administrator", () => {
    expect(describeQueryFailure({ kind: "forbidden" }).nextStep).not.toContain(
      "管理者",
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

  test("says the versions may be out of step for an invalid response", () => {
    expect(
      describeQueryFailure({ kind: "invalid_response" }).summary,
    ).toContain("版がずれている可能性");
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
