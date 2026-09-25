# 運用

## 運用ルール

- Issue を拾ったインスタンスの所有者が、その Issue の承認を行う。
- 各インスタンスは稼働前に `f/factory/factory_config` の `instance_name` を必ず設定する(Issue コメント・Discord 通知・承認 Inbox の担当表示に使われる)。
- 1つの Issue は1つのインスタンスが占有する。claim(assignee 設定 + `wip` ラベル付与)に成功したインスタンスだけがその Issue を処理し、後から来た他インスタンスは撤退する。

## 日常運用

**現状の注意**: `poll_issues` / `manual_intake` / `pipeline` の実処理フロー、ダッシュボード App、Discord 通知(`notify_discord`)は**未実装**。以下は実装後の想定運用であり、次の開発サイクルで実装する([docs/architecture.md](architecture.md) の拡張点・スコープ表も参照)。

- Issue に `factory` ラベルを付けると拾われる(付与者は OWNER / MEMBER / COLLABORATOR のいずれかである必要がある)。
- 手動フォームからも同じパイプラインに Issue を投入できる想定(`manual_intake` フロー)。
- 承認は Inbox(App)で行う。要件定義ドラフトと図を確認し、Approve または理由付きで Reject する。
- Reject すると要件定義が再生成され(`attempt` が加算される)、再度承認待ちになる。試行回数が上限を超えると `needs_human` になる。
- 失敗した work item は Failures タブから再実行できる想定(`retry_work_item`)。
- 通知の種類: `picked` / `awaiting_approval` / `approved` / `rejected` / `needs_human` / `failed` / `expired` / `cancelled` / `self_update`(ホスト操作が必要)/ `daily_summary`(前日のコスト・件数・失敗)。

## 更新の反映

- 通常の更新は `git pull` してから `mise run deploy` を実行する(ホスト側 checkout で `git pull --ff-only` → worker イメージのビルド → `docker compose up -d` → `wmill sync push` → migration を一括実行する)。
- `wmill sync push` に **`--include-secrets` を付けてはいけない**。付けるとリポジトリ内の `f/factory/*.variable.yaml`(値は空のままコミットされている)で4つの secret 変数(`claude_oauth_token` / `github_token` / `wmill_token` / `discord_webhook_url`)が空に上書きされる。`mise run push`(`wmill sync push --yes --keep-deleted`)は `--include-secrets` を付けない設定になっている。
- `self_update` スケジュール(未実装)が `infra/` や `mise.toml` の変更を検知すると、Discord とダッシュボードの Notices で「`mise run deploy` を実行してください」と通知する想定。
- ダッシュボード App(未実装)を編集する場合の規約: 最新を `mise run pull` で取り込む → Windmill UI で編集する → 再度 `mise run pull` でローカルに反映する → コミットする。同時編集は避ける。

## 秘密のローテーション

1. GitHub PAT / Claude Code OAuth トークンを再発行する(手順は [docs/security.md](security.md) を参照)。
2. 新しい値を `mise set -E local KEY=value`(`read -rs` 経由を推奨)で投入する。
3. `mise run bootstrap` を再実行する。`bootstrap.sh` は冪等なので、既存の Windmill 変数は新しい値で上書き更新される。

## バックアップ

- Windmill のデータ(ワークスペース設定、Data Table、ジョブ履歴など)はすべて `db_data` という Docker volume(Postgres)に入っている。バックアップの対象はこの volume。
- `docker compose -f infra/docker-compose.yml down -v` は `db_data` を含むすべての volume を削除する破壊的操作である([docs/setup.md](setup.md) のトラブルシュートも参照)。

## 未実装の機能

次はまだ実装されていない(基盤 + 工程1→2 の骨組みまでが現在のスコープ)。実装され次第このドキュメントを更新する。

- `poll_issues` / `manual_intake` / `pipeline` フロー(工程2の実処理)
- ダッシュボード App(Inbox / Pipeline / Analytics / Failures / Notices)
- Discord 通知(`notify_discord`)
- `self_update` / `cleanup_workspaces` スケジュール
