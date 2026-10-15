// `metadata`ジョブだけが落ちたCI回を、Claudeを起動せずに直す決定的な経路。
// PRのheadの木から`wmill-lock.yaml`のhashを再計算し(`planMetadataRehash`)、worktreeのファイルを書き換える。
// 依存や`schema`が変わるPRなど、事前検査が通らないものは、人の手に回す理由を返す。
// 書き換えたファイルは、検証と完了のステップが、同じ再計算でもう一度照合する(`confirmRehash`)。
// I/Oは引数で受け取り、テストでは差し替える。

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  buildCiGatherDeps,
  CI_ROUND_DETAILS,
  type CiFailureRead,
  ciRoundReason,
  type RehashCheckVerdict,
  readCiFailure,
} from "./ci_fix_round.ts";
import { type GhClient, getBranchSha, getPr } from "./github.ts";
import {
  type BytesRunner,
  createGitPrecheckPorts,
  fetchCommit,
} from "./metadata_git_ports.ts";
import {
  type PlanResult,
  planMetadataRehash,
  type RehashFailureReason,
} from "./metadata_precheck.ts";
import {
  buildGitArgv,
  type CommandRunner,
  DEFAULT_TIMEOUT_MS,
  localGitEnv,
} from "./workspace.ts";

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
 * 再計算では直せない理由の種別。事前検査の失敗の種別に、次の2つを足す。
 * - `lock_up_to_date`: 再計算しても本文が変わらない。`metadata`ジョブが、hash以外の原因で落ちている。
 * - `lock_not_writable`: 根の`wmill-lock.yaml`が、通常のファイルとして書き換えられない。
 */
export type MetadataManualReason =
  | RehashFailureReason
  | "lock_up_to_date"
  | "lock_not_writable";

/**
 * 再計算で直せないときに止める理由。接頭辞は`ci round: `で、続けて固定の文と、種別を付ける。
 * 種別は固定の語彙で、PRの作者が決められるパスは入れない。
 * 補足(`detail`)は、`scan_unavailable`と`internal_error`のときだけ、`: <補足>`として足す。
 * 前者はworkerのBunの版(`bun <版>`)で、運用者が、workerの更新で直るかを見分けるためである。
 * 後者は標準のエラーの名前で、原因の見当を付けるためである。ほかの種別の補足は捨てる。
 */
export function metadataManualReason(
  reason: MetadataManualReason,
  detail?: string,
): string {
  const suffix =
    (reason === "scan_unavailable" || reason === "internal_error") &&
    detail !== undefined
      ? `: ${detail}`
      : "";
  return ciRoundReason(`${CI_ROUND_DETAILS.metadataManual}${reason}${suffix})`);
}

/**
 * 根の`wmill-lock.yaml`を書き換えられないことを表す。symlink、通常のファイルでないもの、無いファイル、権限が足りないものである。
 * 再試行しても直らない種類なので、呼び出し側は、例外にせず固定の理由で止める。
 */
export class LockNotWritableError extends Error {
  constructor() {
    super("wmill-lock.yaml cannot be written as a regular file");
    this.name = "LockNotWritableError";
  }
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
  /** 再計算が通ったが、本文が変わらない。書き換えない。 */
  | { readonly kind: "up_to_date" }
  | {
      readonly kind: "manual";
      readonly reason: MetadataManualReason;
      readonly detail?: string;
    };

/**
 * 事前検査の失敗のうち、同じ入力でやり直せば通りうる、一時的なもの。
 * gitコマンドや読み取りの失敗(`port_error`)と、祖先の判定の失敗(`ancestry_unknown`)である。
 * 人の手に回さず、例外にして、flowの再試行に任せる。再計算は何度行っても同じ結果になる。
 * 想定外の例外(`internal_error`)は、ポートの例外を`port_error`などに変えた後に残る純粋な計算の例外で、
 * 同じ入力では同じ結果になる。自己検査の失敗(`scan_unavailable`)と、木の一覧が読めないこと(`tree_unreadable`)も、
 * 再試行しても直らない。これらはここに含めない。
 */
const TRANSIENT_REHASH_REASONS: ReadonlySet<RehashFailureReason> = new Set([
  "port_error",
  "ancestry_unknown",
]);

/** 事前検査が一時的な理由で失敗したことを表す。固定の種別だけを持つ。 */
export class RehashTransientError extends Error {
  constructor(reason: RehashFailureReason) {
    super(`metadata rehash precheck failed (${reason})`);
    this.name = "RehashTransientError";
  }
}

/**
 * 再計算できて、本文が変わるときだけ、ファイルを書き換える。
 * 再計算できないときは、種別だけを返し、何も書かない。ただし、一時的な種別(`port_error`、`ancestry_unknown`)は、
 * `RehashTransientError`を投げる。本文が変わらないときは`up_to_date`を返し、何も書かない。
 * 書き換えられないlockは`lock_not_writable`にする。
 * 一時的な失敗(読み取りや取り込みの例外、書き込みのその他の例外)は、そのまま投げる。呼び出し側のflowの再試行に任せる。
 */
export async function rehashMetadataLock(
  deps: RehashLockDeps,
): Promise<MetadataRehashOutcome> {
  const plan = await deps.plan();
  if (!plan.ok) {
    if (TRANSIENT_REHASH_REASONS.has(plan.reason)) {
      throw new RehashTransientError(plan.reason);
    }
    return plan.detail === undefined
      ? { kind: "manual", reason: plan.reason }
      : { kind: "manual", reason: plan.reason, detail: plan.detail };
  }
  if (plan.changedKeys.length === 0) return { kind: "up_to_date" };
  try {
    await deps.writeLock(plan.newLock);
  } catch (error) {
    if (error instanceof LockNotWritableError) {
      return { kind: "manual", reason: "lock_not_writable" };
    }
    throw error;
  }
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
 * `metadata`ジョブだけが失敗している分類か。この回だけが、Claudeを使わない再計算の回になる。
 * `check`などが同時に落ちている回と、`metadata`が落ちていない回は、Claudeの回である。
 */
export function isMetadataOnlyFailure(failure: CiFailureRead): boolean {
  return (
    failure.kind === "fixable" &&
    failure.metadataFailed &&
    failure.jobs.length === 0
  );
}

/**
 * 今の回が再計算の回か(`isMetadataOnlyFailure`)を、PRのheadのCIの実行から読み直して答える関数を作る。
 * 検証と完了のステップが、修正のステップの出力を信用せずに、回の種類を決めるために使う。
 * 呼ぶたびにGitHubを読むので、必要なときだけ呼ぶ。
 */
export function rehashRoundProbe(input: {
  readonly client: GhClient;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly run: CommandRunner;
}): () => Promise<boolean> {
  const target = {
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
  };
  return async () =>
    isMetadataOnlyFailure(
      await readCiFailure(
        buildCiGatherDeps(input.client, target, input.run),
        target,
      ),
    );
}

/**
 * `metadata`ジョブが失敗しているときだけ、再計算を行う。失敗していなければ`null`を返し、呼び出し側が通常の流れを続ける。
 * `check`などの直せる失敗と同時のときは、再計算せず`null`を返す。Claudeが先にそのジョブを直す。
 * Claudeが`f/`を触るとhashが再び古くなるので、再計算は、`metadata`だけが落ちた次の回に行う。
 * PRを読めないときなど、直せる失敗として分類できなければ`null`を返す。理由は通常の流れが同じ検査で出す。
 * 再計算しても本文が変わらないときは、`metadata`ジョブが、hash以外の原因(Windmillの起動やログインなど)で落ちている。
 * 再計算では直せないので、固定の理由(`lock_up_to_date`)で人の手に回す。
 */
export async function runMetadataRound(
  deps: MetadataRoundDeps,
): Promise<MetadataRoundResult | null> {
  const failure = await deps.readFailure();
  if (!isMetadataOnlyFailure(failure)) return null;
  const outcome = await deps.rehash();
  if (outcome.kind === "rewritten") return outcome;
  if (outcome.kind === "up_to_date") {
    return { kind: "manual", reason: metadataManualReason("lock_up_to_date") };
  }
  return {
    kind: "manual",
    reason: metadataManualReason(outcome.reason, outcome.detail),
  };
}

/** 修正のステップが返す、再計算の回の結果。`PrFixApplyResult`と同じ形で、返信は空である。 */
export type MetadataApplyResult = {
  readonly outcome: "done" | "blocked";
  readonly reason: string | null;
  readonly summary: string;
  readonly replies: [];
  readonly commit_subject: string | null;
  readonly commit_body: string | null;
};

/**
 * 再計算の回の結果を、修正のステップの結果にする。
 * 書き換えたときは、固定の件名と本文を持つ`done`にする。直せないときは、固定の理由を持つ`blocked`にする。
 * 返信は、どちらも空である。
 */
export function metadataApplyResult(
  round: MetadataRoundResult,
): MetadataApplyResult {
  if (round.kind === "manual") {
    return {
      outcome: "blocked",
      reason: round.reason,
      summary: "",
      replies: [],
      commit_subject: null,
      commit_body: null,
    };
  }
  return {
    outcome: "done",
    reason: null,
    summary: METADATA_REHASH_SUMMARY,
    replies: [],
    commit_subject: METADATA_REHASH_COMMIT_SUBJECT,
    commit_body: METADATA_REHASH_COMMIT_BODY,
  };
}

/** `rehashPlanner`が使うI/O。 */
export type RehashIo = {
  /** PRが向いているbaseブランチの名前。 */
  readonly readBaseRef: () => Promise<string>;
  /** ブランチの今の先端のsha。GitHubのAPIで読む。 */
  readonly readBranchSha: (branch: string) => Promise<string>;
  /** commit`sha`を、ローカルのcloneに取り込む。追跡refは動かさない。 */
  readonly fetchCommit: (sha: string) => Promise<void>;
  /** baseの先端`baseSha`を基準に、事前検査と再計算を行う。 */
  readonly plan: (baseSha: string) => Promise<PlanResult>;
};

/** baseの先端を読む手段と、その先端での再計算を、1つにまとめたもの。 */
export type RehashPlanner = {
  readonly readBase: () => Promise<string>;
  readonly planWith: (baseSha: string) => Promise<PlanResult>;
};

/**
 * baseブランチの名前を1回だけ読み、先端の読み取りと、先端のcommitを取り込んでからの再計算を組み立てる。
 * 再計算の前に取り込むのは、事前検査がbaseの先端の木をローカルのオブジェクトから読むためである。
 * 取り込むのは、読んだ先端のshaそのものである。ブランチ名で取り込むと、追跡refを更新し、
 * リポジトリのロックの外から、`commitAndPush`と同じrefを動かしてしまう。
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
      await io.fetchCommit(baseSha);
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
    fetchCommit: (sha) => fetchCommit({ cwd: worktreeDir, sha, ghToken }),
    plan: (baseSha) =>
      planMetadataRehash(
        { baseSha, headSha },
        createGitPrecheckPorts({ cwd: worktreeDir }),
      ),
  });
}

/** 2つのバイト列が、長さも内容も同じか。 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}

/** `confirmRehash`が使うI/O。 */
export type RehashConfirmDeps = RehashPlanner & {
  /**
   * 確かめる`wmill-lock.yaml`のバイト列(worktreeか、ステージした内容)。読めなければ`null`。
   * 文字列に復号しない。復号すると、先頭のBOMが落ち、不正なUTF-8が置き換わって、違う内容が同じに見えるためである。
   */
  readonly readLock: () => Promise<Uint8Array | null>;
};

/**
 * 照合の結果。確認できなかったときは、2つに分ける。
 * - `mismatch`: 再計算はできたが、`wmill-lock.yaml`が再計算と違う、読めない、またはbaseの先端が動き続けた。
 *   修正のステップ以外が書いた内容かもしれないので、呼び出し側は、保護パスの検査に任せる。
 * - `manual`: 再計算が、再試行では直らない理由でできない。固定の理由で人の手に回す。
 *   一時的な失敗は、この型にせず、`RehashTransientError`を投げる。
 */
export type RehashConfirmation =
  | {
      readonly ok: true;
      /** 確かめた時点の、baseの先端。 */
      readonly baseSha: string;
      /** 再計算のUTF-8のバイト列と一致した、`wmill-lock.yaml`のバイト列。 */
      readonly lockBytes: Uint8Array;
    }
  | { readonly ok: false; readonly kind: "mismatch" }
  | {
      readonly ok: false;
      readonly kind: "manual";
      readonly reason: MetadataManualReason;
      readonly detail?: string;
    };

/** 再計算と一致すると確認できた結果。 */
export type RehashConfirmed = Extract<RehashConfirmation, { ok: true }>;

/**
 * 照合の結果を、`inspectCiFixChanges`が使う判定にする。
 * 確認できたら許し、そのほかは、原則として保護パスの検査に任せる。
 * 固定の理由で直せないときは、再計算の回(`isRehashRound`)に限り、その理由で止める。
 * Claudeの回で`wmill-lock.yaml`だけが変わったときに、「metadataジョブの失敗を直せない」と案内しないためである。
 * そのときは、保護パスの違反として拒否する。`isRehashRound`は、直せないときにだけ呼ぶ。
 */
export async function confirmationVerdict(
  confirmation: RehashConfirmation,
  isRehashRound: () => Promise<boolean>,
): Promise<RehashCheckVerdict> {
  if (confirmation.ok) return { kind: "allow" };
  if (confirmation.kind === "mismatch") return { kind: "deny" };
  if (!(await isRehashRound())) return { kind: "deny" };
  return {
    kind: "stop",
    reason: metadataManualReason(confirmation.reason, confirmation.detail),
  };
}

/** baseの先端が動いたときに、再計算を取り直す回数の上限。 */
export const REHASH_CONFIRM_ATTEMPTS = 3;

const utf8 = new TextEncoder();

/**
 * `wmill-lock.yaml`のバイト列が、独立した再計算の結果と一致することを確かめる。
 * baseの先端を読み、その先端で再計算し、再計算の本文のUTF-8のバイト列と比べる。
 * 比べた後にbaseの先端をもう一度読み直して同じなら、確認済みとする。
 * 先端が動いていたら、新しい先端で最初からやり直す。上限(`REHASH_CONFIRM_ATTEMPTS`)を超えても動き続けるときは、確認できないとする。
 * 再試行で直らない理由で再計算できないときは`manual`、バイト列が違う、バイト列を読めないときは`mismatch`を返す。
 * 通ったバイト列は、修正のステップが書いたものと同じであり、依存や`schema`を書き換えていない。
 * 再計算が一時的な理由で失敗したとき(`port_error`、`ancestry_unknown`)は、`RehashTransientError`を投げる。
 * 読み取りや取り込みの例外も、そのまま投げる。一時的な失敗なので、呼び出し側が再試行する。
 */
export async function confirmRehash(
  deps: RehashConfirmDeps,
): Promise<RehashConfirmation> {
  const lock = await deps.readLock();
  if (lock === null) return { ok: false, kind: "mismatch" };
  for (let attempt = 0; attempt < REHASH_CONFIRM_ATTEMPTS; attempt += 1) {
    const baseSha = await deps.readBase();
    const plan = await deps.planWith(baseSha);
    if (!plan.ok) {
      if (TRANSIENT_REHASH_REASONS.has(plan.reason)) {
        throw new RehashTransientError(plan.reason);
      }
      return plan.detail === undefined
        ? { ok: false, kind: "manual", reason: plan.reason }
        : {
            ok: false,
            kind: "manual",
            reason: plan.reason,
            detail: plan.detail,
          };
    }
    if (!bytesEqual(utf8.encode(plan.newLock), lock)) {
      return { ok: false, kind: "mismatch" };
    }
    if ((await deps.readBase()) === baseSha) {
      return { ok: true, baseSha, lockBytes: lock };
    }
  }
  return { ok: false, kind: "mismatch" };
}

/** `stagedRehashGate`の結果の型。 */
export type StagedRehashGate = {
  readonly confirmed: RehashConfirmed | null;
  readonly check: () => Promise<RehashCheckVerdict>;
};

/** `stagedRehashGate`が使うI/O。 */
export type StagedRehashDeps = {
  /** ステージ前の変更が、再計算の出力の候補か(`isRehashCandidate`)。 */
  readonly candidate: boolean;
  /** worktreeの`wmill-lock.yaml`を、独立した再計算と照合する(`confirmRehash`)。 */
  readonly confirm: () => Promise<RehashConfirmation>;
  /** ステージした`wmill-lock.yaml`のバイト列。読めなければ`null`。 */
  readonly readStaged: () => Promise<Uint8Array | null>;
  /** 今の回が再計算の回か。照合が固定の理由で直せないときにだけ呼ぶ(`confirmationVerdict`)。 */
  readonly isRehashRound: () => Promise<boolean>;
};

/**
 * 完了のステップの照合。候補のときだけ、worktreeの内容を再計算と照合する(時間のかかる前段)。
 * 返す`check`は、リポジトリのロックの中で呼ぶ。ステージした本文が、照合済みの本文と同じときだけ許す。
 * 候補でないとき、ステージが違うとき、読めないときは`deny`を返し、保護パスの検査に任せる。
 * 照合が固定の理由で直せないとわかったときは、`stop`を返す。
 * `confirmed`は、pushの直前に、baseの先端が動いていないかを確かめるために返す。
 * 照合が一時的な理由で失敗したときは、`RehashTransientError`を投げる。
 */
export async function stagedRehashGate(
  deps: StagedRehashDeps,
): Promise<StagedRehashGate> {
  if (!deps.candidate) {
    return { confirmed: null, check: async () => ({ kind: "deny" }) };
  }
  const confirmation = await deps.confirm();
  if (!confirmation.ok) {
    const verdict = await confirmationVerdict(confirmation, deps.isRehashRound);
    return { confirmed: null, check: async () => verdict };
  }
  return {
    confirmed: confirmation,
    check: async () => {
      const staged = await deps.readStaged();
      return staged !== null && bytesEqual(staged, confirmation.lockBytes)
        ? { kind: "allow" }
        : { kind: "deny" };
    },
  };
}

/** pushの直前に、baseの先端が動き、確認し直した再計算が、確認済みの本文と合わなくなったときの理由。 */
export const CI_ROUND_REHASH_STALE_REASON = ciRoundReason(
  "the base branch moved and the recomputed lock no longer matches",
);

/**
 * pushの直前に、baseの先端が確認したときのままかを確かめ、止める理由を返す。問題が無ければ`null`を返す。
 * 動いていたら、pushせず、新しい先端でもう一度確認する(`confirmRehash`)。
 * 確認し直しても、確認済みのバイト列と同じものが再計算の結果なら、そのままpushしてよい。
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
    readLock: async () => confirmed.lockBytes,
  });
  return again.ok ? null : CI_ROUND_REHASH_STALE_REASON;
}

/**
 * worktreeの根の`wmill-lock.yaml`のバイト列を読む。
 * `O_NOFOLLOW`で開き、symlinkはたどらない。FIFOで止まらないよう`O_NONBLOCK`も付ける。
 * 通常のファイルでないとき、読めないときは`null`を返す。
 */
export async function readRootWmillLock(
  worktreeDir: string,
): Promise<Uint8Array | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      `${worktreeDir}/wmill-lock.yaml`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    return new Uint8Array(await handle.readFile());
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * ステージした`wmill-lock.yaml`のバイト列を、索引から読む(`git cat-file blob :wmill-lock.yaml`)。
 * commitされる内容そのものである。文字列に復号せず、バイト列のまま返す。
 * gitが失敗したときと、時間を超えたときは`null`を返す。
 */
export async function readStagedRootLock(
  runBytes: BytesRunner,
  worktreeDir: string,
): Promise<Uint8Array | null> {
  const result = await runBytes(
    buildGitArgv(["cat-file", "blob", ":wmill-lock.yaml"]),
    { cwd: worktreeDir, env: localGitEnv(), timeoutMs: DEFAULT_TIMEOUT_MS },
  );
  if (result.timedOut || result.exitCode !== 0) return null;
  return result.stdout;
}

/** `open`が、再試行しても直らない理由で失敗したときの`errno`の名前。 */
const UNWRITABLE_ERRNO: ReadonlySet<string> = new Set([
  "ELOOP",
  "EACCES",
  "EPERM",
  "EISDIR",
  "ENOENT",
  "ENOTDIR",
  "EROFS",
  // 読み手の居ないFIFOを、`O_NONBLOCK`で書き込み用に開いたときの失敗。
  "ENXIO",
]);

/**
 * worktreeの根の`wmill-lock.yaml`を、通常のファイルとして書き換える。
 * `O_NOFOLLOW`で開き、symlinkはたどらない。FIFOで止まらないよう`O_NONBLOCK`も付ける。
 * `O_CREAT`は付けないので、無いファイルは作らない。
 * 開いたファイルが通常のファイルでないとき、実行権限があるとき、ほかにhard linkがあるとき、
 * symlink、無いファイル、権限が足りないときは、`LockNotWritableError`を投げる。
 * hard linkがあるときに書かないのは、別のパスのファイルまで書き換えてしまうためである。
 * それ以外の失敗は、そのまま投げる。
 * 書いた後に、ファイルの大きさが本文のバイト数と同じことを確かめる。
 * 書き先は、根の直下のこのファイルだけである。パスは呼び出し側が決めず、PRの作者が決めた名前を使わない。
 */
export async function writeRootWmillLock(
  worktreeDir: string,
  text: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      `${worktreeDir}/wmill-lock.yaml`,
      constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, "code") : null;
    if (typeof code === "string" && UNWRITABLE_ERRNO.has(code)) {
      throw new LockNotWritableError();
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    // 実行権限のあるファイルは、モード`100755`でcommitされる。後のステップが`100644`だけを許すので、書かずに止める。
    if (!info.isFile() || (info.mode & 0o111) !== 0 || info.nlink !== 1) {
      throw new LockNotWritableError();
    }
    await handle.truncate(0);
    await handle.writeFile(text, "utf8");
    if ((await handle.stat()).size !== Buffer.byteLength(text, "utf8")) {
      throw new Error("wmill-lock.yaml was not written completely");
    }
  } finally {
    await handle.close();
  }
}
