// 承認フローのscriptが投稿するConsoleのリンクが、経路の表(screens.ts)の経路に解決できることを確かめる。
// リンクを作る側(f/factory/lib/approval_support.ts)と経路の表は別々に書かれているので、片方だけを変えたときにここで落とす。

import { describe, expect, test } from "bun:test";
import type { ComponentType } from "react";
import {
  buildApprovalConsoleUrl,
  buildAuditConsoleUrl,
  buildConsoleUrl,
} from "../../../f/factory/lib/approval_support.ts";
import { buildScreenRoutes, flattenRoutePaths } from "./routeTable.ts";
import { SCREENS } from "./screens.ts";

const PUBLIC_URL = "http://127.0.0.1:8080";
const CONSOLE_PATH_PREFIX = "/console/";
const Boundary: ComponentType = () => null;
const routePaths = flattenRoutePaths(buildScreenRoutes(SCREENS, Boundary));

/** 経路の表が受けるパス(`:id`などの引数つき)に、相対パスが合うか。 */
function matchesRoutePattern(pattern: string, relativePath: string): boolean {
  const patternParts = pattern.split("/");
  const pathParts = relativePath.split("/");
  return (
    patternParts.length === pathParts.length &&
    patternParts.every(
      (part, index) => part.startsWith(":") || part === pathParts[index],
    )
  );
}

/** リンクの、`/console/`の下の相対パスを返す。`/console/`の下でなければ`null`にする。 */
function relativeRouteOf(url: string): string | null {
  const { pathname } = new URL(url);
  return pathname.startsWith(CONSOLE_PATH_PREFIX)
    ? pathname.slice(CONSOLE_PATH_PREFIX.length)
    : null;
}

function resolves(url: string): boolean {
  const relative = relativeRouteOf(url);
  return (
    relative !== null &&
    routePaths.some((pattern) => matchesRoutePattern(pattern, relative))
  );
}

describe("console links built by the approval flow", () => {
  test("the entrance link resolves to a route", () => {
    expect(resolves(buildConsoleUrl(PUBLIC_URL))).toBe(true);
  });

  test("the requirements link resolves to a route", () => {
    expect(
      resolves(buildConsoleUrl(PUBLIC_URL, { work_item_id: 7, attempt: 2 })),
    ).toBe(true);
  });

  test("the audit report link resolves to a route", () => {
    expect(resolves(buildAuditConsoleUrl(PUBLIC_URL, 12))).toBe(true);
  });

  test("the approval link resolves to a route", () => {
    expect(resolves(buildApprovalConsoleUrl(PUBLIC_URL, 9))).toBe(true);
  });

  test("a link that is not in the route table does not resolve", () => {
    expect(resolves(`${PUBLIC_URL}/console/items/7/unknown`)).toBe(false);
  });

  test("a link outside the console does not resolve", () => {
    expect(resolves(`${PUBLIC_URL}/apps/get/f/factory/factory_console`)).toBe(
      false,
    );
  });
});
