// flowごとの図のデータの型と、その検査。
// データは`scripts/docs-gen.ts`が`src/generated/flows.json`に書く。

/** flowのステップ。定義(`flow.yaml`の`modules[]`)の順に並ぶ。 */
export type FlowStep = {
  /** 実行時のステップidと一致する。 */
  readonly id: string;
  /** 接頭辞(`[SF-…]`)を除いた1行の説明。 */
  readonly summary: string;
  /** ステップが実行するscriptのpath。 */
  readonly scriptPath: string;
  /** `skip_if`を持ち、条件で飛ぶことがある。 */
  readonly conditional: boolean;
};

/** 出口がflowを起動する経路。承認を介するときは、承認と却下を分ける。 */
export type ExitVia = "launch" | "approve" | "reject";

/** flowの入口。 */
export type FlowEntry =
  | { readonly kind: "schedule"; readonly name: string }
  | { readonly kind: "human"; readonly label: string }
  | { readonly kind: "script"; readonly name: string }
  | {
      readonly kind: "flow";
      readonly flow: string;
      readonly via: ExitVia;
    };

/** あるステップから、次に動くflowへの出口。 */
export type FlowExit = {
  readonly flow: string;
  /** 出口がつくステップのid。 */
  readonly step: string;
  readonly via: ExitVia;
};

export type FlowDefinition = {
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly steps: readonly FlowStep[];
  readonly entries: readonly FlowEntry[];
  readonly exits: readonly FlowExit[];
};

/** スケジュールの1行の説明と、起動するflow。 */
export type FlowSchedule = {
  readonly name: string;
  readonly summary: string;
  readonly flows: readonly string[];
};

export type FlowsData = {
  readonly flows: readonly FlowDefinition[];
  readonly schedules: readonly FlowSchedule[];
};

/** 値をflowごとの図のデータとして読む。形が違えばnullを返す。 */
export function parseFlowsData(_value: unknown): FlowsData | null {
  return null;
}
