// ブラウザの検査で、ConsoleのAPIとstatus.jsonを固定の値で受ける。
// 想定外の要求(表に無いscript、別のオリジンへの通信、同じオリジンの`/console/`の外への通信)は、
// 中断して記録する。同じオリジンの`/console/`の外は、検査用のサーバーが実際のWindmillへ中継しうるので、
// 止めることで、検査の要求がWindmillにも外部にも届かないことを成り立たせる。
// 記録が残った検査は、`support.ts`の検査の後始末で失敗にする。
// 書き込みのscriptは、検査が結果を選んだものだけに固定の値で応え、選ばないものは想定外の要求として記録する。

import type { Page, Request, Route } from "@playwright/test";
import { STAMP } from "./fixtures.ts";
import {
  type Mode,
  replyFor,
  scriptOfPath,
  type WriteReplies,
} from "./responses.ts";

export type MockCall = { readonly script: string; readonly args: unknown };

export type MockApi = {
  /** 想定外の要求の記録。空であるべきもの。 */
  readonly problems: readonly string[];
  /** 応答した呼び出しの記録。書き込みの後の読み直しを確かめるのに使う。 */
  readonly calls: readonly MockCall[];
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
  writes: WriteReplies,
  record: { readonly problems: string[]; readonly calls: MockCall[] },
): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const script = scriptOfPath(url.pathname);
  const args = argsOf(request);
  const reply =
    request.method() === "POST" && script !== null
      ? replyFor(script, args, mode, writes)
      : null;
  if (script === null || reply === null) {
    record.problems.push(
      `unexpected API request: ${describeRequest(request)} ${JSON.stringify(args)}`,
    );
    await route.abort();
    return;
  }
  record.calls.push({ script, args });
  await route.fulfill({
    status: reply.status,
    contentType: "application/json",
    body: JSON.stringify(reply.body),
  });
}

/**
 * ページにAPIの受け口を付ける。ページを開く前に呼ぶ。
 * `baseOrigin`の外への通信と、`baseOrigin`の`/console/`と`/api/`の外への通信は、すべて中断する。
 * `/console/`の下は検査用のサーバーが配信し、`/api/`は受け口が固定の値で返す。
 * `writes`は、応答させる書き込みのscriptと結果である。既定は空で、書き込みには応答しない。
 */
export async function installMockApi(
  page: Page,
  baseOrigin: string,
  mode: Mode,
  writes: WriteReplies = {},
): Promise<MockApi> {
  const problems: string[] = [];
  const calls: MockCall[] = [];
  await page.route(
    (url) =>
      url.origin === baseOrigin &&
      !url.pathname.startsWith("/console/") &&
      !url.pathname.startsWith("/api/"),
    async (route) => {
      problems.push(
        `request outside /console/: ${describeRequest(route.request())}`,
      );
      await route.abort();
    },
  );
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
    (route) => handleApi(route, mode, writes, { problems, calls }),
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
  return { problems, calls };
}
