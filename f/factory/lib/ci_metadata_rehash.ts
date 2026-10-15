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
import { type GhClient, getBranchSha, getPr } from "./github.ts";
import { createGitPrecheckPorts, fetchBranch } from "./metadata_git_ports.ts";
import {
  type PlanResult,
  planMetadataRehash,
  type RehashFailureReason,
} from "./metadata_precheck.ts";
import { buildGitArgv, type CommandRunner, localGitEnv } from "./workspace.ts";

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

/** `rehashPlanner`が使うI/O。 */
export type RehashIo = {
  /** PRが向いているbaseブランチの名前。 */
  readonly readBaseRef: () => Promise<string>;
  /** ブランチの今の先端のsha。GitHubのAPIで読む。 */
  readonly readBranchSha: (branch: string) => Promise<string>;
  /** ブランチの今の先端を、ローカルのcloneに取り込む。 */
  readonly fetchBranch: (branch: string) => Promise<void>;
  /** baseの先端`baseSha`を基準に、事前検査と再計算を行う。 */
  readonly plan: (baseSha: string) => Promise<PlanResult>;
};

/** baseの先端を読む手段と、その先端での再計算を、1つにまとめたもの。 */
export type RehashPlanner = {
  readonly readBase: () => Promise<string>;
  readonly planWith: (baseSha: string) => Promise<PlanResult>;
};

/**
 * baseブランチの名前を1回だけ読み、先端の読み取りと、取り込んでからの再計算を組み立てる。
 * 再計算の前に取り込むのは、事前検査がbaseの先端の木をローカルのオブジェクトから読むためである。
 */
export function rehashPlanner(io: RehashIo): RehashPlanner {
  let baseRef: Promise<string> | null = null;
  const ref = (): Promise<string> => {
    baseRef ??= io.readBaseRef();
    return baseRef;
  };
  return {
    readBase: async () => io.readBranchSha(await ref()),
    planWith: async (baseSha) => {
      await io.fetchBranch(await ref());
      return io.plan(baseSha);
    },
  };
}

/** `rehashPlanner`を、GitHubのAPIと、worktreeのgitのオブジェクトで組む。 */
export function githubRehashPlanner(input: {
  readonly client: GhClient;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly worktreeDir: string;
  readonly ghToken: string;
}): RehashPlanner {
  const { client, owner, repo, headSha, worktreeDir, ghToken } = input;
  return rehashPlanner({
    readBaseRef: async () =>
      (await getPr(client, owner, repo, input.prNumber)).baseRef,
    readBranchSha: (branch) => getBranchSha(client, owner, repo, branch),
    fetchBranch: (branch) => fetchBranch({ cwd: worktreeDir, branch, ghToken }),
    plan: (baseSha) =>
      planMetadataRehash(
        { baseSha, headSha },
        createGitPrecheckPorts({ cwd: worktreeDir }),
      ),
  });
}

/** `confirmRehash`が使うI/O。 */
export type RehashConfirmDeps = RehashPlanner & {
  /** 確かめる`wmill-lock.yaml`の本文(worktreeか、ステージした内容)。読めなければ`null`。 */
  readonly readLock: () => Promise<string | null>;
};

export type RehashConfirmation =
  | {
      readonly ok: true;
      /** 確かめた時点の、baseの先端。 */
      readonly baseSha: string;
      /** 再計算と一致した、`wmill-lock.yaml`の本文。 */
      readonly lockText: string;
    }
  | { readonly ok: false };

/** 再計算と一致すると確認できた結果。 */
export type RehashConfirmed = Extract<RehashConfirmation, { ok: true }>;

/** baseの先端が動いたときに、再計算を取り直す回数の上限。 */
export const REHASH_CONFIRM_ATTEMPTS = 3;

/**
 * `wmill-lock.yaml`の本文が、独立した再計算の結果と一致することを確かめる。
 * baseの先端を読み、その先端で再計算し、本文と比べる。比べた後にbaseの先端がもう一度読み直して同じなら、確認済みとする。
 * 先端が動いていたら、新しい先端で最初からやり直す。上限(`REHASH_CONFIRM_ATTEMPTS`)を超えても動き続けるときは、確認できないとする。
 * 再計算できない、本文が違う、本文を読めないときも、確認できない。
 * 通った本文は、修正のステップが書いた本文とバイト列まで同じであり、依存や`schema`を書き換えていない。
 */
export async function confirmRehash(
  deps: RehashConfirmDeps,
): Promise<RehashConfirmation> {
  const lock = await deps.readLock();
  if (lock === null) return { ok: false };
  for (let attempt = 0; attempt < REHASH_CONFIRM_ATTEMPTS; attempt += 1) {
    const baseSha = await deps.readBase();
    const plan = await deps.planWith(baseSha);
    if (!plan.ok || plan.newLock !== lock) return { ok: false };
    if ((await deps.readBase()) === baseSha) {
      return { ok: true, baseSha, lockText: lock };
    }
  }
  return { ok: false };
}

/** pushの直前に、baseの先端が動き、確認し直した再計算が、確認済みの本文と合わなくなったときの理由。 */
export const CI_ROUND_REHASH_STALE_REASON = ciRoundReason(
  "the base branch moved and the recomputed lock no longer matches",
);

/**
 * pushの直前に、baseの先端が確認したときのままかを確かめ、止める理由を返す。問題が無ければ`null`を返す。
 * 動いていたら、pushせず、新しい先端でもう一度確認する(`confirmRehash`)。
 * 確認し直しても、確認済みの本文と同じ本文が再計算の結果なら、そのままpushしてよい。
 * 違う、または確認できなければ、`CI_ROUND_REHASH_STALE_REASON`を返す。`--force`は使わない。
 * baseの先端はpushの後にも動きうるが、それは次のCIの実行が検査する。
 */
export async function rehashPushStopReason(
  confirmed: RehashConfirmed,
  planner: RehashPlanner,
): Promise<string | null> {
  if ((await planner.readBase()) === confirmed.baseSha) return null;
  const again = await confirmRehash({
    ...planner,
    readLock: async () => confirmed.lockText,
  });
  return again.ok ? null : CI_ROUND_REHASH_STALE_REASON;
}

/**
 * worktreeの根の`wmill-lock.yaml`の本文を読む。
 * `O_NOFOLLOW`で開き、symlinkはたどらない。通常のファイルでないとき、読めないときは`null`を返す。
 */
export async function readRootWmillLock(
  worktreeDir: string,
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      `${worktreeDir}/wmill-lock.yaml`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    return await handle.readFile({ encoding: "utf8" });
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * ステージした`wmill-lock.yaml`の本文を、索引から読む(`git cat-file blob :wmill-lock.yaml`)。
 * commitされる内容そのものである。gitが失敗したときと、出力を打ち切ったときは`null`を返す。
 */
export async function readStagedRootLock(
  run: CommandRunner,
  worktreeDir: string,
): Promise<string | null> {
  const result = await run(
    buildGitArgv(["cat-file", "blob", ":wmill-lock.yaml"]),
    { cwd: worktreeDir, env: localGitEnv() },
  );
  if (result.exitCode !== 0 || result.outputAbandoned === true) return null;
  return result.stdout;
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
