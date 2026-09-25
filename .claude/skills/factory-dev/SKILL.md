---
name: factory-dev
description: 本リポジトリ (atelier-works) の開発環境をセットアップし、mise タスクで起動・検証・デプロイするときに使う。実装・レビュー・修正のループを回す際にも参照する。
---

# このリポジトリの開発手順 (factory-dev)

## 前提

- ホストに必要なのは **docker(Desktop または OrbStack)と mise** のみ。それ以外(node, bun, gh, windmill-cli)はすべて `mise install` で入る。JS の依存関係(`bun install --frozen-lockfile` など)は `mise install` の後に `mise run setup` が入れる。
- 初回は `mise trust` を実行してこのリポジトリの `mise.toml` を信頼する。

## 秘密情報の設定

- 秘密ではない設定は `mise.toml` の `[env]` に平文でコミットする。
- 個人の秘密値(`DB_PASSWORD`、`WM_ADMIN_EMAIL`、`WM_ADMIN_PASSWORD`、`GITHUB_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`、`DISCORD_WEBHOOK_URL`)は `.env` を使わず、gitignore 済みの `mise.local.toml` に置く。テンプレートは `mise.local.toml.example`。
- 値の投入は人が行う。推奨コマンド(zsh / bash 共通で動く形。値に `!` などの記号を含んでもシェル履歴展開で失敗せず、平文がシェル履歴に残らない):

  ```sh
  read -rs 'v?DB_PASSWORD: ' && mise set -E local DB_PASSWORD="$v"; unset v
  ```

  bash の場合は次のように書く:

  ```sh
  read -rs -p 'DB_PASSWORD: ' v && mise set -E local DB_PASSWORD="$v"; unset v
  ```

  他のキー(`WM_ADMIN_EMAIL`、`WM_ADMIN_PASSWORD`、`GITHUB_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`、`DISCORD_WEBHOOK_URL`)も同様にキー名を差し替えて実行する。`mise set -E local KEY=value` は `mise.local.toml` に `[env]` テーブルとして書き込まれ、`-E local` を付けずとも以降の `mise run` / `mise exec` に自動反映される(実機確認済み)。
- Claude が担当するのは `mise.local.toml.example`(値の無いテンプレート)の更新までとする。実際の値の投入は人の作業であり、必要になったら作業を止めずに上記の投入コマンドを提示したうえで先に進む。
- 投入した値の存在確認は、値そのものを表示せずに行う: `mise exec -- sh -c 'test -n "$DB_PASSWORD" && echo ok'`
- 注意: `mise set -E local KEY=value` の直書きは、値に記号(`!` など)を含まない場合に限り動くが、平文のままシェル履歴に残るため推奨しない。
- `docker compose` は `.env` を読まない。`mise run` タスク経由で解決された環境変数を参照するため、必ず `mise run` 経由で実行する。

## 資格情報の取得手順

`DB_PASSWORD`、`WM_ADMIN_EMAIL`、`WM_ADMIN_PASSWORD` は自分で決めた値でよい。次の3つは外部サービスから取得する。

### GitHub Personal Access Token(`GITHUB_TOKEN`)

1. GitHub 右上のアイコン → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token** を開く。
2. **Token name**: `atelier-works-factory`(複数インスタンスで運用する場合は `atelier-works-factory-<instance_name>`)
3. **Description**: `Software Factory worker (Issues/PR automation)`
4. **Resource owner**: 対象リポジトリの所有者(個人アカウント or org)を選ぶ。
5. **Expiration**: Custom で 1 年後(最長)を選ぶ。期限切れは `mise run doctor` と `poll_issues` が検出する。
6. **Repository access**: Only select repositories → 拾わせるリポジトリ(sandbox リポジトリを含む)を選ぶ。
7. **Repository permissions** を設定する: Issues = Read and write / Contents = Read and write(`pr_fix` の修正 push に必要)/ Metadata = Read-only(Issues/Contents 選択時に自動付与)/ Pull requests = Read and write。
8. **Account permissions**: すべて No access のままにする。
9. **Generate token** を押し、表示された `github_pat_...` を次のコマンドで投入する(org リポジトリでは org 側の承認が必要な場合がある):

   ```sh
   read -rs 'v?GITHUB_TOKEN: ' && mise set -E local GITHUB_TOKEN="$v"; unset v
   ```

### Claude Code OAuth トークン(`CLAUDE_CODE_OAUTH_TOKEN`)

1. ホストにインストール済みの Claude Code CLI で `claude setup-token` を実行する。
2. 表示されたサブスク長期 OAuth トークンを次のコマンドで投入する:

   ```sh
   read -rs 'v?CLAUDE_CODE_OAUTH_TOKEN: ' && mise set -E local CLAUDE_CODE_OAUTH_TOKEN="$v"; unset v
   ```

### Discord Webhook URL(`DISCORD_WEBHOOK_URL`)

1. 通知先の Discord チャンネルで「チャンネル設定」→「連携サービス」→「ウェブフック」→「新しいウェブフック」を開く。
2. 名前を `Software Factory` に設定する。
3. 「ウェブフック URL をコピー」で URL を取得し、次のコマンドで投入する:

   ```sh
   read -rs 'v?DISCORD_WEBHOOK_URL: ' && mise set -E local DISCORD_WEBHOOK_URL="$v"; unset v
   ```

## セットアップ手順

```bash
mise trust
mise install
mise run setup       # bun install --frozen-lockfile など JS 依存のセットアップ
# 個人の秘密値の投入方法は上の「秘密情報の設定」「資格情報の取得手順」の各節を参照(値を書き込むのは人)
mise run doctor      # 前提(docker / mise / mise.local.toml の必須キー / ポート)を確認
mise run up           # docker compose でスタック起動
mise run bootstrap     # workspace 作成、secret 投入、sync push、migration 適用
```

## mise タスク一覧

| タスク | 内容 |
| --- | --- |
| `mise run setup` | `mise install` の後に JS 依存(`bun install --frozen-lockfile` など)を入れる(骨格側で追加予定) |
| `mise run doctor` | docker / mise の有無、`mise.local.toml` の必須キー、ポートの空き、Windmill の起動状態、worker コンテナ内の `claude`/`gh`/`git gtr` の動作確認を一覧表示する |
| `mise run up` | `docker compose`(`infra/docker-compose.yml`)でスタックを起動(build 込み) |
| `mise run down` | スタックを停止する |
| `mise run bootstrap` | 初回のみ: Windmill の初期パスワード変更、workspace 作成、secret 変数の投入、`wmill sync push`、migration 適用を冪等に行う |
| `mise run check` | `lint` → `typecheck` → `test` を順に実行する(PR 前に必ず通す) |
| `mise run lint` | `biome check` + `wmill lint f` + 型アサーション検出スクリプト |
| `mise run typecheck` | `tsc --noEmit` |
| `mise run test` | `bun test`(`f/factory/lib/**` の単体テスト。テストサイズ small のみ) |
| `mise run test:db` | compose の Postgres を使う SQL スモークテスト(テストサイズ medium。M3 で追加) |
| `mise run push` | `wmill sync push --yes --keep-deleted` でリモートの Windmill にローカルの変更を反映する |
| `mise run push:dry` | `wmill sync push --dry-run` で反映内容を確認するだけ(リモートは変更しない) |
| `mise run pull` | `wmill sync pull` でリモート(App の UI 編集など)をローカルに取り込む |
| `mise run migrate` | `wmill datatable migrate up` で Data Table のマイグレーションを適用する |
| `mise run deploy` | ホスト側 checkout で `git pull --ff-only` → worker image のビルド → `compose up -d` → `wmill sync push` → migration まで一括実行する(`self_update` が「ホスト操作が必要」と通知したときに使う。骨格側で実装予定) |
| `mise run logs` | `docker compose logs` を呼び出す |

## 実装 → レビュー → 修正のループ(概要)

このリポジトリの実装は、計画の確定 → 実装 → レビュー → 修正 → 再レビューのループで進める。

1. 対象ファイルと受入条件を明確にしてから実装に着手する。
2. TDD(Red → Green → Refactor)で実装し、対象範囲外のファイルには触れない。
3. `mise run check` が緑になることを実装完了の条件とする。
4. 正しさ・規約・テスト網羅の観点と、前提の反証・運用時の失敗モードの観点でレビューを受ける。
5. 指摘を技術的に検証してから採否を決め、採用した指摘のみ修正する(不採用は理由を残す)。
6. 新規の指摘が無くなるまで 4〜5 を繰り返す(目安 3 周。超えるようなら設計に立ち返る)。

## コミット規約

- Conventional Commits の type + 日本語の説明: `<type>: <日本語説明>`(`type` は `feat` / `fix` / `docs` / `refactor` / `test` / `chore` のいずれか)。
- 例: `feat: Issue 拾い上げの poll_issues スケジュールを追加`
- コード変更に伴う docs / スキルの更新は同じコミットに含める。

## PR で期待されること

- Summary(何を、なぜ)
- 変更範囲
- 検証結果(lint / typecheck / test / 該当すれば E2E)
- Windmill への反映要否(`sync push` が必要か、migration が必要か、worker image の再ビルドが必要か)

テンプレートは `.github/PULL_REQUEST_TEMPLATE.md` を参照。

## E2E 動作確認

`mise run doctor` → `mise run up` → `mise run bootstrap` のあと、次を確認する。

1. サンドボックス用リポジトリで Issue テンプレートから Issue を作成し、`factory` ラベルを付ける。
2. 5 分以内(`poll_issues` の周期)に Discord 通知が届き、Inbox に表示されることを確認する。
3. 一度 Reject(理由付き)し、要件が再生成されて再度通知が来ることを確認する。
4. Approve し、Issue コメントに要件定義の markdown と図の viewer URL が転記され、ラベルが承認済みラベルへ付け替わることを確認する。
5. Analytics タブにコスト・トークン数が反映されることを確認する。
6. 何かしらの変更を self clone に反映させ、`self_update` スケジュールが最新の SHA を取り込むことを確認する。
