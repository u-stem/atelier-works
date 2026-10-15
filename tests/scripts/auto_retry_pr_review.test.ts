import { describe, expect, test } from "bun:test";

// `auto_retry_pr_review.ts`が、libの依存を正しい関数と引数につないでいることを、
// ソースの文字列照合で固定する。構文は解析しないので、書き方を変えると実装が正しくても落ちる。
// そのときは照合を直す。目的は、リースの扱い、見送りの検出の条件、通知の順序の取り違えに気づくことである。

/** コメントを除いたscriptのソース。 */
async function scriptSource(): Promise<string> {
  const text = await Bun.file("f/factory/auto_retry_pr_review.ts").text();
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

describe("auto_retry_pr_review wiring", () => {
  test("looks for stalled reviews with the grace period", async () => {
    const source = await scriptSource();

    expect(source).toContain(
      "extraGraceSeconds: TRANSIENT_STALL_GRACE_SECONDS,",
    );
  });

  test("looks only for stalled reviews that were not told about yet", async () => {
    const source = await scriptSource();

    expect(source).toContain("unnotifiedOnly: true,");
  });

  test("rolls back with the empty lease the restart left behind", async () => {
    const source = await scriptSource();

    expect(source).toMatch(
      /updateStatusIfLeaseHolder\(\s*candidate\.id,\s*"reviewing",\s*"needs_human",\s*null,/,
    );
  });

  test("records the job id only when it is unset", async () => {
    const source = await scriptSource();

    expect(source).toContain(
      "recordFlowJobId: (id, jobId) => setFlowJobIdIfUnset(id, jobId),",
    );
  });

  test("records a stall only after the notice was delivered", async () => {
    const source = await scriptSource();

    expect(source).toContain('return delivery.status === "sent";');
  });

  test("throws the retry error after the stall notices", async () => {
    const source = await scriptSource();

    expect(source.indexOf("notifyStalledTransientReviews({")).toBeLessThan(
      source.indexOf("if (retryError !== null) throw retryError;"),
    );
  });
});
