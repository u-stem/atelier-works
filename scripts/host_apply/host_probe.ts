/**
 * ホストの照会。プロセスの開始時刻とブートセッションを、`ps`と`sysctl`から読む。
 * 指定の形は`issueSpec`が固定の形に限る。ここは指定を作り、出力を検査して値にする。
 */

import {
  type CommandResult,
  type CommandRunner,
  HOST_PROBE_ENV,
  type IssuedSpec,
  issueSpec,
} from "./command.ts";
import { COMMAND_TIMEOUT_MS } from "./constants.ts";
import { PS_BIN, SYSCTL_BIN } from "./exec_paths.ts";

/** プロセスIDの上限。`issueSpec`の検査と同じ値。 */
const MAX_PID = 2 ** 22;

const MONTHS: readonly string[] = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `ps -o lstart=`の出力。日が1桁のときは先頭が空白で埋まる。 */
const LSTART =
  /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) ([ 1-3]?\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

const UUID = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

function probeSpec(bin: string, args: readonly string[]): IssuedSpec {
  return issueSpec({
    kind: "host_probe",
    bin,
    args,
    env: HOST_PROBE_ENV,
    cwd: "/",
    timeoutMs: COMMAND_TIMEOUT_MS.host_probe,
  });
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * `ps`の出力をISO 8601のUTCに直す。欄ごとに分けて検査し、`Date.UTC`で組み立てる。
 * 暦に無い日付、範囲外の時刻、1970年より前の年は`null`にする。
 */
function parseStart(text: string): string | null {
  const match = LSTART.exec(text);
  if (match === null) return null;
  const month = MONTHS.indexOf(match[1] ?? "");
  const [day, hour, minute, second, year] = [
    Number((match[2] ?? "").trim()),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ];
  if (month < 0 || year < 1970 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${pad(year, 4)}-${pad(month + 1, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}Z`;
}

function requireDone(
  result: CommandResult,
  name: string,
): Extract<CommandResult, { kind: "done" }> {
  if (result.kind !== "done" || result.stdoutDropped) {
    throw new Error(`${name} output is not usable`);
  }
  return result;
}

/**
 * プロセスの開始時刻を、ISO 8601のUTC(秒の解像度)で返す。プロセスが無いときは`null`。
 * 取れないときは、起動の失敗も出力の食い違いも例外にする。呼び出し側は、取れなければ止まる。
 */
export async function processStart(
  run: CommandRunner,
  pid: number,
): Promise<string | null> {
  if (!Number.isInteger(pid) || pid < 1 || pid > MAX_PID) {
    throw new Error(`pid must be an integer from 1 to ${MAX_PID}`);
  }
  const result = requireDone(
    await run(probeSpec(PS_BIN, ["-o", "lstart=", "-p", String(pid)])),
    "ps",
  );
  const text = result.stdout.trimEnd();
  if (result.code === 1 && text === "") return null;
  if (result.code !== 0) throw new Error("ps failed");
  const start = parseStart(text);
  if (start === null) throw new Error("ps output is not a start time");
  return start;
}

/** ブートセッションのUUIDを、小文字で返す。再起動を跨いだプロセスIDの再利用を見分けるために使う。 */
export async function bootId(run: CommandRunner): Promise<string> {
  const result = requireDone(
    await run(probeSpec(SYSCTL_BIN, ["-n", "kern.bootsessionuuid"])),
    "sysctl",
  );
  if (result.code !== 0) throw new Error("sysctl failed");
  const text = result.stdout.trimEnd();
  if (!UUID.test(text)) throw new Error("sysctl output is not a uuid");
  return text.toLowerCase();
}
