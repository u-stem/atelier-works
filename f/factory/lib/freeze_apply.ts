// 凍結の状態を読み、`wmill sync push`へ渡す除外を作り、追従が済んだ行を消す手順。
// 変数の読み書きは注入された入出力で行い、`self_update`と`scripts/freeze.ts`が同じ手順を使う。
//
// 変数は人の端末(`place`と`release`)と`self_update`(追従が済んだ行の削除)が書く。
// 書く前に必ず読み直してidで合わせるので、競合する窓は読み直しから書き込みまでに限られる。

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  activeFreezes,
  buildExcludes,
  endedFreezes,
  excludesArg,
  FREEZE_VARIABLE_PATH,
  type FreezeState,
  type Outcome,
  parseFreezeState,
  parseWmillExcludes,
  removeFreezes,
  serializeFreezeState,
} from "./freezes.ts";

export type FreezePorts = {
  /** 変数の値。変数が無いと確かめられたときだけ`null`を返す。読めなければ例外を投げる。 */
  readonly readVariable: () => Promise<string | null>;
  readonly writeVariable: (text: string) => Promise<void>;
  readonly now: () => Date;
};

export type FreezeInputs = {
  readonly baseExcludes: readonly string[];
  /** 実在する`*.schedule.yaml`のパス(拡張子なし)。 */
  readonly known: ReadonlySet<string>;
};

export type FrozenPushPlan = {
  readonly excludesArg: string;
  readonly excludedTargets: readonly string[];
  /** この回の開始より前に終わっていた行。pushが成功したら消す。 */
  readonly readyIds: readonly string[];
  readonly warnings: readonly string[];
};

/** 失敗の文言に載せる、回復の手順。`reason`と`holder`は載せない。 */
export const FREEZE_RECOVERY_HINT = `the freeze variable ${FREEZE_VARIABLE_PATH} is corrupt; a human can run "mise run freeze:reset" to clear it`;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readState(ports: FreezePorts): Promise<Outcome<FreezeState>> {
  let raw: string | null;
  try {
    raw = await ports.readVariable();
  } catch (err) {
    return {
      ok: false,
      reason: `could not read the freeze variable: ${errorMessage(err)}`,
    };
  }
  const parsed = parseFreezeState(raw);
  return parsed.ok
    ? parsed
    : { ok: false, reason: `${parsed.reason} (${FREEZE_RECOVERY_HINT})` };
}

/**
 * 変数を読み、`--excludes=<値>`と、追従の対象を作る。変数を読めない、壊れている、
 * `wmill.yaml`の除外が欠けているときは失敗にする(呼び出し側は反映しない)。
 * 実在しないスケジュールの凍結は、害がないので除外に足したうえで警告する。
 */
export async function prepareFrozenPush(
  ports: FreezePorts,
  inputs: FreezeInputs,
): Promise<Outcome<FrozenPushPlan>> {
  const state = await readState(ports);
  if (!state.ok) return state;
  const now = ports.now();
  const targets = activeFreezes(state.value, now).map((e) => e.target);
  const excludes = buildExcludes(inputs.baseExcludes, targets);
  if (!excludes.ok) return excludes;
  const warnings = targets
    .filter((target) => !inputs.known.has(target))
    .map((target) => `the frozen schedule ${target} has no schedule file`);
  return {
    ok: true,
    value: {
      excludesArg: excludesArg(excludes.value),
      excludedTargets: targets,
      readyIds: endedFreezes(state.value, now).map((e) => e.id),
      warnings,
    },
  };
}

/**
 * 追従のpushが済んだ行を消す。書く直前に読み直し、指定した行だけを消すので、
 * 準備の後に置かれた行は残る。読めないときは例外を投げる。
 */
export async function finishFrozenPush(
  ports: FreezePorts,
  readyIds: readonly string[],
): Promise<void> {
  if (readyIds.length === 0) return;
  const state = await readState(ports);
  if (!state.ok) throw new Error(state.reason);
  const next = removeFreezes(state.value, readyIds);
  if (next.freezes.length === state.value.freezes.length) return;
  await ports.writeVariable(serializeFreezeState(next));
}

/** 読み直した状態に操作を当てて書く(人の端末の`place`、`release`が使う)。 */
export async function mutateFreezeState(
  ports: FreezePorts,
  operation: (state: FreezeState, now: Date) => Outcome<FreezeState>,
): Promise<Outcome<FreezeState>> {
  const state = await readState(ports);
  if (!state.ok) return state;
  const next = operation(state.value, ports.now());
  if (!next.ok) return next;
  await ports.writeVariable(serializeFreezeState(next.value));
  return next;
}

const SCHEDULE_SUFFIX = ".schedule.yaml";

/** 作業ツリーから、`wmill.yaml`の除外と、実在するスケジュールの一覧を読む。子プロセスは使わない。 */
export async function loadFreezeInputs(
  cloneDir: string,
): Promise<Outcome<FreezeInputs>> {
  let yamlText: string;
  try {
    yamlText = await readFile(join(cloneDir, "wmill.yaml"), "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `could not read wmill.yaml: ${errorMessage(err)}`,
    };
  }
  const excludes = parseWmillExcludes(yamlText);
  if (!excludes.ok) return excludes;
  let files: string[];
  try {
    files = await readdir(join(cloneDir, "f"), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      reason: `could not list the schedule files: ${errorMessage(err)}`,
    };
  }
  const known = new Set(
    files
      .filter((file) => file.endsWith(SCHEDULE_SUFFIX))
      .map((file) => `f/${file.slice(0, -SCHEDULE_SUFFIX.length)}`),
  );
  return { ok: true, value: { baseExcludes: excludes.value, known } };
}

/** `windmill-client`のうち、凍結の変数の読み書きに使う部分。 */
export type FreezeSdk = {
  readonly getVariable: (path: string) => Promise<string>;
  readonly setVariable: (
    path: string,
    value: string,
    isSecretIfNotExist?: boolean,
    descriptionIfNotExist?: string,
  ) => Promise<void>;
  readonly VariableService: {
    readonly existsVariable: (args: {
      workspace: string;
      path: string;
    }) => Promise<boolean>;
  };
};

export const FREEZE_VARIABLE_DESCRIPTION =
  "スケジュールの凍結の状態です。mise run freeze:placeなどが書くため、通常は人が編集する必要はありません。";

/**
 * Windmillの変数を読み書きする入出力。`getVariable`は変数が無い場合もほかの失敗も同じ形の例外を
 * 投げるので、読めなかったときに`existsVariable`で有無を確かめ、`false`のときだけ「無い」とする。
 */
export function sdkFreezePorts(
  sdk: FreezeSdk,
  workspace: string,
  now: () => Date,
): FreezePorts {
  return {
    readVariable: async () => {
      try {
        return await sdk.getVariable(FREEZE_VARIABLE_PATH);
      } catch (err) {
        let found: unknown;
        try {
          found = await sdk.VariableService.existsVariable({
            workspace,
            path: FREEZE_VARIABLE_PATH,
          });
        } catch {
          throw err;
        }
        if (found === false) return null;
        throw err;
      }
    },
    writeVariable: (text) =>
      sdk.setVariable(
        FREEZE_VARIABLE_PATH,
        text,
        false,
        FREEZE_VARIABLE_DESCRIPTION,
      ),
    now,
  };
}
