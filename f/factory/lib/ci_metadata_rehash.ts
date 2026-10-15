// `metadata`ジョブだけが落ちたCI回を、Claudeを起動せずに直す決定的な経路。
// PRのheadの木から`wmill-lock.yaml`のhashを再計算し(`planMetadataRehash`)、worktreeのファイルを書き換える。
// 依存や`schema`が変わるPRなど、事前検査が通らないものは、人の手に回す理由を返す。
// 書き換えたファイルは、検証と完了のステップが、同じ再計算でもう一度照合する(`verifyRehashChanges`)。
// I/Oは引数で受け取り、テストでは差し替える。

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  CI_ROUND_DETAILS,
  type CiFailureRead,
  ciRoundReason,
} from "./ci_fix_round.ts";
import type { PlanResult, RehashFailureReason } from "./metadata_precheck.ts";

/** 再計算のcommitの件名。Factoryが固定の文で作る。件名の長さは60字以内である。 */
export const METADATA_REHASH_COMMIT_SUBJECT =
  "chore: wmill-lock.yamlのhashを再計算する";

/** 再計算のcommitの本文。1文を1行に書く。 */
export const METADATA_REHASH_COMMIT_BODY = [
  "CIのmetadataジョブが、scriptの変更に対してlockのhashが古いと報告したため、再計算した。",
  "依存と入力のschemaは変わらないことを、事前検査で確かめている。",
].join("\n");

/** 再計算の結果として、修正のステップが返す要約。 */
export const METADATA_REHASH_SUMMARY =
  "wmill-lock.yamlのhashを、PRのheadの内容から再計算した。";

/**
 * 再計算で直せないときに止める理由。接頭辞は`ci round: `で、続けて固定の文と、事前検査の失敗の種別を付ける。
 * 種別は固定の語彙で、PRの作者が決められるパスや補足は入れない。
 */
export function metadataManualReason(reason: RehashFailureReason): string {
  return ciRoundReason(`${CI_ROUND_DETAILS.metadataManual}${reason})`);
}

/** `rehashMetadataLock`が使うI/O。 */
export type RehashLockDeps = {
  /** 事前検査と再計算。通ったときは、新しい`wmill-lock.yaml`の本文を返す。 */
  readonly plan: () => Promise<PlanResult>;
  /** worktreeの`wmill-lock.yaml`を書き換える。 */
  readonly writeLock: (text: string) => Promise<void>;
};

export type MetadataRehashOutcome =
  | { readonly kind: "rewritten" }
  | { readonly kind: "manual"; readonly reason: RehashFailureReason };

/** 再計算できるときだけ、ファイルを書き換える。できないときは、種別だけを返し、何も書かない。 */
export async function rehashMetadataLock(
  deps: RehashLockDeps,
): Promise<MetadataRehashOutcome> {
  const plan = await deps.plan();
  if (!plan.ok) return { kind: "manual", reason: plan.reason };
  await deps.writeLock(plan.newLock);
  return { kind: "rewritten" };
}

export type MetadataRoundDeps = {
  /** PRの状態を確かめ、そのheadの失敗を分類する(`readCiFailure`)。 */
  readonly readFailure: () => Promise<CiFailureRead>;
  /** 再計算を行う。 */
  readonly rehash: () => Promise<MetadataRehashOutcome>;
};

export type MetadataRoundResult =
  | { readonly kind: "rewritten" }
  | { readonly kind: "manual"; readonly reason: string };

/**
 * `metadata`ジョブが失敗しているときだけ、再計算を行う。失敗していなければ`null`を返し、呼び出し側が通常の流れを続ける。
 * `check`などの直せる失敗と同時のときも、先に再計算する。
 * hashの食い違いは、`check`をClaudeが直しても残るためで、再計算のcommitをpushした後のCIの再実行で、残りの失敗が分かる。
 * PRを読めないときなど、直せる失敗として分類できなければ`null`を返す。理由は通常の流れが同じ検査で出す。
 */
export async function runMetadataRound(
  deps: MetadataRoundDeps,
): Promise<MetadataRoundResult | null> {
  const failure = await deps.readFailure();
  if (failure.kind !== "fixable" || !failure.metadataFailed) return null;
  const outcome = await deps.rehash();
  if (outcome.kind === "rewritten") return outcome;
  return { kind: "manual", reason: metadataManualReason(outcome.reason) };
}

/**
 * worktreeの根の`wmill-lock.yaml`を、通常のファイルとして書き換える。
 * `O_NOFOLLOW`で開き、symlinkはたどらない。`O_CREAT`は付けないので、無いファイルは作らない。
 * 開いたファイルが通常のファイルでなければ、書かずに例外を投げる。
 * 書き先は、根の直下のこのファイルだけである。パスは呼び出し側が決めず、PRの作者が決めた名前を使わない。
 */
export async function writeRootWmillLock(
  worktreeDir: string,
  text: string,
): Promise<void> {
  const handle = await open(
    `${worktreeDir}/wmill-lock.yaml`,
    constants.O_WRONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error("wmill-lock.yaml is not a regular file");
    }
    await handle.truncate(0);
    await handle.write(text, 0, "utf8");
  } finally {
    await handle.close();
  }
}
