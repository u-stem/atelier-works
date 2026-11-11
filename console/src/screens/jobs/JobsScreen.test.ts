import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// 取得の条件は、`jobsHoldsQueryOptions`が決める(単体のテストがある)。
// ここでは、画面がそれを使い、自分では取り直しの間隔を持たないことだけを確かめる。
// 描画は`JobsScreen.render.test.tsx`が確かめる。
const SOURCE = readFileSync(
  new URL("./JobsScreen.tsx", import.meta.url),
  "utf8",
);
const BODY = SOURCE.slice(SOURCE.indexOf("export function JobsScreen"));

describe("the wiring of the job list screen", () => {
  test("fetches a tab only after it was opened", () => {
    expect(
      [
        'useActiveJobs(visited.has("active"), {',
        'useSchedules(visited.has("schedules"))',
      ].every((call) => BODY.includes(call)),
    ).toBe(true);
  });

  test("reads the holds with the options that never poll", () => {
    expect(BODY).toContain("jobsHoldsQueryOptions()");
  });

  test("does not set a refetch interval of its own", () => {
    expect(SOURCE).not.toContain("refetchInterval");
  });

  test("does not set a refetch on focus of its own", () => {
    expect(SOURCE).not.toContain("refetchOnWindowFocus");
  });
});

describe("the wiring of the current steps", () => {
  test("reads the steps of the running flows of the active list", () => {
    expect(BODY).toContain("useActiveJobSteps(active.data, tab, idle)");
  });

  // 一覧の取得中に`enabled`を切り替えると、今のステップの30秒のタイマーが張り直される。
  test("does not switch the steps off while the active list is being fetched", () => {
    expect(BODY).not.toContain("listFetching");
  });

  test("shares one idle state between the list and the steps", () => {
    expect(BODY.split("useIdle()").length - 1).toBe(1);
  });

  test("refreshes the active list before the steps", () => {
    expect(BODY).toContain("refreshActiveThenSteps(");
  });

  test("passes the steps to the active list", () => {
    expect(BODY).toContain("<ActiveJobs query={active} steps={steps} />");
  });
});
