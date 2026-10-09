// 秘密値を環境変数として持つコマンドから、値を会話の記録に出させないための判定。
// `mise exec`の中のコマンドと、`docker exec`や`docker inspect`などが対象である。
// 環境変数の一覧を出すコマンドと、コードを渡したシェルは、値を表示できる。
// 名前を指定したツールや、スクリプトのファイルを渡したシェルは、拒否しない。

import {
  baseName,
  shellArguments,
  stripWrappers,
  type Word,
} from "./shell-words.ts";

/** 環境変数の一覧を出すコマンド(`env`は前置きとして扱うので別に見る)。 */
const ENVIRONMENT_PRINTERS: ReadonlySet<string> = new Set(["printenv", "set"]);

/** 値を設定せずに一覧を出す、組み込みコマンドの`-p`。 */
const LISTING_BUILTINS: ReadonlySet<string> = new Set([
  "export",
  "declare",
  "typeset",
]);

/** dockerの値を取るオプション(サブコマンドより前にあるもの)。 */
const DOCKER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-H",
  "--host",
  "--context",
  "-c",
  "-l",
  "--log-level",
  "--config",
]);

/** `docker compose`の値を取るオプション(サブコマンドより前にあるもの)。 */
const COMPOSE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--profile",
  "--env-file",
  "--project-directory",
  "--ansi",
  "--parallel",
]);

/** `docker exec`と`docker compose exec`の値を取るオプション。 */
const EXEC_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-e",
  "--env",
  "--env-file",
  "-u",
  "--user",
  "-w",
  "--workdir",
  "--detach-keys",
  "--index",
]);

/** `docker compose config`のうち、定義の一部だけを出し、環境変数の値を出さないオプション。 */
const SAFE_CONFIG_OPTIONS: ReadonlySet<string> = new Set([
  "--services",
  "--profiles",
  "--volumes",
  "--images",
  "-q",
  "--quiet",
  "--no-interpolate",
]);

/**
 * `docker inspect --format`で許す指定。`{{...}}`の中身は、フィールドへの経路(`.State.Running`)だけを許し、
 * `json`を前に付けてもよい。オブジェクト全体(`.`)、`range`、`printf`、`index`などは、環境変数を含む部分を出せるので許さない。
 * 経路に`Env`か`Config`を含むものも許さない。
 */
const INSPECT_ACTION =
  /^\{\{-?\s*(?:json\s+)?(\.[A-Za-z][A-Za-z0-9_.]*)\s*-?\}\}$/;
/** 経路の区切りごとに、環境変数を含む`Env`か`Config`かを見る。`.HostConfig.Binds`のように名前の一部なら許す。 */
const INSPECT_SECRET_SEGMENT = /^(env|config)$/i;

/** `/proc/<pid>/environ`と`/proc/<pid>/task/<tid>/environ`。プロセスの環境変数がそのまま入っている。`<pid>`は`self`や`*`でもよい。 */
const PROC_ENVIRON = /^\/proc\/[^/]*(\/task\/[^/]*)?\/environ$/;

/** 名前や属性だけを扱い、中身を読まないコマンド。`/proc/<pid>/environ`を渡しても値は出ない。 */
const METADATA_PROGRAMS: ReadonlySet<string> = new Set([
  "ls",
  "stat",
  "test",
  "[",
  "[[",
  "file",
  "realpath",
  "readlink",
  "basename",
  "dirname",
  "du",
  "echo",
  "printf",
]);

export type DockerExposure = "config" | "exec" | "inspect";

const NO_OPTIONS: ReadonlySet<string> = new Set();

/** `args`の最初のオプションでない語と、その後ろの語を返す。`valueOptions`のオプションは値の語も読み飛ばす。 */
export function firstOperand(
  args: readonly Word[],
  valueOptions: ReadonlySet<string> = NO_OPTIONS,
): { readonly text: string; readonly rest: readonly Word[] } | null {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (text.startsWith("-")) {
      if (valueOptions.has(text)) index += 1;
      continue;
    }
    return { text, rest: args.slice(index + 1) };
  }
  return null;
}

/**
 * シェルの引数から、コードの出どころ(`-c`の引数、スクリプトのファイル、標準入力)を返す。
 * `--version`のようにコードを読まない呼び出しは`none`を返す。
 */
export function shellInputSource(
  args: readonly Word[],
): "command" | "file" | "stdin" | "none" {
  let readsStdin = false;
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (text === "--") {
      if (readsStdin || args[index + 1] === undefined) return "stdin";
      return "file";
    }
    if (text === "-o" || text === "+o" || text === "-O" || text === "+O") {
      index += 1;
      continue;
    }
    if (text === "--version" || text === "--help") return "none";
    // 単独の`-`は標準入力からスクリプトを読む印である。
    if (text === "-") return "stdin";
    if (text.startsWith("--")) continue;
    if (text.startsWith("-") && text.length > 1) {
      if (text.includes("c")) return "command";
      if (text.includes("s")) readsStdin = true;
      continue;
    }
    if (text.startsWith("+")) continue;
    return readsStdin ? "stdin" : "file";
  }
  return "stdin";
}

/** 語が`/proc/<pid>/environ`を指すなら真。値が実行時に決まる語は、`/proc/`で始まり`/environ`で終われば指すものとして扱う。 */
function namesProcEnviron(word: Word): boolean {
  if (PROC_ENVIRON.test(word.text)) return true;
  return (
    word.dynamic &&
    word.text.includes("/proc/") &&
    word.text.endsWith("/environ")
  );
}

/**
 * `/proc/<pid>/environ`を読むなら真。どのコマンドの引数でも、リダイレクトの入力でも見る。
 * 名前や属性だけを扱う`ls`や`test`は除く。
 */
export function readsProcEnviron(
  words: readonly Word[],
  redirects: readonly Word[] = [],
): boolean {
  if (redirects.some(namesProcEnviron)) return true;
  const program = baseName(words[0]?.text ?? "");
  if (METADATA_PROGRAMS.has(program)) return false;
  return words.slice(1).some(namesProcEnviron);
}

/** コマンドが、環境変数の一覧を出すか、コードを渡したシェルなら真。前置きは外してから見る。 */
export function dumpsEnvironment(inner: readonly Word[]): boolean {
  const { words, wrappers } = stripWrappers(inner);
  if (readsProcEnviron(words)) return true;
  const first = words[0];
  // `env`は前置きとして外されるので、後ろにコマンドが無ければ一覧を出している。
  if (first === undefined) return wrappers.includes("env");
  const name = baseName(first.text);
  // `busybox env`のように、busyboxのアプレットは次の語がコマンドである。
  if (
    name === "busybox" &&
    words.length > 1 &&
    shellArguments(words) === null
  ) {
    return dumpsEnvironment(words.slice(1));
  }
  if (ENVIRONMENT_PRINTERS.has(name)) return true;
  if (LISTING_BUILTINS.has(name)) return words[1]?.text === "-p";
  const shellArgs = shellArguments(words);
  if (shellArgs === null) return false;
  const source = shellInputSource(shellArgs);
  return source === "command" || source === "stdin";
}

/** `docker exec`の引数から、コンテナの名前を飛ばした後のコマンドが環境変数を出すなら真。 */
function execExposes(args: readonly Word[]): boolean {
  const container = firstOperand(args, EXEC_VALUE_OPTIONS);
  return container !== null && dumpsEnvironment(container.rest);
}

/** `--format`の指定が、許す形のフィールドだけなら真。 */
function isSafeInspectFormat(format: Word): boolean {
  if (format.dynamic) return false;
  const actions = format.text.match(/\{\{.*?\}\}/g) ?? [];
  if (format.text.replace(/\{\{.*?\}\}/g, "").includes("{{")) return false;
  return actions.every((action) => {
    const path = INSPECT_ACTION.exec(action)?.[1];
    return (
      path !== undefined &&
      !path.split(".").some((segment) => INSPECT_SECRET_SEGMENT.test(segment))
    );
  });
}

/** `docker inspect`の引数に、許す形の`--format`が無いか、許さない`--format`が1つでもあれば真。 */
function inspectExposes(args: readonly Word[]): boolean {
  let found = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) break;
    let format: Word | null = null;
    if (word.text === "-f" || word.text === "--format") {
      format = args[index + 1] ?? null;
    } else if (word.text.startsWith("--format=")) {
      format = { ...word, text: word.text.slice("--format=".length) };
    }
    if (format === null) continue;
    found = true;
    if (!isSafeInspectFormat(format)) return true;
  }
  return !found;
}

/** `docker compose config`の引数に、出力を絞るオプションが無いか、環境変数を出す指定があれば真。 */
function configExposes(args: readonly Word[]): boolean {
  const flags = args.map((word) => word.text);
  if (flags.includes("--environment")) return true;
  return !flags.some(
    (flag) => SAFE_CONFIG_OPTIONS.has(flag) || flag.startsWith("--hash"),
  );
}

function composeExposure(args: readonly Word[]): DockerExposure | null {
  const sub = firstOperand(args, COMPOSE_VALUE_OPTIONS);
  if (sub === null) return null;
  if (sub.text === "exec") return execExposes(sub.rest) ? "exec" : null;
  if (sub.text === "config" || sub.text === "convert") {
    return configExposes(sub.rest) ? "config" : null;
  }
  return null;
}

/**
 * 環境変数の値を表示しうる`docker`の呼び出しなら、その種類を返す。
 * `docker exec`は環境変数の一覧かコードを渡したシェルを実行するとき、
 * `docker inspect`は`--format`で環境変数を含まない項目を選ばないとき、
 * `docker compose config`は出力を絞らないときが対象である。
 * `.claude/settings.json`の拒否ルールは前置き(`mise exec --`)があると効かず、引数も絞れないので、ここで見る。
 */
export function dockerExposure(words: readonly Word[]): DockerExposure | null {
  const program = baseName(words[0]?.text ?? "");
  if (program === "docker-compose") return composeExposure(words.slice(1));
  if (program !== "docker") return null;
  const first = firstOperand(words.slice(1), DOCKER_VALUE_OPTIONS);
  if (first === null) return null;
  if (first.text === "exec") return execExposes(first.rest) ? "exec" : null;
  if (first.text === "inspect") {
    return inspectExposes(first.rest) ? "inspect" : null;
  }
  if (first.text === "compose") return composeExposure(first.rest);
  if (first.text === "container") {
    const sub = firstOperand(first.rest);
    if (sub?.text === "exec") return execExposes(sub.rest) ? "exec" : null;
    if (sub?.text === "inspect") {
      return inspectExposes(sub.rest) ? "inspect" : null;
    }
  }
  return null;
}
