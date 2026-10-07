import { describe, expect, test } from "bun:test";
import { describeRetry } from "./retryResult";

describe("describeRetry", () => {
  test("reports a recorded restart as started", () => {
    expect(
      describeRetry({
        ok: true,
        status: "implementing",
        started_job_id: "job-1",
        flow_job_id: "job-1",
      }),
    ).toBe("再実行を開始しました");
  });

  test("reports a restart that was launched but not recorded because another run holds the lease", () => {
    expect(
      describeRetry({
        ok: false,
        status: "implementing",
        started_job_id: "job-1",
        flow_job_id: null,
      }),
    ).toBe(
      "再実行のフローを起動しましたが、別の実行がリースを持っているため、この作業項目には記録していません",
    );
  });

  test("treats a result without ok as started", () => {
    expect(describeRetry(null)).toBe("再実行を開始しました");
  });
});
