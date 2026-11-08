// 通知の種類のうち、対応をシステムの画面の区画で行うものと、その区画。
// 文面を持たない小さな表にして、件数を数える側が、通知の案内の文面を取り込まずに読めるようにする。
// 値の取り込みを持たない(型だけを取り込む)。

import type { SystemSectionId } from "./systemSections.ts";

const SYSTEM_TARGET_SECTIONS: ReadonlyMap<string, SystemSectionId> = new Map([
  ["deploy_approval_required", "deploy-approvals"],
  ["dependabot_merge_held", "holds"],
  ["stop_all_active", "stop-all"],
]);

/** 通知の種類の対応を行う区画。システムの画面の区画で行わない種類と、知らない種類は`null`。 */
export function systemTargetSection(kind: string): SystemSectionId | null {
  return SYSTEM_TARGET_SECTIONS.get(kind) ?? null;
}
