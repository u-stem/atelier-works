# 運用

## 運用ルール

- Issue を拾ったインスタンスの所有者が、その Issue の承認を行う。
- 各インスタンスは稼働前に `f/factory/factory_config` の `instance_name` を必ず設定する(Issue コメント・Discord 通知・承認 Inbox の担当表示に使われる)。
- 1つの Issue は1つのインスタンスが占有する。claim(assignee 設定 + `wip` ラベル付与)に成功したインスタンスだけがその Issue を処理し、後から来た他インスタンスは撤退する。
- 処理が終端 status(承認済み・要対応・タイムアウト・失敗・レビュー済み・再レビュー依頼・ブロック・キャンセル)になると、`wip` ラベルとトリガーラベル(`factory` / `factory:review` / `factory:fix`)は自動で外れる(承認済みは `factory:approved` に付け替わる)。**もう一度処理させたい場合は、人が改めてラベルを付け直す**(ラベルを残したままにしない設計により、孤児失敗した Issue / PR が自動で無限に再試行されることを防いでいる)。

## 日常運用

**現状の注意**: `poll_issues` / `manual_intake` / `pipeline` の実処理フロー、ダッシュボード App、Discord 通知(`notify_discord`)は**未実装**。以下は実装後の想定運用であり、次の開発サイクルで実装する([docs/architecture.md](architecture.md) の拡張点・スコープ表も参照)。

- Issue に `factory` ラベルを付けると拾われる(付与者は OWNER / MEMBER / COLLABORATOR のいずれかである必要がある)。
- 手動フォームからも同じパイプラインに Issue を投入できる想定(`manual_intake` フロー)。
- **承認は Inbox App(`factory_console`)からのみ行う** (実装予定 M8)。それまで暫定手順: Windmill UI で `f/factory/approval_decide` を開き、Issue コメント記載の `work_item_id` / `decision`(approve / reject) / `reason` / `note` を入力して Run する。承認者は実行ユーザー(`WM_USERNAME`)として記録される。Windmill の approval page URL から直接 resume しない(approval がスキップされて `needs_human` に落ちる)。
- Reject すると要件定義が再生成され(`attempt` が加算される)、再度承認待ちになる。試行回数が上限を超えると `needs_human` になる。
- 失敗した work item は Failures タブから再実行できる想定(`retry_work_item`)。再実行時は `wip` ラベルと該当するトリガーラベル(`factory` / `factory:review` / `factory:fix`)を再付与して再起動する。
- 通知の種類: `picked` / `awaiting_approval` / `approved` / `rejected` / `needs_human` / `failed` / `expired` / `cancelled` / `self_update`(ホスト操作が必要)/ `daily_summary`(前日のコスト・件数・失敗)。

## PR の使い方(pr_review / pr_fix)

**現状の注意**: `pr_review` / `pr_fix` フローも実装済み(M6 工程)。以下は実装後の運用。

- **起動条件**: PR に `factory:review` ラベルを付ける、または PR のレビュー依頼・assignee がこのインスタンスのアカウント(未処理の commit がある場合)で起動。コメント投稿者・レビュー者の `author_association` が `allowed_labeler_associations` に含まれることを確認してから起動する。
- **PR レビュー(`pr_review`)**: 指摘が GitHub の COMMENT として投稿される。完了状態は `reviewed`。
- **PR 修正(`pr_fix`)**: PR に `factory:fix` ラベルを付ける、または PR に `/factory fix` とコメントすると実行される。レビュー指摘・未解決コメントの修正を行い、各コメントへ返信して再レビューを依頼(`rereview_requested`)。要件変更が必要な場合は修正を中断し、元の Issue を requirements_generating に attempt+1 で再起動(`requirements_gap` → 親 Issue)。
- `factory:pr` ラベルは factory 自身が作成した PR の目印(将来の工程3で使用)。このリポジトリ自身の基盤整備 PR(foundation PR)には `factory:review` / `factory:fix` / `factory:pr` のいずれも付けない。
- 対象は `factory_config` の `repo_allowlist`(未指定なら `owners` に含まれるリポジトリ全体)に含まれるリポジトリのみ。試験的に対象を絞りたい場合は `repo_allowlist` に対象リポジトリを明示する。
- 終端状態: `reviewed` / `rereview_requested` / `blocked` / `needs_human`。終端状態になると `wip` ラベルとトリガーラベル(`factory:review` / `factory:fix`)は自動で外れる。
- **pr_fix の再実行**: `retry_work_item` で pr_fix 行を再実行しても処理済み watermark(`last_review_id` / `last_comment_id`)が進んでいるため feedback が取り込まれず `needs_human` に落ちる。pr_fix をやり直すときは PR に新しい `/factory fix` コメント(または新しいレビュー)を投げて次の round を起動する。`retry_work_item` は Issue kind と、`pr_fix_prepare` のガードで止まった(`blocked`)PR 行の再実行に使う。

## 更新の反映

- 通常の更新は `git pull` してから `mise run deploy` を実行する(ホスト側 checkout で `git pull --ff-only` → worker イメージのビルド → `docker compose up -d` → `wmill sync push` → migration を一括実行する)。
- worker の並列数(`NUM_WORKERS`)のような `infra/docker-compose.yml` の変更は、通常の `git pull` だけでは反映されない。`mise run deploy` を実行して worker イメージの再ビルドとコンテナの再起動まで行う。
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
