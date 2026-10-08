// console_fetcherの入口。引数で動作を選ぶ。
//   loop(既定): 起動直後と、その後5分ごとに取り込む。
//   once: 1回だけ取り込んで終わる。
//   rollback: currentを直前の版に戻してpinを置く(mise run console:rollback)。
//   unpin: pinを外す(mise run console:unpin)。
// ログは1行1つのJSONで標準出力に出す。トークンは出さない。
// どの動作もボリュームのロックを取ってから行い、同時に動かない。
import { parseFetcherConfig } from "./decide.ts";
import {
  type FetchLike,
  type LogFields,
  recordConfigFailure,
  rollback,
  runLoopIteration,
  runOnce,
  unpin,
  withLock,
} from "./fetcher.ts";

const ROOT = "/srv/console";
const INTERVAL_MS = 5 * 60 * 1000;
const BUSY_MESSAGE =
  "console_fetcher is updating the console right now. Try again in a minute.";

const fetchFromNetwork: FetchLike = (url, init) => fetch(url, init);

function now(): Date {
  return new Date();
}

function log(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ ts: now().toISOString(), event, ...fields }));
}

async function once(): Promise<void> {
  const result = await withLock(ROOT, now, async () => {
    const config = parseFetcherConfig({
      CONSOLE_GITHUB_TOKEN: process.env.CONSOLE_GITHUB_TOKEN,
      CONSOLE_GITHUB_REPO: process.env.CONSOLE_GITHUB_REPO,
    });
    if (config === null) {
      // 設定が無くても止まらずに状態を書き、投入後の`mise run up`を待つ。
      await recordConfigFailure(ROOT, now, log);
      return;
    }
    await runOnce({ fetch: fetchFromNetwork, now, root: ROOT, config, log });
  });
  if (!result.acquired) log("skipped", { reason: "locked" });
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "loop";
  if (command === "once") {
    await once();
    return;
  }
  if (command === "loop") {
    for (;;) {
      // 1回分が失敗しても止まらず、ログを1行出して次の回で取り直す。
      await runLoopIteration(once, log);
      await Bun.sleep(INTERVAL_MS);
    }
  }
  if (command === "rollback") {
    const locked = await withLock(ROOT, now, () => rollback(ROOT, now));
    if (!locked.acquired) {
      console.error(BUSY_MESSAGE);
      process.exit(1);
    }
    if (!locked.value.ok) {
      console.error("No previous release to roll back to.");
      process.exit(1);
    }
    console.log(
      `Rolled back to ${locked.value.sha} and pinned it. Run "mise run console:unpin" to resume automatic updates.`,
    );
    return;
  }
  if (command === "unpin") {
    const locked = await withLock(ROOT, now, () => unpin(ROOT));
    if (!locked.acquired) {
      console.error(BUSY_MESSAGE);
      process.exit(1);
    }
    console.log(
      "Unpinned. console_fetcher resumes automatic updates within 5 minutes.",
    );
    return;
  }
  console.error(
    `Unknown command: ${command} (expected loop, once, rollback, or unpin)`,
  );
  process.exit(2);
}

await main();
