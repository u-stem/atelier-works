# セットアップ

## 前提

- ホストに必要なのはdocker(DesktopまたはOrbStack)とmiseのみ。それ以外(node, bun, gh, windmill-cli)は`mise run setup`(内部で`mise install`)で入る。
- 初回は`mise trust`でこのリポジトリの`mise.toml`を信頼する。
- 設定は`.env`系ファイルを使わない。`infra/.env`や`infra/secrets.env`は存在しない。非秘密の設定は`mise.toml`の`[env]`に、秘密はgitignore済みの`mise.local.toml`に置く。

## 資格情報の取得

`GITHUB_TOKEN`(GitHub fine-grained PAT)、`CLAUDE_CODE_OAUTH_TOKEN`、`DISCORD_WEBHOOK_URL`の取得手順は
[docs/security.md](security.md)の「GitHub PAT」「CLAUDE_CODE_OAUTH_TOKENの取得」「DISCORD_WEBHOOK_URLの取得」を参照する(ここでは重複させない)。
`DB_PASSWORD`、`WM_ADMIN_EMAIL`、`WM_ADMIN_PASSWORD`は自分で決めた値でよい。

値の投入コマンドと`mise.local.toml.example`の使い方は`.claude/skills/factory-dev/SKILL.md`の「資格情報の取得手順」を参照(`read -rs`経由で`mise set -E local KEY=value`)。

## 起動

```bash
mise trust
mise run setup       # mise install, bun install --frozen-lockfile, lefthook install
# ここで秘密値を投入する(前節参照)
mise run doctor       # 環境診断
mise run up            # docker compose でスタック起動(build 込み)
mise run bootstrap      # ワークスペース作成、secret 投入、sync push、migration 適用(冪等)
```

`GITHUB_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` / `DISCORD_WEBHOOK_URL`を空のまま`bootstrap`を実行しても完了はする(該当するWindmill変数が空で作成される)。ただし`doctor`はこれらが未設定だとNGを報告するため、実運用前には必ず値を投入する。

`bootstrap`はワークスペースIDを小文字の`factory`のまま、表示名だけを`Factory`(ダッシュボードApp「Factory Console」などと表記を揃える)に設定する。

## 自己更新に関する設定

- `factory_config`リソースの`factory_branch`(既定`main`)は、`self_update`が追跡するこのリポジトリのブランチ名。フォークやフィーチャーブランチで運用したい場合はWindmill UIからこの値を変更する(変更が効くのはworker内のself cloneをまだ作成していない場合のみ。既存のcloneに反映するにはworkerコンテナ内の`/workspaces/factory/atelier-works`を削除して再作成させる)。
- `f/factory/deployed_sha`変数は、直近でWindmillに反映済みのコミットSHAを保持する非secret変数。`self_update`が自動的に更新するため、通常は人が編集する必要はない。`factory_config`リソースと同様にsync対象外で、`bootstrap`が初回のみ空値で作成する(既に存在する場合は値を変更しない)。値を手動でリセットしたい場合はWindmill UIから直接編集する。

## 動作確認コマンドと期待出力

| 確認内容 | コマンド | 期待される出力 |
| --- | --- | --- |
| 環境診断 | `mise run doctor` | すべての項目が`OK`。末尾に`=== 全項目 OK ===`、終了コード0 |
| Windmillサーバーの応答 | `curl http://127.0.0.1:8080/api/version` | `CE v1.817.0` |
| ローカルとリモートの一致 | `mise exec -- wmill sync push --dry-run` | `0 changes` |
| Data Table migration | `mise run test:db` | 全view(`v_inbox`など7つ)のSELECTとdown migrationのロールバックが成功し、末尾に`[test-db] OK` |

## トラブルシュート

| 症状 | 原因・対処 |
| --- | --- |
| ポートが衝突する | `mise.local.toml`で`WM_HTTP_PORT`を別の値に上書きする(例: `read -rs 'v?WM_HTTP_PORT: ' && mise set -E local WM_HTTP_PORT="$v"; unset v`) |
| `doctor`が「初期パスワード」の項目でNGになる | `WM_ADMIN_PASSWORD`が`changeme`のまま。`mise run bootstrap`を実行するとログイン後に自動でパスワードを変更する |
| `required variable ... is missing a value: run via mise`というエラーが出る | `docker compose`を`mise run`を経由せず直接実行している。すべて`mise run <task>`または`mise exec -- docker compose ...`で実行する(composeの環境変数はmiseの`[env]` / `mise.local.toml`からしか渡らない) |
| workerイメージを作り直したい | `mise run build`(`windmill_worker`サービスのみを再ビルドする) |
| 完全にリセットしたい | `docker compose -f infra/docker-compose.yml down -v`(**注意: `db_data`を含むすべてのvolumeが削除され、Windmillのデータが失われる**) |
| ホストのCPUアーキテクチャ(arm64 / amd64)が心配 | 対応不要。公式Windmillイメージ・workerイメージのビルドともにarm64 / amd64の両方に対応している |
