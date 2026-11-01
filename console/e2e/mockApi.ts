// ブラウザの検査で、ConsoleのAPIとstatus.jsonを固定の値で受ける。
// 想定外の要求(表に無いscript、別のオリジンへの通信)は、中断して記録する。
// 記録が残った検査は、`assertNoProblems`で失敗にする。書き込みのscriptも表に無いので、実行されない。

import type { Page, Request, Route } from "@playwright/test";
import { STAMP } from "./fixtures.ts";
import { type Mode, replyFor, scriptOfPath } from "./responses.ts";

export type MockApi = {
  /** 想定外の要求の記録。空であるべきもの。 */
  readonly problems: readonly string[];
};

const STATUS_JSON = {
  state: "current",
  sha: "0123456789abcdef0123456789abcdef01234567",
  checked_at: STAMP,
  error: null,
};

function describeRequest(request: Request): string {
  const url = new URL(request.url());
  return `${request.method()} ${url.pathname}`;
}

function argsOf(request: Request): unknown {
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

async function handleApi(
  route: Route,
  mode: Mode,
  problems: string[],
): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const script = scriptOfPath(url.pathname);
  const reply =
    request.method() === "POST" && script !== null
      ? replyFor(script, argsOf(request), mode)
      : null;
  if (reply === null) {
    problems.push(
      `unexpected API request: ${describeRequest(request)} ${JSON.stringify(argsOf(request))}`,
    );
    await route.abort();
    return;
  }
  await route.fulfill({
    status: reply.status,
    contentType: "application/json",
    body: JSON.stringify(reply.body),
  });
}

/**
 * ページにAPIの受け口を付ける。ページを開く前に呼ぶ。
 * `baseOrigin`の外への通信は、すべて中断する。
 */
export async function installMockApi(
  page: Page,
  baseOrigin: string,
  mode: Mode,
): Promise<MockApi> {
  const problems: string[] = [];
  await page.route(
    (url) => url.origin !== baseOrigin,
    async (route) => {
      problems.push(
        `request to another origin: ${describeRequest(route.request())}`,
      );
      await route.abort();
    },
  );
  await page.route(
    (url) => url.origin === baseOrigin && url.pathname.startsWith("/api/"),
    (route) => handleApi(route, mode, problems),
  );
  await page.route(
    (url) =>
      url.origin === baseOrigin && url.pathname === "/console/status.json",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(STATUS_JSON),
      }),
  );
  return { problems };
}
