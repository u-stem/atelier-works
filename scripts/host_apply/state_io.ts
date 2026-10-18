/**
 * 状態ファイル(`state.json`)の読み書き。
 * `state.json`を書く経路はこのファイルだけで、公開は`readState`、`writeState`、`createState`、`commitApplied`、`reinit`の5つに閉じる。
 * 適用済みのsha(`applied_sha`)を変えられるのは、`createState`、`commitApplied`、`reinit`の3つだけで、
 * `writeState`は`applied_sha`と`applied_images`が変わる書き込みを拒否する。
 * 書く関数は、ロックを持つ呼び出し側から`HeldLock`を受け取り、書く直前に確かめる。
 * ファイルの安全な読み書きは`secure_file.ts`に任せる。
 */

import { readDrain, writeDrain } from "./drain_store.ts";
import type { HeldLock } from "./held_lock.ts";
import { currentUid, readSecureFile, writeSecureFile } from "./secure_file.ts";
import { stableStringify } from "./stable.ts";
import {
  applyCommit,
  type CommitInput,
  type HostApplyState,
  type ImageEntry,
  isAllowedTransition,
  MAX_STATE_BYTES,
  newState,
  parseState,
  serializeState,
} from "./state.ts";

export type ReadStateResult =
  | { readonly kind: "absent" }
  | {
      readonly kind: "state_unreadable";
      readonly cause: "unsafe" | "io" | "shape";
      readonly reason: string;
    }
  | { readonly kind: "ok"; readonly state: HostApplyState };

const FILE_NAME = "state.json";
const FILE_LABEL = "state file";

/**
 * 置き場の状態を読む。
 * 置き場かファイルが無ければ`absent`。安全でない、読めない、形の合わない本文は`state_unreadable`にし、空とみなさない。
 * 理由に本文は含めない。
 */
export function readState(
  dir: string,
  uid: number = currentUid(),
): ReadStateResult {
  const result = readSecureFile({
    dir,
    name: FILE_NAME,
    label: FILE_LABEL,
    maxBytes: MAX_STATE_BYTES,
    uid,
  });
  if (result.kind === "absent") return result;
  if (result.kind === "invalid") {
    return {
      kind: "state_unreadable",
      cause: result.cause,
      reason: result.reason,
    };
  }
  const parsed = parseState(result.text);
  if (parsed.kind === "state_unreadable") {
    return {
      kind: "state_unreadable",
      cause: "shape",
      reason: parsed.reason,
    };
  }
  return { kind: "ok", state: parsed.state };
}

/** 検査を満たした状態を書く。ロックを持っていなければ、書く前に例外になる。 */
function persist(
  dir: string,
  state: HostApplyState,
  lock: HeldLock,
  uid: number,
): void {
  const body = serializeState(state);
  lock.assertHeld(dir);
  writeSecureFile({
    dir,
    name: FILE_NAME,
    label: FILE_LABEL,
    body,
    maxBytes: MAX_STATE_BYTES,
    uid,
  });
}

function requireState(dir: string, uid: number): HostApplyState {
  const current = readState(dir, uid);
  if (current.kind === "ok") return current.state;
  throw new Error(
    current.kind === "absent"
      ? "state file does not exist"
      : "state file is not readable",
  );
}

/**
 * 状態を更新する。`applied_sha`と`applied_images`が変わる更新は拒否する。
 * 既存の状態が読めなければ、新しく作らず例外にする。
 */
export function writeState(
  dir: string,
  next: HostApplyState,
  lock: HeldLock,
  uid: number = currentUid(),
): void {
  const current = requireState(dir, uid);
  if (
    next.applied_sha !== current.applied_sha ||
    stableStringify(next.applied_images) !==
      stableStringify(current.applied_images)
  ) {
    throw new Error("applied state cannot change through writeState");
  }
  if (!isAllowedTransition(current, next)) {
    throw new Error("converging record cannot change this way");
  }
  persist(dir, next, lock, uid);
}

/**
 * 動いているスタックが、指定のコミットとイメージの定義と一致するかを確かめる関数。
 * 実装はdockerを呼ぶ側が注入する。次の3つをすべて満たすときだけ真を返す契約にする。
 * - 動いているサービスがすべて`images`のキーにあり(空は偽)、常駐するサービスもすべて`images`のキーにある。
 *   一度だけ動いて終わるサービスは、`images`にあってもよい。
 * - 各コンテナのイメージIDが、`images`の`image_id`と等しい。
 * - `build_key`が、信頼できるgitのオブジェクトから`sha`のtreeで求めた値と等しい。
 * 共有ボリュームの印のように、workerが書ける出どころを唯一の根拠にしてはならない。
 */
export type StackCheck = (
  sha: string,
  images: Readonly<Record<string, ImageEntry>>,
) => Promise<boolean>;

export type CreateStateInput = {
  readonly applied_sha: string;
  readonly applied_images: Readonly<Record<string, ImageEntry>>;
  readonly stackMatches: StackCheck;
};

async function requireStack(
  check: StackCheck,
  sha: string,
  images: Readonly<Record<string, ImageEntry>>,
): Promise<void> {
  // 照合した内容と書く内容を同じにするため、照合には写しを渡す。
  if ((await check(sha, structuredClone(images))) !== true) {
    throw new Error("running stack does not match the sha");
  }
}

/** 排水の記録が、読めて空かを確かめる。`allowAbsent`が真なら、無い場合も通す。 */
function requireEmptyDrain(
  dir: string,
  uid: number,
  allowAbsent: boolean,
): "empty" | "absent" {
  const drain = readDrain(dir, uid);
  if (drain.kind === "absent" && allowAbsent) return "absent";
  if (drain.kind !== "found" || Object.keys(drain.record.entries).length > 0) {
    throw new Error("drain file is not empty");
  }
  return "empty";
}

/**
 * 状態を新しく作る(`init`の部品)。`state.json`が無いときだけ作り、読めない・壊れたファイルがあっても失敗する。
 * 排水の記録は、無いか空でなければならない。無ければ、状態より先に空の記録を作る。
 * 状態の後に排水の記録が無いと、実行役が排水を拒み続けるためである。
 * 動いているスタックが定義と一致することも要る。
 * 置き場は作らない。置き場とロックは、呼び出し側が先に用意する。
 * 「無い」の確認から書くまでの間の競合は、ロックで防ぐ。
 */
export async function createState(
  dir: string,
  input: CreateStateInput,
  lock: HeldLock,
  uid: number = currentUid(),
): Promise<HostApplyState> {
  if (readState(dir, uid).kind !== "absent") {
    throw new Error("state file already exists");
  }
  const drain = requireEmptyDrain(dir, uid, true);
  // 呼び出し側が照合の間に書き換えられないよう、先に写しを取る。
  const images = structuredClone(input.applied_images);
  const state = newState(input.applied_sha, images);
  // 型ガードに通す。形の合わない入力を、照合の関数に渡す前に止めるため。
  serializeState(state);
  await requireStack(input.stackMatches, input.applied_sha, images);
  // 状態の「無い」の再確認はしない。排水の記録は別の書き手が作りうるが、状態はロックで守る。
  if (drain === "absent") {
    lock.assertHeld(dir);
    // 照合を待つ間に別の書き手が作った記録を、空の記録で上書きしない。
    if (readDrain(dir, uid).kind !== "absent") {
      throw new Error("drain file appeared during the check");
    }
    writeDrain(dir, { schema: 1, entries: {} }, lock, uid);
  }
  persist(dir, state, lock, uid);
  return state;
}

export type CommitAppliedInput = CommitInput & {
  readonly stackMatches: StackCheck;
};

/**
 * 後処理まで済んだ収束を適用済みにする(`post`の完了と`finish`)。
 * `phase`が`post`の`converging`が要り、動いているスタックが新しいコミットとイメージの定義と一致することも要る。
 */
export async function commitApplied(
  dir: string,
  input: CommitAppliedInput,
  lock: HeldLock,
  uid: number = currentUid(),
): Promise<HostApplyState> {
  // 呼び出し側が照合の間に書き換えられないよう、先に写しを取る。
  const images = structuredClone(input.images);
  const next = applyCommit(requireState(dir, uid), { ...input, images });
  await requireStack(input.stackMatches, next.applied_sha, images);
  persist(dir, next, lock, uid);
  return next;
}

/**
 * 適用済みのshaを、人の指定で置き換える(`init --applied`の再実行)。
 * `converging`が無く、`drain.json`が読めて空で、動いているスタックが新しいshaと一致するときだけ行う。
 * `drain.json`が無いか壊れているときは、空でないものとして拒否する。
 * 拒否の控えなどは引き継がず、新しい状態に置き換える。
 */
export async function reinit(
  dir: string,
  input: CreateStateInput,
  lock: HeldLock,
  uid: number = currentUid(),
): Promise<HostApplyState> {
  const current = requireState(dir, uid);
  if (current.converging !== null) {
    throw new Error("a convergence is in progress");
  }
  requireEmptyDrain(dir, uid, false);
  // 呼び出し側が照合の間に書き換えられないよう、先に写しを取る。
  const images = structuredClone(input.applied_images);
  const state = newState(input.applied_sha, images);
  // 型ガードに通す。形の合わない入力を、照合の関数に渡す前に止めるため。
  serializeState(state);
  await requireStack(input.stackMatches, input.applied_sha, images);
  persist(dir, state, lock, uid);
  return state;
}
