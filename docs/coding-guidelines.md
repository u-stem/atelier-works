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
- 既知の制限を説明するためにIssue番号を書くのはよい(例: 「検査コマンドはworkerと同じコンテナで動き、networkを分離しない(#146)」)。

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

## 開発の流れ

変更は、次の順で進める。
superpowersが使えない環境では、同じ流れ(計画、実装、別のsubagentによるレビュー1回、修正)を手で行う。
各段のレビューは、新しいレビュアーを1回起動し、修正の後は範囲を絞った再レビューだけにする。
レビュアーの人数とラウンドを増やしても検出率は上がらず、過剰な修正と文書の肥大を招くためである。

1. 計画は`superpowers:brainstorming`で要件を固め、`superpowers:writing-plans`で書く。
   計画と仕様は`docs/superpowers/`に書かれるが、gitで無視しているのでコミットしない。
   設計文書をリポジトリに残さないためで、スキルがコミットを求める手順は飛ばし、`git add -f`は使わない。
2. 実装は`superpowers:subagent-driven-development`で進める。
   worktreeは`mise run worktree:new`で作り、スキルの`using-git-worktrees`は使わない。
   タスクごとに新しいimplementerとtask reviewerを起動する。
   テストは`superpowers:test-driven-development`で先に書く。
   親は、implementerへの依頼の制約に「テストを足すコミットを実装のコミットより前に作る」を書き、task reviewerにコミットの順序を確かめさせる。
   スキルの最後にあるブランチ全体のレビューは起動せず、手順3の`/code-review high`で代える。
   ブランチ全体を見る関門を1つにするためである。
   台帳(`.superpowers/sdd/<計画名>/progress.md`)に残した保留の指摘は、手順3の前に親が直すか、PR本文の「確認して欲しい点」に書く。
3. PRの前に`/code-review high`を1回通し、指摘はコードで確かめてから直す。
   `/code-review high`の指摘は、検証段を通っていないためである。
   次のどれかに当たるときは、`/security-review`も通す。
   - 保護パス(`f/factory/lib/protected_paths.ts`の一覧に当たるファイル)を変えた
   - 新しい`*.sh`を足した
   - 検査を緩めうる`scripts/lint-*.ts`か`scripts/check-*.ts`を変えた
   - `protected_paths.ts`の注記が「人のレビューで差分を確かめて止める」と書いた関数や定数を変えた。
     注記の一覧が正本である。
     `pr_fix_verify.ts`、`pr_fix_finish.ts`、`ci_fix_round.ts`、`ci_fix_classify.ts`、`pr_ci_fix_claim.ts`が当たる。
     `workspace.ts`のgitの固定設定も当たる。
   - migrationに`DROP`、`DELETE`、`TRUNCATE`、既存の値を変える`UPDATE`を含めた
   - 権限、sandbox、トークンの範囲、秘密値の扱いを足すか変えた
   - ファイル、ブランチ、worktree、プロセスを消す処理を足すか変えた
4. `mise run check`が通り、`git status --short`が空であることを確かめてからpushする。
5. PR本文は`pr-body`スキルに従って書く。

## 前提の検証

外部の挙動(git、gh、mise、Windmill、OS、外部サービス)に依存する前提は、実装の前に5分以内の読み取りで確かめる。
前提が誤っていると、その上に積んだ実装とレビューが無駄になるためである。

- 前提の検証では、外へ書き込むコマンドを実行しない。
  `git push`と、本番のFactoryへ書き込む`mise run`のタスクが当たる。
  タスクは`push`、`push:prune`、`up`、`deploy`、`migrate`、`hold:place`、`hold:release`、`freeze:place`、`freeze:release`、`freeze:reset`、`console:rollback`、`console:unpin`である。
  本物のworktreeを消す`worktree:prune -- --apply`も当たる。
- 前提の検証では、`gh`と`wmill`は読み取りのサブコマンド(`view`、`list`、`get`、`--dry-run`)だけを使う。
  PRとIssueの作成は検証ではないので、この制限に当たらない。
- 書き込みが要る検証は、一時ディレクトリに`git init`した使い捨てのリポジトリで行う。

## TDD

- 新機能はテストから、バグ修正は再現テストから、リファクタはテストが緑の状態から始める(Red → Green → Refactor)。
- テストを足すコミットは、実装のコミットより前に作り、実装の前にテストが失敗した出力を残す。
  何も確かめていないテストが通ることを防ぐためである。
  手順は`superpowers:test-driven-development`に従う。
  守られているかは、親が依頼の制約に書いた順序を、task reviewerがimplementerの報告のRED/GREENの記録とコミットの順序で確かめる。
- 外部の挙動に依存する前提は、実装の前に実機で小さく確かめる。
  確かめ方は「前提の検証」にある。
- テストの書き方は[テストの基準](testing-guidelines.md#テストの書き方)に従う。
- 外部プロセス起動や`fetch`は引数として注入し、テストではダミー実装に差し替える(実プロセス・実HTTPを叩くテストは書かない)。
- ただし、判定がgit自身の出力の形(パスの引用、未追跡ディレクトリのまとめ方、pathspecの解釈など)で決まるときは、一時ディレクトリに作ったリポジトリで実際のgitを実行するテストを書いてよい。`HOME`を一時ディレクトリに向けるなどして利用者の設定を読ませず、終わったらディレクトリを消す(`runCommand`で`echo`を実行するテストや、実際のflockを使うテストと同じ扱い)。

## テストの分類

テストの区分(small、medium、large)、層ごとの強度、観点の区分、書かないテスト、カバレッジの計測は、[テストの基準](testing-guidelines.md)が定める。

## Windmill scriptの作法

Windmillの資産の配置、secretとconfigの取得、`//native`を使わないことなどの決まりは、`windmill-script`スキルにある。

## Windmill datatableの型安全性

`wmill.datatable()`のタグ付きテンプレートに`null`を渡すと、Windmillはその値を`text`型で束縛する。そのため、textでない列(bigint、integer、numeric、boolean、jsonbなど)にnullを入れると失敗する。エラーは`column is of type bigint but expression is of type text`の形になる。

`lib/db.ts`では、nullになりうるtextでない値には必ず明示的なキャスト(`::bigint`や`::boolean`など)を付ける。キャストが効くことはテストで確かめる。

### 行の列の定義

テーブルの行を読む関数は、列の名前を1か所に定義し、行の型、変換、SELECT句と食い違わないようにする。
`pr_ci_checks`の`PR_CI_CHECK_COLUMNS`が最初の例である。

- 定義は、列の名前の`as const`の配列にする。行の型に無い列は、`satisfies`で型検査が止める。
- 行の変換は、定義の列だけを持つ入力の型(`PrCiCheckSqlRow`)を受ける。定義に無い列を読むと、型検査が失敗する。
- SELECT句は、テンプレートに直接書く。テンプレートに埋め込んだ値は、識別子ではなくパラメータとして束縛されるためである。
  定義との一致は、`tests/lib/db.test.ts`の一覧にある、行を読む関数ごとに確かめる。
  一覧が、`toPrCiCheck`を呼ぶ関数と同じ数であることも、同じテストで確かめる。
- INSERTの列と、UPDATEの代入先の列が定義にあることは、同じテストの一覧にある、書き込む関数ごとに確かめる。
  UPDATEは、別名つきの文と、1つのSETに複数の列を代入する文も読む。
- 次の範囲は照合しない。
  - UPDATEの代入式の中身と、WHERE、ORDER BY、JOINに書く列。
  - `RETURNING`の列と、CTEの中で別のテーブルへ書く列(`claimPrCiCheckForFix`の`work_items`への挿入)。
  - DELETE。
- 列を足すときは、定義、行の型、変換、SELECT句をそろえる。食い違いは、`test:db`を待たず、型検査か単体テストで見つかる。
- 別のテーブルへ広げるときは、型の主張(`as`)を使わない同じ形で書く。

## 検証コマンド

`mise run check`は、`lint`、`lint:docs`、`typecheck`、`test`、`console:check`を順に実行する。
PRを出す前に必ず通す。
gitのpre-pushは全体の`check`を実行しない。理由は[セットアップ](setup.md#gitのフック)にある。

- `lint`はbiome、`wmill lint f`、型アサーションと`§`の検出を含む。
- `test`は`bun test --parallel`で、`console/`を除く。カバレッジを`coverage/lcov.info`に出す。`check`は、その後に`bun ./scripts/check-coverage.ts`で全体の行カバレッジの下限を確かめる。
- `test:changed`は`origin/main`との差分が影響するテストだけを実行する。importの解析で選ぶので、コードから読まない設定や資産の変更は拾えない。全件の確認はCIが行う。
- `check:changed`は、`scripts/check-changed.ts`が差分のパスから実行する検査を決める。重いのは`lint:docs`なので、差分のMarkdownだけを検査する。絞り方を変えるときは`tests/scripts/check-changed.test.ts`を直す。
- `console:check`は、Console(`console/`)のlockfileの方針を検査し、型検査、テスト、組み立てを行う。
- `console:a11y`は、組み立てたConsoleをChromiumで検査する。ブラウザの取得が要るので`check`に含めず、CIの`console-a11y`ジョブが動かす。

依存は、ルートの`bun.lock`と、Console(`console/`)の`console/bun.lock`に分けて固定する。

| 対象 | 入れるとき | 足すとき |
| --- | --- | --- |
| ルート | `bun install --frozen-lockfile --ignore-scripts` | `bun add --exact --ignore-scripts <package>` |
| Console | `bun install --cwd console --frozen-lockfile --ignore-scripts` | `bun add --cwd console --exact --ignore-scripts <package>` |

どちらも`--ignore-scripts`を必ず付ける。
bunは依存のinstall scriptを既定では実行しないが、既定の信頼する一覧(trustedDependencies)にある有名なパッケージだけは実行するためである。

### 依存の脆弱性

ルートで`bun audit`を実行し、指摘が出たら更新で解消できるかを先に確かめる。
修正版が出ているのに親のパッケージが古い版を求めるときは、ルートの`package.json`の`overrides`で修正版に固定する。
親が修正版を取り込んだら、`overrides`を外す。
固定したままだと、親が新しい版へ移っても古い版に留まるためである。

今、`overrides`で固定しているのは次の2つである。

| パッケージ | 固定する理由 |
| --- | --- |
| `katex` | micromark-extension-mathが`^0.16.0`を求め、0.16系に修正版が無い |
| `smol-toml` | markdownlint-cli2が1.8.0に厳密固定している |

修正版が無い指摘の受け入れと、その確認の手順は[セキュリティ](security.md#依存の脆弱性)に書く。

## PRとコミット

PRの本文は`.github/PULL_REQUEST_TEMPLATE.md`の章立てに従う。
節ごとに何を書くかと、推敲から作成までの手順は、`pr-body`スキルにある。

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

| モデル | 用途 |
| --- | --- |
| Sonnet | 既定。実装、タスクごとのレビュー、文書の追従 |
| Opus | 計画、原因が分からないバグ、Sonnetで2回失敗した課題 |
| Fable | 最難関の課題だけ。Factoryの既定には入れない |

`/code-review high`は親のセッションのモデルで動き、モデルを上げない。
指摘は検証段を通っていないので、コードで確かめてから直す。

`.claude/settings.json`の`model`は`opusplan`にしている。計画モードだけがOpusで、実装はSonnetで動く。
Opusで行う作業は、Agentツールの`model`に`opus`を指定したsubagentに任せる。
人が見ているセッションでは、人が`/model opus`に切り替える。
`/model`は人が打つコマンドで、Claudeの親のセッションは自分で切り替えられないため。

Factoryも同じ方針で、`f/factory/factory_config`の`model`(既定はSonnet)と`heavy_model`(既定はOpus)を使い分ける。
実装とPR修正は、同じ作業でSonnetが続けて2回失敗したら、`heavy_model`で動く。
Sonnetが成功すれば、失敗の数を数え直す。PR修正は、再レビューが続いて3ラウンド目に入っても`heavy_model`で動く。
FactoryのPRのレビューは、失敗の数にかかわらず`heavy_model`で動く。
工程ごとの割り当てと、既存のリソースの書き換えは[運用](operations.md)の「モデルを使い分ける」にある。

## PRチェックリスト

- [ ] `mise run check`が緑
- [ ] 対象範囲外のファイルを「ついで」で変更していない
- [ ] シークレット・個人情報をコミットしていない
- [ ] コード変更に伴うdocs / スキルの更新を同じPRに含めている
- [ ] Windmillへの反映(`self_update`の自動反映か、次の`mise run up`での反映か、`console/`をCIの後に`console_fetcher`が取り込むか)を明記している
