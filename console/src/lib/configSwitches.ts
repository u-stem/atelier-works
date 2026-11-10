// 設定タブの先頭に置く「機能のスイッチ」の表の行を決める。
// Consoleから止められる真偽の項目(`STOPPABLE_SWITCHES`)を、設定に項目が無くても1行ずつ並べる。
// 止める候補はグループの表と同じ`changeOfferOf`が決めるので、どちらのボタンも同じ確認のダイアログを開く。

import type { ConfigItemView, DesignStageView } from "../api/jobsQueries.ts";
import {
  type ChangeOffer,
  changeOfferOf,
  STOPPABLE_SWITCHES,
} from "./configChange.ts";
import { describeDesignEnabledNote } from "./jobsView.ts";

/**
 * スイッチの状態。
 * `hidden`は参照と伏せた値、`unset`は設定にその項目が無いこと、`not_boolean`は真偽でない値である。
 */
export type SwitchState = "on" | "off" | "hidden" | "unset" | "not_boolean";

export type SwitchRow = {
  readonly key: string;
  readonly state: SwitchState;
  /** 設計工程の判定を示す語(無視中、判定できません)。無いときは`null`。 */
  readonly stageNote: string | null;
  /** 止める候補。有効で、値を読めるときだけある。 */
  readonly offer: ChangeOffer | null;
};

function stateOf(item: ConfigItemView | undefined): SwitchState {
  if (item === undefined) return "unset";
  if (item.kind !== "value" || item.masked) return "hidden";
  if (item.value === true) return "on";
  if (item.value === false) return "off";
  return "not_boolean";
}

/**
 * 止められる真偽の項目ごとの行。並びは`STOPPABLE_SWITCHES`に従う。
 * 設計工程が無視中か判定できないときは、`design_enabled`の行に語を添える。
 * 状態は書かれた値のままで、実際に効いているかは語で補う。
 */
export function switchRowsOf(
  items: readonly ConfigItemView[],
  designStage: DesignStageView | undefined,
): SwitchRow[] {
  const byKey = new Map(items.map((item) => [item.key, item]));
  return STOPPABLE_SWITCHES.map((key) => {
    const item = byKey.get(key);
    return {
      key,
      state: stateOf(item),
      stageNote:
        item === undefined
          ? null
          : (describeDesignEnabledNote(item, designStage)?.label ?? null),
      offer: item === undefined ? null : changeOfferOf(item),
    };
  });
}

/**
 * スイッチの表を出すか。絞り込みの語が空のときと、設定に項目があるときだけ出す。
 * 語を打っている間は、グループの表の該当を読むので、全体を見渡す表は隠す。
 */
export function switchTableShown(query: string, itemCount: number): boolean {
  return itemCount > 0 && query.trim() === "";
}
