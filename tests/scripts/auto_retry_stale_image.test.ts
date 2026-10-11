import { describe, expect, test } from "bun:test";

// `auto_retry_stale_image.ts`が、libの依存を正しい関数と引数につないでいることを、
// ソースの文字列照合で固定する。構文は解析しないので、書き方を変えると実装が正しくても落ちる。
// そのときは照合を直す。目的は、リースの扱いや候補の数の取り違えに気づくことである。

/** コメントを除いたscriptのソース。 */
async function scriptSource(): Promise<string> {
  const text = await Bun.file("f/factory/auto_retry_stale_image.ts").text();
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

describe("auto_retry_stale_image wiring", () => {
  test("rolls back with the lease holder the restart left behind", async () => {
    const source = await scriptSource();

    expect(source).toContain("plan.leased ? null : candidate.flow_job_id");
  });

  test("rolls back to needs_human", async () => {
    const source = await scriptSource();

    expect(source).toMatch(
      /updateStatusIfLeaseHolder\(\s*candidate\.id,\s*plan\.toStatus,\s*"needs_human",/,
    );
  });

  test("clears the flow job id only for the flows that use it as a lease", async () => {
    const source = await scriptSource();

    expect(source).toContain("clearFlowJobId: plan.leased,");
  });

  test("records the job id only when unset for a leased flow", async () => {
    const source = await scriptSource();

    expect(source).toContain(
      "if (leased) return setFlowJobIdIfUnset(id, jobId);",
    );
  });

  test("reads more candidates than it restarts in one run", async () => {
    const source = await scriptSource();

    expect(source).toContain("limit: AUTO_RETRY_LIST_LIMIT,");
  });

  test("passes the restart cap and note prefix to the candidate query", async () => {
    const source = await scriptSource();

    expect(source).toMatch(
      /notePrefix: AUTO_RETRY_NOTE_PREFIX,\s*maxRestarts: AUTO_RETRY_MAX_RESTARTS,\s*limit:/,
    );
  });

  test("restricts the candidates and the restart to notices the self update resolved", async () => {
    const source = await scriptSource();

    expect(source.match(/resolvedBy: HOST_ACTION_RESOLVER,/g)).toHaveLength(2);
  });

  test("restricts the restart to the stale image notice", async () => {
    const source = await scriptSource();

    expect(source).toMatch(
      /restartStoppedWorkItem\(\{[\s\S]*?noticeMarker: STALE_IMAGE_NOTICE_MARKER,/,
    );
  });
});
