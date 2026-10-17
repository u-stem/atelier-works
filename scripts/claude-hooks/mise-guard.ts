// miseのサブコマンドを判定する。`mise.local.toml`の秘密値を一覧するか、
// タスクのシェルを差し替えて出力できる呼び出しを見つける。bash-guard.tsが呼ぶ。
// 判定の方針と確かめた事実は、docs/security.mdの「miseの一覧の判定」にある。

import {
  ASSIGNMENT,
  MISE_VALUE_OPTIONS,
  miseOptionTakesNext,
  type Word,
} from "./shell-words.ts";

/** `mise set`の書き込む形が持ってよい、値を取るオプション。 */
const MISE_SET_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  ...MISE_VALUE_OPTIONS,
  "--file",
  "--age-key-file",
  "--age-recipient",
  "--age-ssh-recipient",
]);

/**
 * `mise set`の書き込む形が持ってよい、値を取らないオプション。
 * 値を取る隠しオプションは数え切れないので、ここに無いオプションは書き込む形とみなさない。
 */
const MISE_SET_FLAGS: ReadonlySet<string> = new Set([
  "--stdin",
  "-g",
  "--global",
  "--age-encrypt",
]);

/** `mise set`の別名。`ev`と`env-vars`も値を一覧する。 */
const MISE_SET_NAMES: ReadonlySet<string> = new Set(["set", "ev", "env-vars"]);

/** 設定値を一覧するか、設定値を持つシェルを起動するだけで、書き込む形を持たないサブコマンドと、その別名。 */
const MISE_READ_NAMES: ReadonlySet<string> = new Set([
  "env",
  "e",
  "config",
  "cfg",
  "toml",
  "hook-env",
  "en",
]);

/**
 * このリポジトリで使うサブコマンドと、秘密値も書き込みも出さないと実機で確かめたサブコマンド。別名を含む。
 * `mise <タスク名>`の省略形は含まない。`mise run <タスク名>`と書く。
 * ここに無いサブコマンドは、miseの更新で値を出すものが増えても塞げるよう、拒否する。
 */
const MISE_PLAIN_NAMES: ReadonlySet<string> = new Set([
  "run",
  "r",
  "exec",
  "x",
  "install",
  "i",
  "trust",
  "ls",
  "list",
  "which",
  "where",
  "version",
  "current",
]);

/** タスクを実行するサブコマンド。`-s`と`--shell`で、呼び出し側が実行するシェルを決められる。 */
const MISE_RUNNER_NAMES: ReadonlySet<string> = new Set(["run", "r"]);

/** インストール先のディレクトリを決められるサブコマンドと、そのオプション。 */
const MISE_INSTALL_NAMES: ReadonlySet<string> = new Set(["install", "i"]);
const MISE_INSTALL_PATH_OPTION = /^--(shared|system)(=.*)?$/;

/** `--shell`、`-s`、`-s`を含む束ねた短いオプション。 */
const MISE_SHELL_OPTION = /^(--shell(=.*)?|-[A-Za-z]*s.*)$/;

/** シェルやタスクの実行を差し替えない`MISE_*`の環境変数。これ以外の代入は、前置きでも`mise set`でも拒否する。 */
export const MISE_ALLOWED_ENV: ReadonlySet<string> = new Set([
  "MISE_ENV",
  "MISE_JOBS",
  "MISE_QUIET",
  "MISE_VERBOSE",
  "MISE_YES",
]);

/** 起動したシェルにコードを実行させるか、起動するシェルや設定を差し替える環境変数。`mise`が読むと、秘密値を出力できる。 */
export const SHELL_HOOK_ENV =
  /^(BASH_ENV|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|BASH_FUNC_.*|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$/;

/** `mise`を起動するコマンドへの前置きと、`mise set`の鍵でだけ拒否する環境変数。ほかのコマンドでは通常の作業で使う。 */
export const SHELL_HOOK_ENV_FOR_MISE = /^(ENV|PATH)$/;

/**
 * `mise set`のオペランドが、許可リストに無い`MISE_*`か、シェルを動かす環境変数を環境へ書くなら真。
 * `mise.local.toml`の`[env]`に書いた値は、入れ子の`mise run`が設定として読むので、シェルを差し替えられる。
 */
function setsMiseSetting(word: Word): boolean {
  const [name = ""] = word.text.split("=", 1);
  return (
    (name.startsWith("MISE_") && !MISE_ALLOWED_ENV.has(name)) ||
    SHELL_HOOK_ENV.test(name) ||
    SHELL_HOOK_ENV_FOR_MISE.test(name)
  );
}

/** 引用符の外に`{`を持つ語。実行時にブレース展開で語が増える。 */
function hasBrace(word: Word): boolean {
  return word.brace === true;
}

/**
 * `mise`の後ろで、最初のオプションでない語の位置を返す。なければ語の数を返す。
 * 値を取る既知のグローバルオプションは、値の語まで読み飛ばす。
 */
function firstMiseOperandAt(args: readonly Word[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (!text.startsWith("-")) return index;
    if (miseOptionTakesNext(text)) index += 1;
  }
  return args.length;
}

/**
 * `mise set`などが、書き込む形を持たずに値を一覧するなら真。
 * サブコマンドの前に置けるグローバルオプションは、値を取る隠しものがあるため列挙しない。
 * `--`より前の語に`set`、`env`、`config`など(か別名)があれば、そのサブコマンドの呼び出しとして判定する。
 * `env`と`config`の系統には書き込む形が無いので、あれば拒否する。
 * サブコマンドの位置にあたる語が、引用符の外にブレースを持つときも拒否する。語が増えて、サブコマンドが変わるためである。
 * `mise set`の書き込む形は2つある。オペランドがすべて`KEY=VALUE`である形と、
 * `--stdin`を持ち、オペランドが展開を含まない鍵の名前1つだけの形である。
 * `KEY=VALUE`のオペランドは、展開やブレースを含んでも、先頭の`KEY=`が残るので書き込みのままである。
 * 書き込む形のオプションは、許可リストにあるものだけにする。未知のオプションは、
 * 値を取ってオペランドの数を変えるおそれがあるので、一覧を出す形として扱う。
 * 展開やglobを含むオプションとその値は、実行時に語が増えて隠しオプションが現れうるので、
 * 書き込む形とみなさない。`--`を持つ形も、鍵の名前と区別できないので同じである。
 * オペランドにサブコマンド名(`set`、`ev`、`env-vars`)があるときは、
 * 前のオプションの値を取り違えたおそれがあるので、同じく書き込む形とみなさない。
 */
export function listsMiseValues(words: readonly Word[]): boolean {
  const args = words.slice(1);
  const dashDash = args.findIndex((word) => word.text === "--");
  const beforeDashDash = dashDash === -1 ? args : args.slice(0, dashDash);
  const nameAt = beforeDashDash.findIndex(
    (word) => MISE_SET_NAMES.has(word.text) || MISE_READ_NAMES.has(word.text),
  );
  const operandAt = firstMiseOperandAt(beforeDashDash);
  const headEnd =
    nameAt === -1 ? operandAt + 1 : Math.min(nameAt, operandAt + 1);
  if (beforeDashDash.slice(0, headEnd).some(hasBrace)) return true;
  if (
    dashDash !== -1 &&
    operandAt >= beforeDashDash.length &&
    args.length > dashDash + 1
  ) {
    return true;
  }
  const sub = beforeDashDash[operandAt];
  if (
    sub !== undefined &&
    MISE_INSTALL_NAMES.has(sub.text) &&
    beforeDashDash
      .slice(operandAt + 1)
      .some((word) => MISE_INSTALL_PATH_OPTION.test(word.text))
  ) {
    return true;
  }
  if (
    sub !== undefined &&
    MISE_RUNNER_NAMES.has(sub.text) &&
    beforeDashDash
      .slice(operandAt + 1)
      .some((word) => MISE_SHELL_OPTION.test(word.text))
  ) {
    return true;
  }
  if (
    sub !== undefined &&
    !MISE_SET_NAMES.has(sub.text) &&
    !MISE_READ_NAMES.has(sub.text) &&
    !MISE_PLAIN_NAMES.has(sub.text)
  ) {
    return true;
  }
  const name = beforeDashDash[nameAt];
  if (name === undefined) return false;
  if (MISE_READ_NAMES.has(name.text)) return true;
  if (dashDash !== -1) return true;
  const operands: Word[] = [];
  let readsStdin = false;
  const rest = beforeDashDash.slice(nameAt + 1);
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (word === undefined) continue;
    if (!word.text.startsWith("-")) {
      if (MISE_SET_NAMES.has(word.text)) return true;
      operands.push(word);
      continue;
    }
    if (word.dynamic || word.glob || hasBrace(word)) return true;
    const [optionName = ""] = word.text.split("=", 1);
    const isValueOption = MISE_SET_VALUE_OPTIONS.has(word.text);
    if (word.text === "--stdin") {
      readsStdin = true;
    } else if (isValueOption) {
      const value = rest[index + 1];
      if (
        value !== undefined &&
        (value.dynamic || value.glob || hasBrace(value))
      ) {
        return true;
      }
      index += 1;
    } else if (
      !MISE_SET_FLAGS.has(word.text) &&
      !(word.text.includes("=") && MISE_SET_VALUE_OPTIONS.has(optionName))
    ) {
      return true;
    }
  }
  if (operands.length === 0) return true;
  if (operands.some(setsMiseSetting)) return true;
  if (operands.every((word) => ASSIGNMENT.test(word.text))) return false;
  const [key] = operands;
  return !(
    readsStdin &&
    operands.length === 1 &&
    key !== undefined &&
    !key.dynamic &&
    !key.glob &&
    !hasBrace(key)
  );
}
