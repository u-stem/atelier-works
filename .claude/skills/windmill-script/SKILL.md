---
name: windmill-script
description: 本リポジトリ (atelier-works) で Windmill の script / flow / migration / schedule を追加・変更するときに使う。管理スキルの `write-script-bun` / `write-flow` / `schedules` / `resources` の一般的な作法に、このリポジトリ固有の規約を上乗せする。
---

# Windmill script/flow のリポジトリ固有規約 (windmill-script)

このスキルは、wmill が生成する管理スキル(`write-script-bun`、`write-flow`、`schedules`、`resources` など、`.claude/skills/` に同居している)の一般的な作法を前提に、**このリポジトリ固有のルール**だけを補足する。基本文法・CLI コマンドはそちらを参照する。

## 配置場所

- Windmill 資産(script / flow / resource / variable / schedule)はすべて `f/factory/` 配下に置く(wmill の sync ルートはリポジトリ直下)。
- 共有モジュール(DB・GitHub・Claude 実行・draw.io・Discord などのロジック)は `f/factory/lib/` に置く。**lib の束ね方は未確定**: M4(lib 実装)着手時に `wmill sync push --dry-run` で挙動を確認して決める。既定案は Windmill の相対 import(lib も workspace script として push され、`main` エクスポートは不要)で、script からは相対 import で読み込む(例: `import { runClaude } from "./lib/claude.ts"`)。これが機能しない場合は `wmill.yaml` の `codebases` によるバンドルに切り替える。
- Data Table の migration は `migrations/datatable/main/` 配下(`wmill datatable migrate new <name>` が生成する形式に従う)。

## `//native` は使わない

- このリポジトリの script は `child_process` や `fs` を使って `git` / `gh` / `claude` / `wmill` をサブプロセス起動するため、native runtime(`//native` 指定)は使わない。
- 管理スキルが native を推奨していても、このリポジトリでは通常の bun runtime を使う(先頭に `//native` を書かない)。
- `windmill_worker_native` コンテナは App の軽量 runnable など別用途のために残っているだけで、factory の script はそこでは動かさない前提で書く。

## シークレットの扱い

- シークレットは `f/factory/*.variable.yaml`(`claude_oauth_token` / `github_token` / `wmill_token` / `discord_webhook_url`)として定義し、`is_secret: true`。値はコミットしない(リポジトリ内では空のまま)。
- script からは `wmill.getVariable("f/factory/github_token")` のように取得し、**子プロセスの環境変数**(例: `GH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`)としてのみ渡す。
- シークレットをコマンドライン引数・URL・ログ出力・DB のカラムに絶対に書かない。エラーメッセージに含めそうな箇所は事前にマスクする(`f/factory/lib/log.ts` のマスク関数を通す)。

## 設定の取得

- 可変だが秘密ではない設定は resource `f/factory/factory_config`(resource type `c_factory_config`)から取得する。
- 型は `wmill generate-metadata` / `wmill resource-type generate-namespace` が生成する `rt.d.ts` の `RT.CFactoryConfig` を使う。`rt.d.ts` は tsconfig の `include` に入るアンビエント型定義ファイルで、`RT` はグローバル名前空間として提供される。**import 文は不要**(managed skill `write-script-bun` の「Resource Types」節と同じ扱い)。

```ts
import * as wmill from "windmill-client";

export async function main() {
  const config: RT.CFactoryConfig = await wmill.getResource("f/factory/factory_config");
  // config.owners, config.trigger_label, config.max_attempts などを使う
}
```

`windmill-client` の型引数対応状況によっては `getResource<RT.CFactoryConfig>(...)` の形も使えるが、いずれの書き方でも `as` によるキャストはしない(戻り値への型注釈、または型ガードでの検証で受け取る)。resource の中身を推測で決め打ちせず、`rt.d.ts` の型定義を必ず確認してから使う。

## TypeScript の規約

- `strict: true`。`as` によるキャスト(`<T>expr` 形式含む)は禁止(`as const` は許可)。外部由来の JSON(Issue API のレスポンス、Claude の stdout など)は**型ガード関数**でパースしてから使う(parse, don't validate)。
- 例:

```ts
type ClaudeResult = {
  summary: string;
  markdown: string;
  diagrams: { name: string; drawio_xml: string }[];
  open_questions: string[];
};

function isClaudeResult(value: unknown): value is ClaudeResult {
  if (typeof value !== "object" || value === null) return false;
  if (!("summary" in value) || !("markdown" in value)) return false;
  const summary = (value as { summary: unknown }).summary;
  const markdown = (value as { markdown: unknown }).markdown;
  return typeof summary === "string" && typeof markdown === "string";
  // 実装では diagrams / open_questions の要素も同様に検証する
}
```

型ガード関数の内部でオブジェクトの形を確認するために絞り込む箇所は許容されるが、`lint-no-type-assertions` のチェック対象になる。判定ロジック自体は `typeof` / `in` / 配列チェックなどで組み立てる。

## TDD

- `f/factory/lib/**` は `bun test` で TDD する(Red → Green → Refactor)。
- 外部プロセス起動(`child_process.spawn` など)や `fetch` は関数の引数として注入し、テストではダミー実装に差し替える。実プロセス・実 HTTP を叩くテストを書かない。
- 1 テスト 1 アサーション、Arrange-Act-Assert の構成にする。

## メタデータとデプロイ

- script の import / 引数(`main` のシグネチャ)を変更すると `.script.yaml` / lock 情報の更新が必要になることがある。**ask first**: `wmill generate-metadata` は実行前に必ず確認を取り、実行後は lock 情報のバージョン変化(差分)を報告する(AGENTS.md の Metadata 規約に従う)。
- デプロイは `mise run push`(内部で `wmill sync push --yes --keep-deleted`)。`--keep-deleted` により、UI 上で作成途中の App などリポジトリに未反映のリモート項目を誤って消さない。
- **リモートの項目を自動削除しない**。削除が必要な場合は人手で個別に判断して行う(通常の `push` タスクに削除は含めない)。

## スケジュール一覧

`timezone: Asia/Tokyo`、cron は Windmill の 6 フィールド形式。worker は単一の default グループで動くため、`tag` は基本的に指定しない。

| スケジュール | 間隔 | 用途 |
| --- | --- | --- |
| `poll_issues` | 5 分毎 | Issue の拾い上げ、claim、reconcile(closed/ラベル剥奪の検出、孤児ジョブの検出)、再投入検出 |
| `self_update` | 10 分毎 | self clone の pull、変更があれば `wmill sync push` と migration の適用 |
| `cleanup_workspaces` | 毎日 03:00 | 期限切れ worktree の削除、古い transcript の削除、ディスク使用量の記録 |
| `daily_summary`(`notify_discord` 経由) | 毎日 09:00 | 前日のコスト・件数・失敗を Discord に通知 |

- 各 schedule の script は冒頭で `pg_try_advisory_lock` を取り、多重実行を防ぐ。
- schedule には error handler を設定し、失敗を `job_failures` テーブルと Discord 通知に流す。
- 承認のタイムアウト(7 日)は schedule ではなく `pipeline.flow` の suspend 設定側で持つ。
