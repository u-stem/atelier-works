// APIの受け口が、`/console/`と`/api/`の外への要求を、中断して記録することを確かめる。
// この性質が、検査の要求が実際のWindmillにも外部にも届かないことの根拠になる。
// 共通の部品(`support.ts`)は使わない。想定外の要求を記録して見せるので、検査の最後の失敗判定に掛からない形にする。

import { expect, type Page, test } from "@playwright/test";
import { installMockApi } from "./mockApi.ts";
import { ORIGIN } from "./origin.ts";

/** 同じオリジンの、受け口が応える経路でページを開き、そこからfetchを試す。 */
async function openAndFetch(
  page: Page,
  target: string,
): Promise<{ readonly outcome: string; readonly problems: readonly string[] }> {
  const mock = await installMockApi(page, ORIGIN, "normal");
  await page.goto("/console/status.json");
  const outcome = await page.evaluate(
    (url) =>
      fetch(url).then(
        () => "reached",
        () => "blocked",
      ),
    target,
  );
  return { outcome, problems: mock.problems };
}

test.describe("the mock API", () => {
  test("blocks a same-origin request outside /console/", async ({ page }) => {
    const { outcome } = await openAndFetch(page, "/outside/path");

    expect(outcome).toBe("blocked");
  });

  test("records a same-origin request outside /console/", async ({ page }) => {
    const { problems } = await openAndFetch(page, "/outside/path");

    expect(problems).toEqual(["request outside /console/: GET /outside/path"]);
  });

  test("records the root path as outside /console/", async ({ page }) => {
    const { problems } = await openAndFetch(page, "/");

    expect(problems).toEqual(["request outside /console/: GET /"]);
  });

  test("blocks a request to another origin", async ({ page }) => {
    const { outcome } = await openAndFetch(page, "http://example.invalid/x");

    expect(outcome).toBe("blocked");
  });

  test("records a request to another origin", async ({ page }) => {
    const { problems } = await openAndFetch(page, "http://example.invalid/x");

    expect(problems).toEqual(["request to another origin: GET /x"]);
  });

  test("lets status.json through without a record", async ({ page }) => {
    const { problems } = await openAndFetch(page, "/console/status.json");

    expect(problems).toEqual([]);
  });

  test("records an API request for a script outside the table", async ({
    page,
  }) => {
    const { problems } = await openAndFetch(
      page,
      "/api/w/factory/jobs/run_wait_result/p/f/factory/unknown_script",
    );

    expect(problems).toEqual([
      "unexpected API request: GET /api/w/factory/jobs/run_wait_result/p/f/factory/unknown_script null",
    ]);
  });
});
