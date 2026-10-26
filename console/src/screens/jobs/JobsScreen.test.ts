import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// 取得の条件は、`jobsFetchPlan`と`jobsHoldsQueryOptions`が決める(それぞれ単体のテストがある)。
// ここでは、画面がその2つを使い、自分では取り直しの間隔を持たないことだけを確かめる。
// 描画は`JobsScreen.render.test.tsx`が確かめる。
const SOURCE = readFileSync(
  new URL("./JobsScreen.tsx", import.meta.url),
  "utf8",
);
const BODY = SOURCE.slice(SOURCE.indexOf("export function JobsScreen"));

describe("the wiring of the job list screen", () => {
  test("asks the plan which tabs to fetch", () => {
    expect(BODY).toContain("jobsFetchPlan(visited)");
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
