# コーディング規約

## 言語

- ドキュメント(`docs/**`、`README.md`等)は日本語で書く。
- コメントは日本語で書く。識別子・テスト名・ログやエラーのメッセージ・Claudeへのプロンプト文字列は英語のままにする。
- 日本語の文章(コメント・ドキュメント・スキル)は`yomiyasu`スキル(`.claude/skills/yomiyasu/`)の原則で推敲する。英字と日本語の間にスペースを入れない。文体は常体にする。
- コミットメッセージはConventional Commitsのtype + 日本語の説明: `<type>: <日本語説明>`(`type`は`feat` / `fix` / `docs` / `refactor` / `test` / `chore`)。

## コメント

コメントは、コードを読んでも分からないことだけを書く。

- 関数・型・定数のコメントは、宣言の直前に`/** */`で書く。書くのは次の2つに限る。
  - 契約: 何をするか、何を返すか、どういうときに失敗するか、どんな副作用があるか。
  - 理由: その実装を選んだ理由や、守らないと壊れる前提のうち、コードから読み取れないもの。
- ファイル冒頭のコメントには、そのファイルの役割を1〜3文で書く。
- 行内のコメントは、その行だけでは意図が分からない箇所に限って書く。コードをそのまま言い換えたコメントは書かない。
- 次のものは書かない。
  - `§`などのセクション記号と、設計文書・計画書の章番号やファイル名。リポジトリの外にある文書は読み手が辿れない。
  - 変更の経緯(「〜から移した」「PR #Nで追加」など)。経緯はコミットとPRに残す。
  - TODO。今やるかIssueにする。
- 既知の制限を説明するためにIssue番号を書くのはよい(例: 「検査コマンドはworkerの中でrootのまま実行し、隔離しない(#39)」)。

```ts
// 悪い例: 英語、外部文書の章番号、経緯
// Daily budget guard (spec-cycle2.md §3 M6 "daily budget guard"). Promoted
// from f/factory/steps/pipeline_generate.ts's local isBudgetExceeded.

// 良い例: 契約と理由
/**
 * `now`を含むJSTの日の0時を、UTCのISO文字列で返す。
 * 日次予算はJSTの日付で区切るため、UTCの0時は使わない。
 */
export function jstMidnightTodayIso(now: Date): string {
```

## TypeScript

- `tsconfig.json`は`strict: true`を必須とする。
- 型アサーション`as`(`<T>expr`形式含む)は禁止する。例外は次の2つに限る。
  - `as const`
  - 型ガード関数の内部での絞り込み
- `any`は使わない(biomeの`noExplicitAny`で強制する)。
- 外部由来の値(HTTPレスポンス、`JSON.parse`の結果、サブプロセスのstdoutなど)は**parse, don't validate**の原則で扱う。「型があるかのように決め打ちしてアクセスする」のではなく、型ガード関数でパースしてから使う。

```ts
// 悪い例: 決め打ちでアクセスする(`as`で黙らせている)
const data = JSON.parse(stdout) as { summary: string };

// 良い例: 型ガードでパースしてから使う
type ClaudeResult = { summary: string; markdown: string };

function isClaudeResult(value: unknown): value is ClaudeResult {
  if (typeof value !== "object" || value === null) return false;
  if (!("summary" in value) || !("markdown" in value)) return false;
  return true;
}

const parsed: unknown = JSON.parse(stdout);
if (!isClaudeResult(parsed)) {
  throw new Error("unexpected claude output shape");
}
// ここから先は`parsed`を`ClaudeResult`として扱える
```

型ガード関数の内部でオブジェクトの形を確認するために絞り込む箇所は許容されるが、`lint-no-type-assertions`のチェック対象になる。判定ロジック自体は`typeof` / `in` / 配列チェックなどで組み立てる。

## TDD

- 新機能はテストから、バグ修正は再現テストから、リファクタはテストが緑の状態から始める(Red → Green → Refactor)。
- 1テストにつきアサーションは1つ。Arrange-Act-Assertの構成にする。
- 外部プロセス起動や`fetch`は引数として注入し、テストではダミー実装に差し替える(実プロセス・実HTTPを叩くテストは書かない)。
- ただし、判定がgit自身の出力の形(パスの引用、未追跡ディレクトリのまとめ方、pathspecの解釈など)で決まるときは、一時ディレクトリに作ったリポジトリで実際のgitを実行するテストを書いてよい。`HOME`を一時ディレクトリに向けるなどして利用者の設定を読ませず、終わったらディレクトリを消す(`runCommand`で`echo`を実行するテストや、実際のflockを使うテストと同じ扱い)。

## テストの分類

本リポジトリ自身のテストはGoogleのテストサイズ分類(small / medium / large)で分ける。

- **small**: 外部依存(DB・ネットワーク・コンテナ)を使わない単体テスト。`bun test`(`mise run test`)。`f/factory/lib/**`の大半はここに属し、外部プロセス起動や`fetch`は注入したダミー実装に差し替える。
- **medium**: composeのPostgresを使うSQLスモークテストなど、単一マシン内のローカルな依存(DB・コンテナ)を使うテスト。`mise run test:db`。
- **large**: 実際のIssue起票から確認するE2E。`factory-dev`スキルおよび`mise run doctor` → `up` → `bootstrap`後の手順に従う。

## Windmill scriptの作法

- Windmill固有の配置・secret取得・config取得・native不使用などの規約は`windmill-script`スキル(`.claude/skills/windmill-script/SKILL.md`)を参照する。

## Windmill datatableの型安全性

- `wmill.datatable()`のタグ付きテンプレート(バッククォート文字列)に`null`パラメータを渡すと、Windmillがそのパラメータを`text`型で束縛する。bigint / integer / numeric / boolean / jsonbなどの非text列に対してnull値をINSERT / UPDATEしようとすると、`column is of type bigint but expression is of type text`エラーで失敗する。
- **回避策**: nullになりうるパラメータに対して明示キャストを付ける。`lib/db.ts`では、nullになりうるすべての非textパラメータに`::型名`(例: `::bigint`、`::boolean`)キャストを必ず付け、テストで確認する。

## 検証コマンド

- `mise run check`で`lint`(`biome check` + `wmill lint f` + 型アサーション検出)→ `typecheck`(`tsc --noEmit`)→ `test`(`bun test`、`console/`を除く)→ `console:check`(Consoleの型検査・テスト・組み立て)を順に実行する。PRを出す前に必ず緑にする。
- Console(`console/`)の依存はルートと分け、`console/bun.lock`で固定する。入れるときは`bun install --cwd console --frozen-lockfile --ignore-scripts`を、足すときは`bun add --cwd console --exact --ignore-scripts <package>`を使う。bunは依存のinstall scriptを既定では実行しないが、既定の信頼する一覧(trustedDependencies)にある有名なパッケージだけは実行するため、`--ignore-scripts`で止める。
- 型アサーション検出は`.tsx`を対象にしない(スキャナーがJSXの本文を誤って読むため)。`.tsx`では`as`を書かず、判定は`.ts`の純粋関数に切り出す。

## PRテンプレート

PRは`.github/PULL_REQUEST_TEMPLATE.md`の次の章立てに従う。

1. **概要**: このPRで何をしたか、なぜ必要かを簡潔に記述する。
2. **受入条件**: Issueの受入基準をチェックリストで記述する(Factoryが作成したPR)。
3. **動作確認結果**: lint / typecheck / test / E2Eの実行結果をチェックする。
4. **確認して欲しい点**: 実装上のトレードオフや不確実な部分を記述する。
5. **関連リンク**: `Closes #N`形式でIssueを明示する(Factoryはこれで承認済み要件と照合する)。
6. **備考**: Windmillへの反映を記述する。`f/`・`migrations/`・`.claude/skills/`の変更はマージ後に`self_update`が自動で反映し、`infra/`と`mise.toml`の`[tools]`・`[env]`の変更は次に`mise run up`で起動したときに反映される(通知はしない)。

人がClaude Codeで作成するコミットには、トレーラー`Co-Authored-By: Claude <noreply@anthropic.com>`を付ける。

Software Factoryが作成するコミットには、トレーラー`Co-Authored-By: Claude <noreply@anthropic.com>`と`Generated-By: Software Factory (<instance_name>)`が自動で付く(`lib/workspace.ts`の`commitAndPush`)。

## PRチェックリスト

- [ ] `mise run check`が緑
- [ ] 対象範囲外のファイルを「ついで」で変更していない
- [ ] シークレット・個人情報をコミットしていない
- [ ] コード変更に伴うdocs / スキルの更新を同じPRに含めている
- [ ] Windmillへの反映(`self_update`の自動反映か、次の`mise run up`での反映か)を明記している
