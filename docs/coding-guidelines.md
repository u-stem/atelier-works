# コーディング規約

このリポジトリのコードを書くときの決まりを定める。コードを変更する人と、Claudeが読む。文書の書き方は[文書の書き方](writing-guidelines.md)にある。

## 言語

- 文書とコメントは日本語で書く。日本語の書き方は[文書の書き方](writing-guidelines.md)に従う。
- 識別子、テスト名、ログとエラーのメッセージ、Claudeへのプロンプトの文字列は英語のままにする。
- コミットメッセージの1行目は`<type>: <日本語の説明>`の形にする。typeは`feat`、`fix`、`docs`、`refactor`、`test`、`chore`のどれかで、commit-msgのフックが検査する。

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
- 外部から来た値(HTTPの応答、`JSON.parse`の結果、サブプロセスのstdoutなど)は、parse, don't validateの原則で扱う。型があると決め打ちしてアクセスせず、型ガード関数でパースしてから使う。

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

型ガード関数の内部で、オブジェクトの形を確かめるために絞り込むことは許す。ただし、その箇所も`lint-no-type-assertions`の検査の対象になる。判定は`typeof`、`in`、配列の確認などで組み立てる。

`as`の検出(`scripts/lint-no-type-assertions.ts`)は、`console/`を含めて`.ts`と`.tsx`を検査する。
完全な構文解析ではなくトークン単位で読むので、まれな入力では誤検知や見逃しが起こる。
`.tsx`ではJSXを読み分けるが、コードをJSXと読み違えることがある。

- 読み違える例は、型の位置の呼び出しシグネチャ`{ <T>(x: T): T }`と、キーワードと同じ綴りの変数を`<`で比べる`from < max`である。
- 読み違えた要素はたいていファイルの終わりまで閉じない。そのときは`UnclosedJsxError`として`file:line:column`を出し、エラーで止まる。書き方を変えて避ける。
- 後ろの文字列リテラルなどにある`</`(`"</a>"`)が、読み違えた要素を閉じることがある。そのときは、間のコードが黙って検査から漏れる。

## リモート追跡ref

`f/factory/`のコードは、`origin/<branch>`という短い名前でrefを読まない。
短い名前は、`refs/heads/origin/<branch>`や`refs/tags/origin/<branch>`が先に解決されうる。
対象リポジトリの検査コマンドはこれらを作れるので、追跡refとは別のcommitを読まされる。

- 追跡refの名前は、`refs/remotes/origin/<branch>`の完全な名前を`remoteTrackingRef`で作る。
- shaは`readExactRef`(`git show-ref --verify`)で読む。`git rev-parse`は、完全な名前でもrefが無いと別のrefへ解決し直すため使わない。
- `scripts/lint-no-short-remote-ref.ts`が、`f/factory/`のTypeScriptで先頭が`origin/`の文字列リテラルとテンプレートリテラルを検出する。コメントは見ない。

この検出もトークン単位で読むので、まれな入力では誤検知や見逃しが起こる。
文字列の連結、変数、テンプレートリテラルの中間部に書かれた`origin/`は検出できない。
`@{upstream}`、`FETCH_HEAD`、`git rev-parse refs/heads/<x>`の読み取りは対象外である。
例外を認める仕組みは設けていない。

## TDD

- 新機能はテストから、バグ修正は再現テストから、リファクタはテストが緑の状態から始める(Red → Green → Refactor)。
- 1テストにつきアサーションは1つ。Arrange-Act-Assertの構成にする。
- 外部プロセス起動や`fetch`は引数として注入し、テストではダミー実装に差し替える(実プロセス・実HTTPを叩くテストは書かない)。
- ただし、判定がgit自身の出力の形(パスの引用、未追跡ディレクトリのまとめ方、pathspecの解釈など)で決まるときは、一時ディレクトリに作ったリポジトリで実際のgitを実行するテストを書いてよい。`HOME`を一時ディレクトリに向けるなどして利用者の設定を読ませず、終わったらディレクトリを消す(`runCommand`で`echo`を実行するテストや、実際のflockを使うテストと同じ扱い)。

## テストの分類

このリポジトリのテストは、Googleのテストサイズの分類(small、medium、large)で分ける。

| サイズ | 対象 | 実行 |
| --- | --- | --- |
| small | DB、ネットワーク、コンテナを使わない単体テスト。`f/factory/lib/**`の大半がここに入り、外部プロセスの起動や`fetch`は注入したダミーに差し替える | `mise run test`(`bun test`) |
| medium | composeのPostgresを使うSQLのスモークテストなど、1台のマシンの中の依存を使うテスト | `mise run test:db` |
| large | 実際にIssueを起票して確かめるE2E | `factory-dev`スキルの「E2Eの動作確認」の手順 |

## Windmill scriptの作法

Windmillの資産の配置、secretとconfigの取得、`//native`を使わないことなどの決まりは、`windmill-script`スキルにある。

## Windmill datatableの型安全性

`wmill.datatable()`のタグ付きテンプレートに`null`を渡すと、Windmillはその値を`text`型で束縛する。そのため、textでない列(bigint、integer、numeric、boolean、jsonbなど)にnullを入れると失敗する。エラーは`column is of type bigint but expression is of type text`の形になる。

`lib/db.ts`では、nullになりうるtextでない値には必ず明示的なキャスト(`::bigint`や`::boolean`など)を付ける。キャストが効くことはテストで確かめる。

## 検証コマンド

`mise run check`は、`lint`、`lint:docs`、`typecheck`、`test`、`console:check`を順に実行する。
PRを出す前に必ず通す。

- `lint`はbiome、`wmill lint f`、型アサーションと`§`の検出を含む。
- `test`は`bun test`で、`console/`を除く。
- `console:check`は、Console(`console/`)のlockfileの方針を検査し、型検査、テスト、組み立てを行う。

依存は、ルートの`bun.lock`と、Console(`console/`)の`console/bun.lock`に分けて固定する。

| 対象 | 入れるとき | 足すとき |
| --- | --- | --- |
| ルート | `bun install --frozen-lockfile --ignore-scripts` | `bun add --exact --ignore-scripts <package>` |
| Console | `bun install --cwd console --frozen-lockfile --ignore-scripts` | `bun add --cwd console --exact --ignore-scripts <package>` |

どちらも`--ignore-scripts`を必ず付ける。
bunは依存のinstall scriptを既定では実行しないが、既定の信頼する一覧(trustedDependencies)にある有名なパッケージだけは実行するためである。

## PRとコミット

PRの本文は`.github/PULL_REQUEST_TEMPLATE.md`の章立てに従う。

人がClaude Codeで作るコミットには、`Co-Authored-By: Claude <noreply@anthropic.com>`のトレーラーを付ける。
モデル名を間に入れてもよく、キー名の大文字小文字は区別しない。
commit-msgのフックは、環境変数`CLAUDECODE`が`1`のときに、トレーラーの行があるかを検査する。
行頭から書いた行が、メッセージの最後の段落(空行で区切られた最後のまとまり)に無ければ、コミットを止める。
1行目と同じ段落や、本文の途中の段落にあるトレーラーは数えない。
gitがトレーラーを最後の段落から読むためである。
`git commit -v`が足す差分(`# ---- >8 ----`の行から下)は、メッセージに含まれないので読まない。
`CLAUDECODE`は、Claude Codeが自分の起動したシェルに設定する内部の変数である。
変数の名前や値が変わると、この検査は働かず、警告も出ない。
この変数はClaude Codeが起動する子プロセスのすべてに引き継がれる。
`!`で実行したコマンドや、そこから起動したtmuxのサーバーやエディタも含む。
そのため、人がそのようなシェルから作るコミットも検査され、失敗したときのメッセージにトレーラーの足し方が出る。
Claude Codeのセッションでメッセージを書き直す操作(rebaseのreword、`cherry-pick -e`、`commit --amend`など)で作るコミットも、検査の対象になる。
1行目が`Merge`、`Revert`、`fixup!`、`squash!`で始まり、その後に空白が続くコミットは、Claude Codeのセッションでも検査しない。
Claude Codeを使わない人のコミットは検査しない。

Software Factoryが作るコミットには、`lib/workspace.ts`の`commitAndPush`が次のトレーラーを自動で付ける。

```text
Co-Authored-By: Claude <noreply@anthropic.com>
Generated-By: Software Factory (<instance_name>)
```

## Claudeのモデルの使い分け

このリポジトリでClaudeを使うときも、Factoryの工程も、同じ方針でモデルを選ぶ。
間違えたときにやり直しが高くつく作業は上位のモデルに任せ、安く直せる作業は既定のモデルで済ませる。

| モデル | 使う場面 |
| --- | --- |
| Sonnet | 既定。実装、コードレビュー、文書の追従 |
| Opus | 設計の判断、原因が分からないバグ、大きな計画とレビュー、Sonnetで2回失敗した課題 |
| Fable | 最難関の課題だけ。subagentの定義やFactoryの既定には入れない |

review-loopでimplementerをOpusで起動し直す条件は、[review-loopスキル](../.claude/skills/review-loop/SKILL.md)が定める。

`.claude/settings.json`の`model`は`opusplan`にしている。計画モードだけがOpusで、実装はSonnetで動く。
`/model opus`は人が打つコマンドで、Claudeの親のセッションは自分で切り替えられない。
review-loopの親が指摘の判定を覆すときや、`[Q]`に答えるときのように、重い判断をする場面では、次のように分ける。
人が見ているセッションでは、人が`/model opus`に切り替える。
クラウドやheadlessでは、重い判断の材料をOpusのsubagent(triage、devil-advocate)に出させる。
subagentのモデルは、各定義の`model`で決める。
implementer、code-reviewer、doc-writerはSonnetで動く。
design-reviewer、requirements-reviewer、security-auditor、devil-advocate、triageはOpusで動く。
Opusで起動できないときの扱いは、review-loopスキルにある。

Factoryも同じ方針で、`f/factory/factory_config`の`model`(既定はSonnet)と`heavy_model`(既定はOpus)を使い分ける。
実装とPR修正は、同じ作業でSonnetが2回失敗したら、以後は`heavy_model`で動く。
工程ごとの割り当てと、既存のリソースの書き換えは[運用](operations.md)の「モデルを使い分ける」にある。

## PRチェックリスト

- [ ] `mise run check`が緑
- [ ] 対象範囲外のファイルを「ついで」で変更していない
- [ ] シークレット・個人情報をコミットしていない
- [ ] コード変更に伴うdocs / スキルの更新を同じPRに含めている
- [ ] Windmillへの反映(`self_update`の自動反映か、次の`mise run up`での反映か、`console/`をCIの後に`console_fetcher`が取り込むか)を明記している
