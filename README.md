# atelier-works — Software Factory

GitHub Issueを起点に、要件定義 → 実装 → PR → CI監視 → マージ後監視 → 自己改善までを
Windmill上のフローとして自動化する「Software Factory」。このリポジトリを`clone`して
手順どおりに実行するだけで完結し、グローバル設定や別リポジトリへの依存を持たない。

## 概要

工程は次の5段階。

1. **拾う**: `factory`ラベル付きIssueを検知してclaimする
2. **要件定義**: headless Claudeが要件定義ドラフトを生成し、人が承認・差し戻しする
3. **実装**: worktree上で実装しPRを作成する
4. **CI監視**: マージ後のCIを監視する
5. **自己改善**: 失敗や却下の履歴から改善提案をIssue化する

**現在のスコープ**: 基盤(docker composeによるWindmillスタック、claude/gh/gtr/wmillを
同梱したworkerイメージ、Data Table、`doctor` / `bootstrap`)、工程1の自動巡回(`poll_issues` / `poll_prs`)、
工程2の要件定義と承認、PRワークフロー(工程3の一部: `pr_review` / `pr_fix`)、
ダッシュボードApp(Factory Console)、自己更新と失敗ハンドラ。
未実装は工程3の「Issueから実装してPRを作る」、工程4のマージ後CI監視、工程5の自己改善提案、
Discordの双方向操作(詳細は[docs/architecture.md](docs/architecture.md)と[docs/operations.md](docs/operations.md)を参照)。

## 10分で動かす

前提: ホストに**docker**(DesktopまたはOrbStack)と**mise**のみ。

```bash
git clone <このリポジトリの URL> atelier-works
cd atelier-works
mise trust
mise run setup
```

秘密値を投入する。キー一覧と取得手順は`mise.local.toml.example`を参照。投入には、
値をシェル履歴に残さない`read -rs`経由を推奨する。

```bash
read -rs 'v?DB_PASSWORD: ' && mise set -E local DB_PASSWORD="$v"; unset v
# 他のキー(WM_ADMIN_EMAIL, WM_ADMIN_PASSWORD, GITHUB_TOKEN,
# CLAUDE_CODE_OAUTH_TOKEN, DISCORD_WEBHOOK_URL, CONSOLE_GITHUB_TOKEN)も同様に投入する
```

```bash
mise run doctor
mise run up
mise run bootstrap
```

ブラウザで <http://127.0.0.1:8080> を開き、`admin@windmill.dev`と設定した
`WM_ADMIN_PASSWORD`でログインする。Windmill UIで`f/factory/factory_config`を開き、
`owners`(対象リポジトリの所有者)と`instance_name`を設定する。この2項目はgit管理外で、
`bootstrap`実行時点では空のまま作成される。

詳しい手順・動作確認・トラブルシュートは[docs/setup.md](docs/setup.md)を参照。

## 主要miseタスク

| タスク | 内容 |
| --- | --- |
| `mise run setup` | mise管理ツールの導入 + `bun install --frozen-lockfile` + `bun install --cwd console --frozen-lockfile --ignore-scripts` + `lefthook install` |
| `mise run doctor` | 環境診断(OK / NG一覧) |
| `mise run up` | ローカルWindmillスタックを起動(build込み)。ホスト側checkoutからビルドするため、先にmainをpullする |
| `mise run down` | スタックを停止する |
| `mise run build` | workerイメージのみビルドする |
| `mise run bootstrap` | 初回セットアップ(ワークスペース作成・secret投入・sync push・migration、冪等) |
| `mise run deploy` | `git pull --ff-only` → build → up → push → migrateを一括実行する(手動で一括反映したいときの手段) |
| `mise run check` | `lint` → `typecheck` → `test` → `console:check`を順に実行する |
| `mise run console:check` | Console(`console/`)の型検査・テスト・組み立て |
| `mise run lint` | biome + `wmill lint` + 型アサーション検出 |
| `mise run typecheck` | `tsc --noEmit` |
| `mise run test` | `bun test`(small)。`console/`は除く(Consoleのテストは`mise run console:check`で実行する) |
| `mise run test:db` | Data Table migrationのSQLスモークテスト(medium) |
| `mise run push` | `wmill sync push --yes --keep-deleted` |
| `mise run push:dry` | `wmill sync push --dry-run`(変更しない) |
| `mise run push:prune` | 削除も反映するpush(手動のみ) |
| `mise run pull` | `wmill sync pull` |
| `mise run migrate` | `wmill datatable migrate up` |
| `mise run logs` | スタックのログを追跡する |
| `mise run console:rollback` | Consoleを直前の版に戻して固定する(自動の更新を止める) |
| `mise run console:unpin` | Consoleの固定を外し、自動の更新に戻す |

## リポジトリ構成

```
atelier-works/
  README.md                        # このファイル
  AGENTS.md / CLAUDE.md             # エージェント向け規約(単一ソースは AGENTS.md)
  mise.toml                        # ツール管理・タスク定義
  mise.local.toml.example          # 秘密値投入のテンプレート(値は自分で入れる)
  wmill.yaml                       # `wmill sync` の設定
  lefthook.yml                     # pre-commit / commit-msg / pre-push フック
  console/                         # Factory Console(Vite + React)。CI が組み立て、console_fetcher が取り込む
  c_factory_config.resource-type.yaml / rt.d.ts   # factory_config の resource type と生成された型
  .claude/skills/                  # Claude Code のカスタムスキル + wmill が生成した管理スキル
  .agents/skills/                  # wmill が生成した共有エージェントスキル(Codex 等と共有)
  docs/                            # ドキュメント
  f/factory/                       # Windmill の script / flow / resource / variable / schedule
  infra/                           # docker compose、worker Dockerfile、console_fetcher、Caddyfile
  migrations/datatable/main/       # Data Table のマイグレーション
  scripts/                         # doctor.sh / bootstrap.sh / test-db.sh などの運用スクリプト
  templates/                       # factory_config resource のシードテンプレート(git 管理外の初期値)
  tests/                           # bun test
```

## ドキュメント

- [セットアップ](docs/setup.md): 前提、資格情報の取得、起動、動作確認、トラブルシュート
- [運用](docs/operations.md): 運用ルール、日常運用、更新の反映、秘密のローテーション、バックアップ
- [アーキテクチャ](docs/architecture.md): 全体構成、状態遷移、データモデル、フロー、拡張点
- [セキュリティ](docs/security.md): 信頼境界、シークレット取り扱い、資格情報の作成手順
- [コーディング規約](docs/coding-guidelines.md): 言語規約、TypeScript、TDD、テストの分類
