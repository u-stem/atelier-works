# atelier-works — Agent Instructions

@AGENTS.wmill.md

## Project-specific instructions

- Config は `.env` 系ファイルではなく mise で管理する。非秘密の設定は `mise.toml`
  の `[env]` に平文で置く。秘密(`DB_PASSWORD` / `WM_ADMIN_EMAIL` /
  `WM_ADMIN_PASSWORD` / `GITHUB_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` /
  `DISCORD_WEBHOOK_URL`)は gitignore 済みの `mise.local.toml` に人が投入する。
  投入先が `mise.local.toml` になること、`-E local` を付けずとも以降の
  `mise run` / `mise exec` に自動反映されることは実機確認済み。推奨コマンド
  (値を非表示入力にし、シェル履歴に値を残さない):
  - zsh: `read -rs 'v?KEY: ' && mise set -E local KEY="$v"; unset v`
  - bash: `read -rs -p 'KEY: ' v && mise set -E local KEY="$v"; unset v`
  直書きの `mise set -E local KEY=value` は補足手段に留める(記号を含まない値
  のみで安全、かつシェル履歴に値がそのまま残る点に注意)。Claude が担当するのは
  `mise.local.toml.example` の更新まで。実際の値の投入は人の作業であり、必要に
  なったら作業を止めずに実行すべきコマンド(上記のいずれか)を提示したうえで
  先に進む。
- `//native` は使わない(child_process / fs を使うため)。managed skills が推奨する
  bunnative ランタイムより本ルールを優先する。
- Windmill 資産の配置先は `f/factory/**`、migration は
  `migrations/datatable/main/**` に固定する。AGENTS.wmill.md の「配置先やパスを
  ユーザーに聞く」「deploy 方式を聞く」という managed guidance は本リポジトリでは
  適用せず、常にこの既定値を使う(subagent や headless 実行はユーザーに質問できない)。
- Deploy mode: wmill sync push (no git-push deploy)。実務上は `mise run push` =
  `wmill sync push --yes --keep-deleted` を使う。削除を確定させる
  `mise run push:prune` は人が明示的に実行する。
- Metadata: ask first(`wmill generate-metadata` 等でメタデータを書き換える前に
  必ず確認する)。
- `scripts/lint-no-type-assertions.ts` はトークンベースのヒューリスティックのため、
  ネストしたジェネリクス(`Array<Array<Foo>>` のように `>>` が1トークンになる場合)
  では誤検知/検知漏れが起こりうる(詳細はスクリプト冒頭コメント参照)。
- Git hooks は lefthook(`mise run setup` で `lefthook install` を実行)。
  pre-commit で biome・`as` 禁止(`lint-no-type-assertions.ts`)・gitleaks・
  (`f/` があれば)`wmill lint f`、commit-msg でコミットメッセージ規約検査
  (`scripts/check-commit-msg.sh`)、pre-push で `mise run check` を実行する。
  `--no-verify` は使わない。
