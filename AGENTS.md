# atelier-works — Agent Instructions

@AGENTS.wmill.md

## Project-specific instructions

- コメントは日本語で書く(ユーザーレベルの「コード / コメントは英語」より本ルールを
  優先する)。識別子・テスト名・ログやエラーのメッセージ・プロンプト文字列は英語の
  まま。`§`や設計文書の章番号、変更の経緯は書かない。書き方は
  `docs/coding-guidelines.md`の「コメント」、日本語の推敲は`yomiyasu`スキルに従う。
- Configは`.env`系ファイルではなくmiseで管理する。非秘密の設定は`mise.toml`
  の`[env]`に平文で置く。秘密(`DB_PASSWORD` / `WM_ADMIN_EMAIL` /
  `WM_ADMIN_PASSWORD` / `GITHUB_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` /
  `DISCORD_WEBHOOK_URL`)はgitignore済みの`mise.local.toml`に人が投入する。
  投入先が`mise.local.toml`になること、`-E local`を付けずとも以降の
  `mise run` / `mise exec`に自動反映されることは実機確認済み。推奨コマンド
  (値を非表示入力にし、シェル履歴に値を残さない):
  - zsh: `read -rs 'v?KEY: ' && mise set -E local KEY="$v"; unset v`
  - bash: `read -rs -p 'KEY: ' v && mise set -E local KEY="$v"; unset v`
  直書きの`mise set -E local KEY=value`は補足手段に留める(記号を含まない値
  のみで安全、かつシェル履歴に値がそのまま残る点に注意)。Claudeが担当するのは
  `mise.local.toml.example`の更新まで。実際の値の投入は人の作業であり、必要に
  なったら作業を止めずに実行すべきコマンド(上記のいずれか)を提示したうえで
  先に進む。
- `//native`は使わない(child_process / fsを使うため)。managed skillsが推奨する
  bunnativeランタイムより本ルールを優先する。
- Windmill資産の配置先は`f/factory/**`、migrationは
  `migrations/datatable/main/**`に固定する。AGENTS.wmill.mdの「配置先やパスを
  ユーザーに聞く」「deploy方式を聞く」というmanaged guidanceは本リポジトリでは
  適用せず、常にこの既定値を使う(subagentやheadless実行はユーザーに質問できない)。
- Deploy mode: wmill sync push (no git-push deploy)。実務上は`mise run push` =
  `wmill sync push --yes --keep-deleted`を使う。削除を確定させる
  `mise run push:prune`は人が明示的に実行する。
- Metadata: auto。pre-commitフックが`f/`配下のステージ内容に応じて
  `wmill generate-metadata --yes`を実行し、変更・新規作成されたロック/スキーマ
  ファイルを自動でステージする(確認は不要)。pre-pushの`metadata:check`は
  push対象に`f/`か`wmill-lock.yaml`の変更が含まれるときだけ動き、staleな
  メタデータを検出してpushを止める。どちらもローカルWindmill(`mise run up`)
  への接続が必要。依存変更を隠さないため`rehash`は使わない。
  Windmillを起動できない場面では`LEFTHOOK_EXCLUDE=wmill-metadata git commit ...`
  (pre-commit)/ `LEFTHOOK_EXCLUDE=wmill-metadata-check git push`(pre-push)で
  一時的に飛ばせるが、次のpush前に`mise run metadata`で追従させる。
  手動実行は`mise run metadata` / `mise run metadata:check`。
- `scripts/lint-no-type-assertions.ts`はトークンベースのヒューリスティックのため、
  ネストしたジェネリクス(`Array<Array<Foo>>`のように`>>`が1トークンになる場合)
  では誤検知/検知漏れが起こりうる(詳細はスクリプト冒頭コメント参照)。
- Git hooksはlefthook(`mise run setup`で`lefthook install`を実行)。
  pre-commitで(`f/`配下のステージがあれば)`wmill generate-metadata --yes`
  (`scripts/generate-metadata-staged.sh`)を先に実行し、続けてbiome・`as`禁止
  (`lint-no-type-assertions.ts`)・gitleaks・(`f/`があれば)`wmill lint f`を
  並列実行する。commit-msgでコミットメッセージ規約検査
  (`scripts/check-commit-msg.sh`)、pre-pushで`mise run check`と
  `mise run metadata:check`(stale検出)を実行する。`--no-verify`は使わない。
