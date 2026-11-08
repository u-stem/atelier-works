// 通知の種類のうち、対応をシステムの画面の区画で行うものと、その区画。
// 文面を持たない小さな表にして、件数を数える側が、通知の案内の文面を取り込まずに読めるようにする。

import type { SystemSectionId } from "./systemSections.ts";

export function systemTargetSection(_kind: string): SystemSectionId | null {
  return null;
}
