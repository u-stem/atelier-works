# atelier-works — Agent Instructions

@AGENTS.wmill.md

## Project-specific instructions

本リポジトリでClaudeが守る決まりを書く。
次の3つは、ユーザーレベルの設定と`AGENTS.wmill.md`の管理された指示より優先する。
日本語でコメントを書くこと、`//native`を使わないこと、配置先とdeploy方式を聞かないことである。

- コメントは日本語で書く(ユーザーレベルの「コメントは英語」より優先する)。識別子、テスト名、ログとエラーのメッセージ、プロンプトの文字列は英語のままにする。書き方は[コーディング規約](docs/coding-guidelines.md)に従う。
- コメントに`§`、設計文書の章番号、変更の経緯は書かない。リポジトリの外の文書は読み手が辿れず、経緯はコミットとPRに残すため。
- 文書は[文書の書き方](docs/writing-guidelines.md)と`factory-docs`スキルに従って書く。日本語の推敲には`yomiyasu`スキルを使う。
- 変更は、[review-loopスキル](.claude/skills/review-loop/SKILL.md)で回す。
  ループに通すかと、レビューの人数、ラウンドの上限、設計レビューの要否は、同スキルの「変更の種類」で決める。
  実装した本人の確認だけでは、見落としを拾えないため。
- モデルは、既定をSonnetにし、判断が重い場面はOpusにする。Fableは最難関の課題だけに使う。詳細は[コーディング規約](docs/coding-guidelines.md)の「Claudeのモデルの使い分け」にある。
- 設定は`.env`系のファイルを使わず、miseで管理する。秘密でない設定は`mise.toml`の`[env]`に、秘密値はgitignore済みの`mise.local.toml`に置く。
- 秘密値は人が投入する。Claudeは`mise.local.toml.example`の更新までを行い、値が要るときは[セットアップ](docs/setup.md)の投入コマンドを示して、止まらずに先へ進む。
- `//native`は使わない(scriptが`child_process`と`fs`を使うため)。管理スキルが勧めるbunnativeより本ルールを優先する。
- Windmillの資産は`f/factory/**`に、migrationは`migrations/datatable/main/**`に置く。配置先とdeploy方式はユーザーに聞かない(subagentとheadlessの実行は質問できないため)。
- Deploy mode: wmill sync push (no git-push deploy)。`mise run push`(`wmill sync push --yes --keep-deleted`)を使う。削除を確定する`mise run push:prune`は人が実行する。
- Metadata: auto。メタデータの再生成と検査はgitのフックが行うので、確認せずに任せる。依存の変更を隠さないため`rehash`は使わない。
- メタデータのフックを飛ばすのは、ローカルのWindmillを起動できないときだけにする。commitには`LEFTHOOK_EXCLUDE=wmill-metadata`、pushには`LEFTHOOK_EXCLUDE=wmill-metadata-check`を付ける。次のpushの前に`mise run metadata`で追従させる。追従させないと、CIの`metadata`ジョブが失敗する。
- gitのフックはlefthookで動く([セットアップ](docs/setup.md)の「gitのフック」)。`--no-verify`は使わない。フックの検査を飛ばすと、壊れた変更や秘密値がpushされるため。
- worktreeは`mise run worktree:new -- <type>/<name>`で作り、既存のworktreeへは`EnterWorktree`の`path`で入る。
  置き場所と依存をそろえるためである。
- 片付けは`mise run worktree:prune`で行う。手順は[セットアップ](docs/setup.md)の「worktreeの作成と片付け」にある。
- `scripts/lint-no-type-assertions.ts`はトークン単位のヒューリスティックで、まれな入力では誤検知や見逃しが起こる。`.tsx`でJSXを読み違えたときの扱いと既知の限界は[コーディング規約](docs/coding-guidelines.md)の「TypeScript」にある。
