// `scripts/test-db-session.ts`のテストが、本物のpsqlの代わりに起動する偽のpsql。
// 標準入力から、文と、区切りの印を出す行の組を読み、文の中の`/*FAKE{...}*/`の指示どおりに応答する。
// 指示の無い文には、何も出力せず、印だけを返す。
//
// 引数: [--csv] [--pid <値>] [--started <値>] [--log <ファイル>]

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const csv = args.includes("--csv");

function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value ?? fallback;
}

const pid = option("--pid", "4242");
const started = option("--started", "2026-11-08 12:00:00.123456+00");
const logPath = option("--log", "");

function log(line: string): void {
  if (logPath !== "") appendFileSync(logPath, `${line}\n`);
}

type Directive = {
  readonly out?: string | undefined;
  readonly csvOut?: string | undefined;
  readonly splitOut?: string | undefined;
  readonly err?: string | undefined;
  readonly notice?: string | undefined;
  readonly sleepMs?: number | undefined;
  readonly unclean?: boolean | undefined;
  readonly hang?: boolean | undefined;
  readonly exitCode?: number | undefined;
  readonly reportPending?: boolean | undefined;
  readonly topLevelOnly?: boolean | undefined;
  readonly tag?: string | undefined;
};

function parseDirective(statement: string): Directive {
  const found = /\/\*FAKE(\{.*?\})\*\//s.exec(statement);
  if (found === null || found[1] === undefined) return {};
  const parsed: unknown = JSON.parse(found[1]);
  if (typeof parsed !== "object" || parsed === null) return {};
  const read = (key: string): unknown =>
    Object.entries(parsed).find(([k]) => k === key)?.[1];
  const text = (key: string): string | undefined => {
    const value = read(key);
    return typeof value === "string" ? value : undefined;
  };
  const num = (key: string): number | undefined => {
    const value = read(key);
    return typeof value === "number" ? value : undefined;
  };
  const flag = (key: string): boolean => read(key) === true;
  return {
    out: text("out"),
    csvOut: text("csvOut"),
    splitOut: text("splitOut"),
    err: text("err"),
    notice: text("notice"),
    sleepMs: num("sleepMs"),
    unclean: flag("unclean"),
    hang: flag("hang"),
    exitCode: num("exitCode"),
    reportPending: flag("reportPending"),
    topLevelOnly: flag("topLevelOnly"),
    tag: text("tag"),
  };
}

type Call = { readonly statement: string; readonly mark: string };

const queue: Call[] = [];
let wake: (() => void) | null = null;
let ended = false;
let handled = 0;

async function writeOut(text: string | Uint8Array): Promise<void> {
  await Bun.write(Bun.stdout, text);
}

async function writeErr(text: string): Promise<void> {
  await Bun.write(Bun.stderr, text);
}

async function handle(call: Call): Promise<void> {
  const { statement, mark } = call;
  const startup = statement.includes("pg_stat_activity");
  const directive = startup ? {} : parseDirective(statement);
  if (!startup) {
    handled += 1;
    log(`start ${directive.tag ?? ""}`);
  }
  if (directive.sleepMs !== undefined) await Bun.sleep(directive.sleepMs);
  if (directive.hang === true) await new Promise<void>(() => {});
  if (directive.exitCode !== undefined) {
    log(`exit ${String(directive.exitCode)}`);
    process.exit(directive.exitCode);
  }
  if (directive.err !== undefined) {
    log(`end ${directive.tag ?? ""}`);
    await writeErr(directive.err);
    process.exit(3);
  }
  if (directive.topLevelOnly === true && !csv) {
    log(`end ${directive.tag ?? ""}`);
    await writeErr(
      "ERROR:  WITH clause containing a data-modifying statement must be at the top level\n",
    );
    process.exit(3);
  }
  if (directive.notice !== undefined) await writeErr(`${directive.notice}\n`);
  if (startup) {
    await writeOut(`${csv ? "tdb_backend\n" : ""}${pid} ${started}\n`);
  } else if (directive.splitOut !== undefined) {
    for (const byte of new TextEncoder().encode(directive.splitOut)) {
      await writeOut(new Uint8Array([byte]));
      await Bun.sleep(3);
    }
    await writeOut("\n");
  } else if (csv && directive.csvOut !== undefined) {
    await writeOut(`${directive.csvOut}\n`);
  } else if (directive.out !== undefined) {
    await writeOut(`${directive.out}\n`);
  } else if (directive.reportPending === true) {
    await writeOut(`[{"pending": ${String(queue.length)}}]\n`);
  } else if (directive.tag !== undefined) {
    await writeOut(
      `[{"tag": ${JSON.stringify(directive.tag)}, "seq": ${String(handled)}}]\n`,
    );
  }
  if (!startup) log(`end ${directive.tag ?? ""}`);
  await writeOut(`${mark} ${directive.unclean === true ? "f" : "t"}\n`);
  await writeErr(`${mark}\n`);
}

async function worker(): Promise<void> {
  for (;;) {
    const call = queue.shift();
    if (call !== undefined) {
      await handle(call);
    } else if (ended) {
      log("eof");
      process.exit(0);
    } else {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
}

function notify(): void {
  const resolve = wake;
  wake = null;
  resolve?.();
}

async function reader(): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  let lines: string[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true });
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      const finish = /^\\warn ([0-9a-f]+)$/.exec(line);
      if (finish !== null && finish[1] !== undefined) {
        // 末尾の4行(`;`、`\gset`の文、`\echo`、`\warn`)の手前までが、文である。
        queue.push({
          statement: lines.slice(0, -4).join("\n"),
          mark: finish[1],
        });
        lines = [];
        notify();
      }
    }
  }
  ended = true;
  notify();
}

await Promise.all([reader(), worker()]);
