// 作業項目の種別ごとの経路の表(Consoleの`ITEM_KIND_FLOWS`)が、backendの種別の一覧と食い違わないことを固定する。
// 種別を足したのに表を直し忘れると、その種別の作業項目に経路の図が出ない。

import { describe, expect, test } from "bun:test";
import { ITEM_KIND_FLOWS } from "../../console/src/lib/itemFlowGraph.ts";
import { WORK_ITEM_KINDS } from "../../f/factory/lib/types.ts";

describe("the path of each work item kind", () => {
  test("the table has every kind of the backend", () => {
    expect([...ITEM_KIND_FLOWS.keys()].sort()).toEqual(
      [...WORK_ITEM_KINDS].sort(),
    );
  });

  test("every kind passes through at least one flow", () => {
    expect(
      [...ITEM_KIND_FLOWS.values()].filter((flows) => flows.length === 0),
    ).toEqual([]);
  });
});
