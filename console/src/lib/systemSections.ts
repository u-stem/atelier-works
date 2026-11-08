// システムの画面の中で、通知やリンクから直接指せる区画。
// 区画は`?section=`で指し、区画が属するタブは表で引く。

import type { SystemTabId } from "./systemTabs.ts";

/** 直接指せる区画のid。反映の承認待ち、全停止、保留の3つである。 */
export const SYSTEM_SECTION_IDS = [
  "deploy-approvals",
  "stop-all",
  "holds",
] as const;

export type SystemSectionId = (typeof SYSTEM_SECTION_IDS)[number];

/** URLのクエリのうち、移動先の区画を持つ名前。組む側と読む側で同じ値を使う。 */
export const SECTION_PARAM = "section";

/** 区画が属するタブ。 */
export const SECTION_TAB: Readonly<Record<SystemSectionId, SystemTabId>> = {
  "deploy-approvals": "status",
  "stop-all": "status",
  holds: "status",
};

export function parseSystemSection(
  _value: string | null,
): SystemSectionId | null {
  return null;
}

export function withSystemSection(
  current: URLSearchParams,
  _section: SystemSectionId | null,
): URLSearchParams {
  return new URLSearchParams(current);
}

export function systemSectionPath(_section: SystemSectionId): string {
  return "";
}

export function afterArrival(
  current: URLSearchParams,
  _section: SystemSectionId,
): URLSearchParams {
  return new URLSearchParams(current);
}

export function sectionDomId(_section: SystemSectionId): string {
  return "";
}
