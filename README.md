# atelier-works

GitHubのIssueを起点に、要件定義、実装、PR、マージ後の監視、自己改善までをWindmillのフローとして自動化するSoftware Factoryである。このリポジトリをcloneして手順どおりに実行すれば動き、グローバルの設定やほかのリポジトリには依存しない。初めて来た人は、この文書の後に[セットアップ](docs/setup.md)を読む。

## 工程

Factoryは次の5つの工程で動く。

| 工程 | 内容 | 状態 |
| --- | --- | --- |
| 1. 拾う | `factory`ラベルの付いたIssueと、`factory:review`・`factory:fix`ラベルの付いたPRを定期的に探し、取り込む | 実装済み |
| 2. 要件定義 | headless Claudeが要件定義のドラフトを書き、人が承認するか差し戻す | 実装済み |
| 3. 実装とPR | 承認された要件定義からworktreeで実装してPRを作り、PRのレビューと修正を回す | 実装済み。Issueからの実装は`implement_enabled`で有効にする |
| 4. マージ後の監視 | マージ後のCIを監視する | 未実装 |
| 5. 自己改善 | 運用の記録を監査し、改善の提案をIssueにする | 実装済み |

工程のほかに、次のものが動く。

- Docker Composeで動くWindmillのスタックと、claude・gh・gitleaks・gtr・wmillを入れたworkerのイメージ
- Data Table、`doctor`、`bootstrap`
- ダッシュボードのApp(Factory Console)
- 自己更新と、失敗したジョブの通知

Discordからの双方向の操作は未実装である。Discordには通知だけを送る。

## 10分で動かす

ホストに要るのは、Docker(Docker DesktopかOrbStack)とmiseだけである。

1. cloneしてツールを入れる。

   ```bash
   git clone <このリポジトリのURL> atelier-works
   cd atelier-works
   mise trust
   mise run setup
   ```

2. 秘密値を投入する。キーと取得の手順は[セットアップ](docs/setup.md)の「資格情報を用意する」にある。zshでは次のようにキーごとに実行する。bashのコマンドは[セットアップ](docs/setup.md)の「秘密値を投入する」にある。

   ```bash
   read -rs 'v?DB_PASSWORD: ' && mise set -E local DB_PASSWORD="$v"; unset v
   ```

3. 診断して起動する。

   ```bash
   mise run doctor
   mise run up
   mise run bootstrap
   ```

4. ブラウザで`http://127.0.0.1:8080`を開き、`admin@windmill.dev`と`WM_ADMIN_PASSWORD`の値でログインする。
5. Windmillの画面で`f/factory/factory_config`を開き、`owners`(対象リポジトリの所有者)と`instance_name`を設定する。この2つはgitで管理せず、`bootstrap`は空のまま作る。

動作の確かめ方とトラブルシュートは[セットアップ](docs/setup.md)にある。

## miseタスク

| タスク | 内容 |
| --- | --- |
| `mise run setup` | miseで管理するツール、`bun install --frozen-lockfile --ignore-scripts`、`bun install --cwd console --frozen-lockfile --ignore-scripts`、`lefthook install`をまとめて入れる |
| `mise run doctor` | 環境を診断し、項目ごとにOKかNGを出す |
| `mise run up` | ローカルのWindmillのスタックを、ビルドしてから起動する。ホストのcheckoutからビルドするので、先にmainをpullする |
| `mise run down` | スタックを止める |
| `mise run build` | workerのイメージだけをビルドする |
| `mise run logs` | スタックのログを追う |
| `mise run console:rollback` | Consoleを直前の版に戻して固定する(自動の更新を止める) |
| `mise run console:unpin` | Consoleの固定を外し、自動の更新に戻す |
| `mise run bootstrap` | ワークスペースの作成、secret変数の投入、sync push、migrationを行う。何度実行してもよい |
| `mise run deploy` | `git pull --ff-only`、ビルド、起動、push、migrationを続けて実行する。手で一括して反映したいときに使う |
| `mise run push` | `wmill sync push --yes --keep-deleted`で、ローカルの変更をWindmillに反映する |
| `mise run push:dry` | `wmill sync push --dry-run`で、反映する内容だけを確かめる |
| `mise run push:prune` | ローカルに無いものをWindmillから消すpush。人が明示的に実行する |
| `mise run pull` | `wmill sync pull`で、Windmillの状態をローカルに取り込む |
| `mise run migrate` | `wmill datatable migrate up`で、Data Tableのmigrationを適用する |
| `mise run metadata` | 古くなったWindmillのメタデータ(lockとスキーマ)を作り直す |
| `mise run metadata:check` | Windmillのメタデータが古ければ失敗する |
| `mise run check` | `lint`、`lint:docs`、`typecheck`、`test`、`console:check`を順に実行する |
| `mise run console:check` | Console(`console/`)のlockfileの方針を検査し、続けて型検査、テスト、組み立てを行う |
| `mise run lint` | biome、`wmill lint`、型アサーションと`§`の検出を実行する |
| `mise run lint:docs` | Markdownの文書を検査する |
| `mise run docs:gen` | 文書の中の生成した範囲を作り直す |
| `mise run typecheck` | `tsc --noEmit`で型を検査する |
| `mise run test` | `bun test`でsmallのテストを実行する。`console/`は除き、Consoleのテストは`mise run console:check`で実行する |
| `mise run test:db` | Data Tableのmigrationを使い捨てのDBに適用し、すべてのviewをSELECTする(medium) |
| `mise run check:comment-only` | 基準のref(既定は`main`)との差分が、コメントの変更だけであることを確かめる |

## リポジトリの構成

```text
atelier-works/
  README.md                        # この文書
  AGENTS.md / CLAUDE.md            # エージェント向けの指示(本体はAGENTS.md)
  mise.toml                        # ツールの管理とタスクの定義
  mise.local.toml.example          # 秘密値のテンプレート(値は人が入れる)
  wmill.yaml                       # wmill syncの設定
  lefthook.yml                     # pre-commit、commit-msg、pre-pushのフック
  console/                         # Factory Console(Vite + React)。CIが組み立て、console_fetcherが取り込む
  c_factory_config.resource-type.yaml / rt.d.ts   # factory_configのresource typeと生成した型
  .claude/agents/                  # Claude Codeのsubagentの定義
  .claude/skills/                  # Claude Codeの自作スキルと、wmillが生成した管理スキル
  .agents/skills/                  # wmillが生成した共有のエージェントスキル
  .github/                         # CI、Issueのテンプレート、PRのテンプレート
  docs/                            # 文書
  f/factory/                       # Windmillのscript、flow、resource、variable、schedule
  infra/                           # Docker Compose、workerのDockerfile、console_fetcher、Caddyfile
  migrations/datatable/main/       # Data Tableのmigration
  scripts/                         # doctor.sh、bootstrap.sh、test-db.sh、check-caddy-origin.sh、検査のスクリプト、Claude Codeのフック
  templates/                       # factory_configの初期値のテンプレート
  tests/                           # bun testのテスト
```

## 文書

| 文書 | 内容 |
| --- | --- |
| [セットアップ](docs/setup.md) | 前提、秘密値の投入、起動、動作の確認、トラブルシュート |
| [運用](docs/operations.md) | 日常の運用、更新の反映、秘密値のローテーション、バックアップ |
| [アーキテクチャ](docs/architecture.md) | 全体の構成、状態の遷移、データモデル、フロー |
| [セキュリティ](docs/security.md) | 信頼境界、秘密値の扱い、資格情報の取得手順、各フローの安全策 |
| [コーディング規約](docs/coding-guidelines.md) | コメント、TypeScript、TDD、テストの分類 |
| [文書の書き方](docs/writing-guidelines.md) | 文書とFactoryが生成する文章の書き方 |
| [作業項目の仕様](docs/internals/work-items.md) | 作業項目と状態の扱い |
| [要件定義の仕様](docs/internals/requirements.md) | 要件定義の生成と承認の仕組み |
| [実装フローの仕様](docs/internals/implement.md) | 実装フローの仕組みと安全策の詳細 |
| [PRワークフローの仕様](docs/internals/pr-workflow.md) | PRのレビューと修正の仕組みと安全策の詳細 |
| [監査の仕様](docs/internals/audit.md) | 監査と改善提案の仕組み |
| [通知の仕様](docs/internals/notifications.md) | Discordへの通知の仕組み |
