// 作業項目の進め方(profile)ごとの、承認の要否の表。
// 実装の関門(`lib/approval_gate.ts`)と、自動再開、再実行が、同じ表を引く。
// 保護パスに置く。表を書き換えると、要件定義や設計の承認を省く進め方が、人の確認なしに通るため。
// importを持たない。表が別のファイルの挙動に左右されないようにする。
//
// 承認を省く判定は、受け付ける進め方の一覧(`ACCEPTED_PROFILES`)に載せた値だけが受ける。
// 一覧に無い値は、DBが許す値(`WORK_ITEM_PROFILES`)も未知の値も、すべて両方の承認を要る側に倒す。
// 「標準の値だけが要る」という書き方にしない。値が増えたとき、既定で承認が外れるのを避けるためである。

/** 受け付ける進め方。入口(手動投入、登録)と関門が、同じこの一覧を見る。 */
export const ACCEPTED_PROFILES: readonly string[] = ["standard"];

/** 進め方が求める承認。設計の承認は、呼び出し側が設計工程の有効の設定と掛ける。 */
export type RequiredApprovals = {
  /** 要件定義の承認が要るか。 */
  readonly requirements: boolean;
  /** 設計の承認が要るか。 */
  readonly design: boolean;
};

/** 承認が両方要る側。受け付けない値と未知の値の行き先。 */
const BOTH_REQUIRED: RequiredApprovals = {
  requirements: true,
  design: true,
};

/** 受け付ける進め方ごとの承認の要否。キーは`ACCEPTED_PROFILES`と同じ値にする。 */
const TABLE: Readonly<Record<string, RequiredApprovals>> = {
  standard: { requirements: true, design: true },
};

/**
 * `profile`が求める承認を返す。
 * `ACCEPTED_PROFILES`に無い値は、未知の値も含めて、要件定義と設計の承認の両方を要る側に倒す。
 */
export function requiredApprovals(profile: string): RequiredApprovals {
  const row =
    ACCEPTED_PROFILES.includes(profile) && Object.hasOwn(TABLE, profile)
      ? TABLE[profile]
      : undefined;
  // 呼び出し側が結果を書き換えても、表に届かないよう、写しを返す。
  return { ...(row ?? BOTH_REQUIRED) };
}
