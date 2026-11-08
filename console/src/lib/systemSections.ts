// システムの画面の中で、通知やリンクから直接指せる区画。
// 区画は`?section=`で指し、区画が属するタブは表で引く。
// 移動を受けた後は`?section=`を消し、再読み込みや戻る操作で再び移らないようにする。

import { SYSTEM_PATH } from "../app/paths.ts";
import { type SystemTabId, withSystemTab } from "./systemTabs.ts";

/** 直接指せる区画のid。反映の承認待ち、全停止、保留の3つである。 */
export const SYSTEM_SECTION_IDS = [
  "deploy-approvals",
  "stop-all",
  "holds",
] as const;

export type SystemSectionId = (typeof SYSTEM_SECTION_IDS)[number];

/** URLのクエリのうち、移動先の区画を持つ名前。組む側と読む側で同じ値を使う。 */
export const SECTION_PARAM = "section";

/** 区画が属するタブ。区画のタブがURLの`?tab=`と食い違うときは、区画のタブを開く。 */
export const SECTION_TAB: Readonly<Record<SystemSectionId, SystemTabId>> = {
  "deploy-approvals": "status",
  "stop-all": "status",
  holds: "status",
};

function isSystemSectionId(value: string): value is SystemSectionId {
  return SYSTEM_SECTION_IDS.some((id) => id === value);
}

/** URLの`?section=`から移動先の区画を決める。無い値と知らない値は`null`にする。 */
export function parseSystemSection(
  value: string | null,
): SystemSectionId | null {
  return value !== null && isSystemSectionId(value) ? value : null;
}

/** 区画を指す(または`null`で外す)クエリを、新しいオブジェクトで返す。他のクエリは残す。 */
export function withSystemSection(
  current: URLSearchParams,
  section: SystemSectionId | null,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (section === null) {
    next.delete(SECTION_PARAM);
  } else {
    next.set(SECTION_PARAM, section);
  }
  return next;
}

/**
 * 区画を指すシステムの画面のパス。ルーターの基準(`/console`)からの絶対パスで書く。
 * タブは区画から決まるので、区画のタブが既定のタブなら`?tab=`は付かない。
 */
export function systemSectionPath(section: SystemSectionId): string {
  const params = withSystemSection(
    withSystemTab(new URLSearchParams(), SECTION_TAB[section]),
    section,
  );
  return `${SYSTEM_PATH}?${params.toString()}`;
}

/**
 * 区画が移動を受けた後のクエリ。区画を外し、区画のタブを書く。
 * 移動の間は区画のタブを開いているので、区画を外したときにタブが戻らないようにするためである。
 */
export function afterArrival(
  current: URLSearchParams,
  section: SystemSectionId,
): URLSearchParams {
  return withSystemTab(withSystemSection(current, null), SECTION_TAB[section]);
}

/** 区画の移動先の要素に付ける`id`。区画の側が付け、移動の側が探す。 */
export function sectionDomId(section: SystemSectionId): string {
  return `system-section-${section}`;
}
