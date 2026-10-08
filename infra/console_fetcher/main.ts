// console_fetcherの入口。引数で動作を選ぶ。
//   loop(既定): 起動直後と、その後5分ごとに取り込む。
//   once: 1回だけ取り込んで終わる。
//   rollback: currentを中身の違う直前の版に戻してpinを置き、戻した元の版を消す(mise run console:rollback)。
//   unpin: pinを外す(mise run console:unpin)。戻した元の版が再び配信されうるときは外さない。
//          `--force`は最新の実行の確認を、`--ignore-cleanup`は削除の確認を飛ばす。
// ログは1行1つのJSONで標準出力に出す。トークンは出さない。
// どの動作もボリュームのロックを取ってから行い、同時に動かない。
import {
  describeRollbackNotice,
  describeUnpinRefusal,
  parseFetcherConfig,
  parseUnpinFlags,
} from "./decide.ts";
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
    const locked = await withLock(ROOT, now, () => rollback(ROOT, now, log));
    if (!locked.acquired) {
      console.error(BUSY_MESSAGE);
      process.exit(1);
    }
    if (!locked.value.ok) {
      console.error(
        "No previous release with different content to roll back to.",
      );
      process.exit(1);
    }
    console.log(
      `Rolled back to ${locked.value.sha} and pinned it. Run "mise run console:unpin" to resume automatic updates.`,
    );
    const notice = describeRollbackNotice(locked.value.cleanup);
    if (notice !== null) console.log(notice);
    return;
  }
  if (command === "unpin") {
    const options = parseUnpinFlags(process.argv.slice(3));
    if (options === null) {
      console.error(
        `Unknown option: ${process.argv.slice(3).join(" ")} (expected --force or --ignore-cleanup)`,
      );
      process.exit(2);
    }
    const config = parseFetcherConfig({
      CONSOLE_GITHUB_TOKEN: process.env.CONSOLE_GITHUB_TOKEN,
      CONSOLE_GITHUB_REPO: process.env.CONSOLE_GITHUB_REPO,
    });
    const locked = await withLock(ROOT, now, () =>
      unpin({ fetch: fetchFromNetwork, now, root: ROOT, config, log }, options),
    );
    if (!locked.acquired) {
      console.error(BUSY_MESSAGE);
      process.exit(1);
    }
    const result = locked.value;
    if (!result.ok) {
      console.error(describeUnpinRefusal(result));
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
