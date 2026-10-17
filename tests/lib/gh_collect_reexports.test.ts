// 移したモジュールの名前が、元のモジュールからも同じ値として読めることのテスト。
// instanceofや定数の比較が、どちらの経路で読んでも食い違わないようにする。

import { describe, expect, test } from "bun:test";
import * as ghErrors from "../../f/factory/lib/gh_errors.ts";
import * as github from "../../f/factory/lib/github.ts";
import * as jobTmp from "../../f/factory/lib/job_tmp.ts";
import * as jobTmpLimits from "../../f/factory/lib/job_tmp_limits.ts";
import * as ownerIdGate from "../../f/factory/lib/owner_id_gate.ts";
import * as pollSupport from "../../f/factory/lib/poll_support.ts";

describe("re-exports of moved names", () => {
  test("github.ts re-exports GitHubHttpError from gh_errors.ts", () => {
    expect(github.GitHubHttpError).toBe(ghErrors.GitHubHttpError);
  });

  test("job_tmp.ts re-exports JOB_TMP_MAX_AGE_SEC from job_tmp_limits.ts", () => {
    expect(jobTmp.JOB_TMP_MAX_AGE_SEC).toBe(jobTmpLimits.JOB_TMP_MAX_AGE_SEC);
  });

  test("job_tmp_limits.ts keeps the three-day limit", () => {
    expect(jobTmpLimits.JOB_TMP_MAX_AGE_SEC).toBe(3 * 24 * 60 * 60);
  });

  test("poll_support.ts re-exports OWNER_ID_MISMATCH_KIND", () => {
    expect(pollSupport.OWNER_ID_MISMATCH_KIND).toBe(
      ownerIdGate.OWNER_ID_MISMATCH_KIND,
    );
  });

  test("poll_support.ts re-exports ownerIdMismatchMessage", () => {
    expect(pollSupport.ownerIdMismatchMessage).toBe(
      ownerIdGate.ownerIdMismatchMessage,
    );
  });

  test("poll_support.ts re-exports ownerNotFoundMessage", () => {
    expect(pollSupport.ownerNotFoundMessage).toBe(
      ownerIdGate.ownerNotFoundMessage,
    );
  });

  test("poll_support.ts re-exports gateOwnerId", () => {
    expect(pollSupport.gateOwnerId).toBe(ownerIdGate.gateOwnerId);
  });
});
