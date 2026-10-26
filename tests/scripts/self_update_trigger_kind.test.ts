import { describe, expect, test } from "bun:test";
import {
  describeTriggerEnv,
  resolveTriggerKind,
} from "../../f/factory/lib/self_update_support.ts";

// 自己更新の起動の種類と、その判定に使った環境変数の記録の確認。
// 判定は入出力から切り離した関数なので、環境変数の写しで試験する。
// `self_update.ts`への組み込みは、ソースの文字列照合で固定する。構文は解析しないので、
// 呼び出しを別の形に書き換えると、実装が正しくても落ちることがある。そのときは照合を直す。

describe("resolveTriggerKind", () => {
  test("is schedule when the job came from a schedule", () => {
    expect(
      resolveTriggerKind({
        WM_JOB_ID: "job-1",
        WM_SCHEDULE_PATH: "f/factory/self_update",
      }),
    ).toBe("schedule");
  });

  test("is manual when the job has no schedule path", () => {
    expect(resolveTriggerKind({ WM_JOB_ID: "job-1" })).toBe("manual");
  });

  test("is manual when the schedule path is empty", () => {
    const env = { WM_JOB_ID: "job-1", WM_SCHEDULE_PATH: "" };

    expect(resolveTriggerKind(env)).toBe("manual");
  });

  test("is unknown outside a job", () => {
    expect(resolveTriggerKind({})).toBe("unknown");
  });

  test("is unknown when the job id is empty", () => {
    const env = { WM_JOB_ID: "", WM_SCHEDULE_PATH: "f/x" };

    expect(resolveTriggerKind(env)).toBe("unknown");
  });
});

describe("describeTriggerEnv", () => {
  test("reports the schedule path when it is set", () => {
    const env = {
      WM_JOB_ID: "job-1",
      WM_SCHEDULE_PATH: "f/factory/self_update",
    };

    expect(describeTriggerEnv(env).schedule_path).toBe("f/factory/self_update");
  });

  test("reports no schedule path when it is unset", () => {
    expect(describeTriggerEnv({ WM_JOB_ID: "job-1" }).schedule_path).toBeNull();
  });

  test("reports no schedule path when it is empty", () => {
    const env = { WM_SCHEDULE_PATH: "" };

    expect(describeTriggerEnv(env).schedule_path).toBeNull();
  });

  test("reports the job kind variable as present when it is set", () => {
    const env = { WM_JOB_KIND: "script" };

    expect(describeTriggerEnv(env).has_job_kind).toBe(true);
  });

  test("reports the job kind variable as absent when it is unset", () => {
    expect(describeTriggerEnv({}).has_job_kind).toBe(false);
  });

  test("reports a parent job as present when it is set", () => {
    const env = { WM_PARENT_JOB: "job-0" };

    expect(describeTriggerEnv(env).has_parent_job).toBe(true);
  });

  test("reports a parent job as absent when it is empty", () => {
    const env = { WM_PARENT_JOB: "" };

    expect(describeTriggerEnv(env).has_parent_job).toBe(false);
  });

  test("reports a root flow job as present when it is set", () => {
    const env = { WM_ROOT_FLOW_JOB_ID: "job-0" };

    expect(describeTriggerEnv(env).has_root_flow_job).toBe(true);
  });

  test("reports a root flow job as absent when it is unset", () => {
    expect(describeTriggerEnv({}).has_root_flow_job).toBe(false);
  });

  test("does not report the value of the job id", () => {
    const env = { WM_JOB_ID: "job-secret-1" };

    expect(JSON.stringify(describeTriggerEnv(env))).not.toContain(
      "job-secret-1",
    );
  });
});

/** コメントを除いた`self_update.ts`のソース。 */
async function selfUpdateSource(): Promise<string> {
  const text = await Bun.file("f/factory/self_update.ts").text();
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

describe("self_update trigger wiring", () => {
  test("logs the trigger kind at the start of every run", async () => {
    const source = await selfUpdateSource();
    const start = source.indexOf("async function updateSelf(");

    expect(source.indexOf('log.info("self_update started"', start)).toBe(
      source.indexOf("log.info(", start),
    );
  });

  test("logs the trigger kind from the job environment", async () => {
    const source = await selfUpdateSource();

    expect(source).toContain("trigger: resolveTriggerKind(process.env),");
  });

  test("logs the raw trigger variables from the job environment", async () => {
    const source = await selfUpdateSource();

    expect(source).toContain("...describeTriggerEnv(process.env),");
  });

  test("does not skip a deployment for a repeated range", async () => {
    const source = await selfUpdateSource();

    expect(source).not.toContain("same_range");
  });
});
