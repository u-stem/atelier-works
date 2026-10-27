# 保留の内部仕様

保留(hold)は、対象を進めないことを、期限つきで伝える仕組みである。
状態は表`factory.holds`に置き、読み書きは`f/factory/lib/holds.ts`が行う。
次のファイルの保留に関わる部分を変更する人が読む。

- `f/factory/lib/holds.ts`
- `migrations/datatable/main/20261023131355_holds.up.sql`
- `f/factory/poll_dependabot.ts`と`f/factory/steps/dependabot_finish.ts`(保留を読む処理)
- `scripts/hold.ts`と`scripts/hold_psql.ts`(CLI)
- `scripts/claude-hooks/hold-guard.ts`(subagentの拒否)
- `scripts/claude-hooks/merge-guard.ts`、`merge-targets.ts`、`merge-read.ts`(ローカルのセッションのフック)
- `.claude/skills/hold/SKILL.md`(保留を置く・解除する手順)
- `tests/scripts/hold_wiring.test.ts`
- `scripts/test-db-holds.ts`

残るリスクは[セキュリティ](../security.md)の「保留」に書く。

## 方針

保留は止めるためだけに使う。
保留の有無が、何かを許可することはない。
許可に使うと、偽の行を置くだけで保護が外れるためである。

保留を読んで止まる主体は、Factoryのdependabotの自動マージと、ローカルのClaudeのセッションのフックである。
範囲`claim`を読む主体は無く、設ける予定もない。
表と関数は残す。
置く操作は拒否する。
Issueの二重取りは、別の仕組みで防ぐ([Issueの二重取りを防ぐ仕組み](#issueの二重取りを防ぐ仕組み))。

## 凍結との違い

[スケジュールの凍結とdeployの保留](freezes.md)は、スケジュールを`wmill sync push`から外す仕組みと、反映全体を待たせる仕組みで、状態は`f/factory/freezes`の変数に置く。
保留の対象は、凍結の対象と重ならない。
保留の表は、凍結の変数の代わりにはならない。

次の名前は別の概念で、この表とは関係しない。

- PRの表の列`fix_hold_reason`と`lib/pr_conflict_fix_holds.ts`: PRを直す作業項目の起動を見送る理由
- Consoleの`staleHold.ts`: 書き込みの後に一覧を読み直せないとき、操作を止めておく待ち

## 範囲

範囲(`scope`)は、何を止めるかを決める。

| 範囲 | 止めるもの | 対象(`target`) | 重ね方 |
| --- | --- | --- | --- |
| `merge` | 自動マージ | `owner/repo` | 主体ごとに重ねられる。有効な行が1件でもあれば止める |
| `claim` | Issueの取り込み(読み手なし) | `owner/repo#number` | 対象ごとに排他 |

対象は小文字にそろえる。

## Issueの二重取りを防ぐ仕組み

Issueの二重取りは、次の仕組みで防ぐ。

- 取得: Factoryは、トリガーラベルを外す要求に成功したインスタンスだけが、そのIssueを受け持つ。
- 作業項目: 部分一意インデックス`work_items_active_issue_key`が、終端でないIssueの作業項目をIssueごとに1件までにする。
  `work_items_active_pr_fix_key`が、終端でないPR修正をPRごとに1件までにする。
  GitHubは、同時の削除のうち成功が1つになることを保証しない。
  そのため、最後の防御はインデックスである。
- ブランチ名: Factoryの実装ブランチは`factory/issue-<N>-wi-<id>`で、作業項目ごとに違う。
  `mise run worktree:new`は、既存のブランチ名を拒否する。
  `--hook`の経路は、既存のブランチを再利用する。
- 人の承認: Issueに着手するのは、人がセッションに渡したときと、人がラベルを付けて承認したときだけである。

次の二重着手は防がない。

- ローカルのセッション同士が、別のブランチ名で同じIssueに着手する。
- ローカルのセッションとFactoryが、同じIssueに着手する。

どちらも人が着手を決める経路にしか無く、害は、重複したPRを閉じる手間と実装の費用にとどまる。
`claim`を入れても、置く側が人の注意に頼る点は変わらず、守りは増えない。
`claim`を読む処理は設けない。
着手の重複は、人が閉じる。

## データ

列は次のとおりである。
定義はmigrationのファイルを参照する。

| 列 | 内容 |
| --- | --- |
| `id` | 行の識別子 |
| `scope` | 範囲。`merge`か`claim` |
| `target` | 対象。小文字 |
| `reason` | 理由。1〜200文字 |
| `holder_kind` | 置いた主体の種類。`session`、`human`、`factory` |
| `holder` | 置いた主体の名乗り。1〜100文字 |
| `created_at` | 置いた時刻。既定は`now()` |
| `expires_at` | 期限。`created_at`から24時間以内 |
| `released_at` | 閉じた時刻。未解除なら空 |
| `released_by` | 閉じた理由か主体。未解除なら空 |

`holder`は、`session`が`session:<ブランチ>`、`human`が`human`、`factory`が`factory:<ジョブ名>`の形をとる。
名乗りであり、認証ではない。

`released_at`と`released_by`は、同時に空か、同時に空でない。
`released_by`は、期限切れを閉じた行が`expired`、無効な行を閉じた行が`invalid`、解除した行が解除した主体の`holder`になる。
`released_at`と`created_at`の大小は制約にしない。
未来の`created_at`の行を閉じると、`released_at`が`created_at`より前になるためである。

未解除の行に限る部分一意インデックスが、重ね方を決める。
`merge`は`(scope, target, holder)`で、同じ主体の二重置きを拒否し、別の主体は重ねられる。
`claim`は`(scope, target)`で、持ち主を問わず排他になる。

行は消さず、履歴として残す。

## 有効の条件

行が有効なのは、次の4つをすべて満たすときである。

- 未解除である。
- `created_at`が`now()`以前である。
- `expires_at`が`now()`より後である。
- `expires_at`が`created_at`から24時間以内である。

書き手は`created_at`と`expires_at`の列を渡せる。
そのため、24時間の上限は、表の制約だけでなく、読み取りの有効条件でも効かせる。
`isActiveHold`と`listActiveHolds`のSQLは、同じ条件を使う。

期限切れの行は、閉じられていなくても、読み取りの時点で無効と数える。

## 置く操作

`placeHold`は、自動コミットの2つの文で保留を置く。

1. 同じ対象の未解除の行のうち、無効なものを閉じる。
   `merge`は同じ`holder`の行だけ、`claim`は持ち主を問わず閉じる。
   期限切れの行は`expired`、`created_at`が`now()`より1分を超えて後の行と、上限を超えた行は`invalid`を`released_by`に入れる。
   `created_at`が`now()`より1分以内に後の行は、閉じない。
2. `ON CONFLICT DO NOTHING`で挿入する。
   戻りが空なら、有効な保留が既にある。
   阻んだ行が期限切れになった直後であれば、再実行で通る。

1分の余裕は、他の主体が置いたばかりの行を閉じないためである。
`READ COMMITTED`では`now()`が文の開始時刻なので、置いたばかりの行の`created_at`が、この文の`now()`より少し後になりうる。
余裕は閉じる条件だけに使い、有効の条件は変えない。
余裕の内の行は、有効ではないが閉じられもしないので、置く操作は「既に有効な保留がある」で断られる。

1つのCTEにまとめず、2つの文に分ける。
間で失敗しても、閉じるのは無効な行だけなので、表は壊れない。
期限切れの行が残っていても、置く操作は塞がれない。

2つの文は、それぞれ自動コミットで送る。
`now()`が文ごとに決まる前提なので、呼び出し側が2つの文を1つのトランザクションに束ねた接続を渡してはならない。
1分を超えて開いたトランザクションでは、他の主体が置いたばかりのclaimの行を、`invalid`で閉じうる。
psqlで送るときも、`-c`に2つの文を渡すと1つのトランザクションになるので、文ごとに送る。

`placeHold`は、文を送る前に`validatePlaceInput`で入力を検証する。
通らない入力は、文を送らずに失敗を返す。
`holder`と`holder_kind`の対応と制御文字は、表の制約が拾わないためである。

期限は、呼び出し側が時刻を渡さず、分(1〜1440)をDBが`now() + make_interval(mins => n::integer)`で時刻にする。
延長は設けない。
続けるときは、解除して置き直す。

## 解除

`releaseHold`は、行を読み、`canRelease`で許される主体だけが更新を送る。
人(`human`)は持ち主を問わず解除できる。
それ以外は、自分の`holder`の行だけ解除できる。
期限切れや無効な未解除の行も解除できる。
一覧から片付けるためである。

読んでから更新するまでの間に別の解除が通ったときは、「既に解除された」を返す。

解除する主体は、文を送る前に`validateActor`で検証する。
`released_by`に名乗りを書くので、置くときと同じ規則で、制御文字と、種類と`holder`の対応を確かめる。
通らない主体は、文を送らずに失敗を返す。

### Consoleからの解除

人は、Consoleのシステムの画面の「保留と凍結」から、確認のダイアログを通して解除できる([Consoleの仕様](console.md)の「保留と凍結」)。
`f/factory/hold_release`が保留を、`f/factory/freeze_release`が凍結とdeployの保留([凍結とdeployの保留の内部仕様](freezes.md))を解除する。
どちらもtag`console`のscriptで、Console用のworkerで動く。
読み取りは`f/factory/console_holds`が行い、保留の表と凍結の変数を別々に読む。
置く操作は、`f/factory/console_hold_place`が持つ(次の「Consoleからの置く操作」)。

`hold_release`は、次の順で解除する。

1. 保留のidが正の整数であることを確かめる。
2. 操作者を、ジョブの実行文脈(`WM_USERNAME`、無ければ`WM_EMAIL`)から導く。導けなければ、何も変えずに拒否する。
3. 有効な保留の一覧から、解除する行を探す。読めなくても進む。
4. `releaseHold`を、主体`{kind: "human", holder: "human"}`で呼ぶ。`session`と`factory`が置いた行も解除できる。
5. 有効だった行を解除したときと、一覧を読めず有効だったかを確かめられなかったときだけ、情報の通知`hold_released`を残す。

解除する主体は引数に取らず、`human`に固定する。
`human`の`holder`は`human`に限るので、`released_by`に操作者の名前は書けない。
操作者は、通知とジョブのログに残す。ログには、`reason`と`holder`を載せない。

| 結果 | 戻り |
| --- | --- |
| 解除した | `status`が`released`。`was_active`は、解除の前に有効だったか。有効だったとき(と、有効かを確認できなかったとき)だけ`audit`(`recorded`か`failed`)が付く |
| 期限切れの行を片付けた | `released`で、`was_active`が偽。通知は残さず、`audit`も付かない |
| 有効な一覧を読めなかった | `released`で、`was_active`が偽、`active_unknown`が真。解除の前に有効だったかを確認できなかったと書いた通知を残し、`audit`が付く |
| すでに解除されていた | `already_released`。通知は残さない。複数のタブからの再送も、副作用は1回である |
| そのほかの失敗 | 接頭辞`hold_release:`の例外 |

有効な一覧を読めなかったときの通知は、「解除しました」とは書かない。
期限切れの行の片付けを、有効な保留の解除として記録しないためである。
画面は、解除は済んだが有効だったかは確認できなかったと警告で伝える。
通知の書き込みが失敗しても、解除は取り消さない。ジョブのログに警告を残し、`audit`に`failed`を返す。
画面は、通知を残せなかったことを警告で知らせる。
通知の本文は、解除した対象(種類、対象、id)、操作者、時刻(JST、秒まで)である。
未解決の通知は`(kind, message)`で重複が弾かれるので、時刻を秒まで含める。
通知は[通知の仕様](notifications.md)にある。

`released_at IS NULL`の条件つきで更新するので、再送は安全である。
`already_released`と判定する固定の理由は、`holds.ts`の出力と一致することをテストが固定する。

ローカルのClaudeのセッションは、この2つのscriptを`wmill`や`curl`で呼べない。
主セッションを含むすべてのセッションで、フックが拒否する([セキュリティ](../security.md)の「保留」)。
ローカルの主セッションはCLIでは`session`として扱われ、人の解除には端末での確認が要る。
Consoleのscriptは、その確認を通らずに他の主体の保留を外せるためである。

### Consoleからの置く操作

人は、Consoleのシステムの画面から、マージの保留を置ける([Consoleの仕様](console.md)の「保留と凍結」)。
`f/factory/console_hold_place`は、マージの保留と、スケジュールの凍結とdeployの保留([凍結とdeployの保留の内部仕様](freezes.md))を置く。
tag`console`のscriptで、Console用のworkerで動く。
`placeHold`を読み込んでよい`f/`のファイルは、このscriptだけである。
読み込む名前は、`placeHold`、`listActiveHolds`、入力の検査の`validatePlaceInput`、置けなかった理由の定数`HOLD_ALREADY_ACTIVE`に限る。
配線テストが固定する。

マージの保留は、次の順で置く。

1. 入力を`validatePlaceInput`で検査する。種類、対象、期限、理由が正しくなければ、何も読まず、書かず、記録もせずに断る。
2. 操作者を、ジョブの実行文脈から導く。導けなければ、何も置かずに拒否する。
3. 操作の記録(`factory.console_actions`)に、`attempted`の行を入れる。入れられなければ、置かずに拒否する。
4. 対象の有効なマージの保留を読む。人以外の行があれば、置かない。人の行も、重ねない。
5. `placeHold`を、主体`{kind: "human", holder: "human"}`で呼ぶ。`HOLD_ALREADY_ACTIVE`が返れば、すでに有効な行があるとして断る。
6. 有効な保留を読み直し、置いたidが見えるかを確かめる。見えなければ、戻りの`verified`を偽にし、記録の結果を`partial`にする。

置く主体は引数に取らず、`human`に固定する。
`human`の`holder`は`human`に限るので、保留の行に操作者の名前は書けない。
操作者は、操作の記録に残す。
記録には、種類、対象、期限(分)、理由の長さ、置いたidだけを入れ、理由は入れない。
理由は、1文字以上200文字以下で、制御文字を含めない。
期限は、1分から1440分までの整数である。
対象は、`owner/repo`の形である。
対象が`repo_allowlist`の外でも置ける。
保留は止めるためだけに使い、許可に使わないので、許可の外の対象に置いても害は無い。

同じ人が同じリポジトリに重ねて置けないのは、Consoleの規則である。
CLIは、別の`holder`であれば重ねて置ける。

戻りと断りの種類は、[凍結とdeployの保留の内部仕様](freezes.md)の「Consoleからの置く操作」にある。

## 読み取り

| 関数 | 返すもの |
| --- | --- |
| `listActiveHolds` | 有効な行 |
| `listInvalidHolds` | 未解除で、有効の条件を満たさない行(期限切れを含む) |

どちらも、成功と失敗を区別して返す。
失敗は、空の一覧にはしない。
呼び出し側は、失敗を「保留なし」と扱ってはならない。

読み出した`reason`、`holder`、`released_by`は、信頼できない文字列である。
端末などに出す前に、制御文字と書式文字を空白にする。

| 失敗の種類 | 意味 |
| --- | --- |
| `missing_table` | 表が無い。migrationが未反映 |
| `read_failed` | DBに届かないなど、読めなかった |
| `corrupt` | 行の解析に失敗した。理由に回復の手順を含める |

表が無いことは、例外のSQLSTATE(`42P01`)、エラーの文、API errorの`body`のどれかで判定する。
回復の手順を示すのは、`corrupt`のときだけである。

## dependabotの自動マージ

dependabotのセキュリティ更新PRを自動でマージする処理は、`merge`の保留を2か所で読む。
どちらも、リポジトリ(`owner/repo`の小文字)の有効な保留を`listActiveHolds`で読む。

取得(`poll_dependabot`)は、PRごとに、作業項目を作る前に読む。
処理済みのheadと、開いていないPRは読まない。
待ちの間引きの対象になっているheadも、間引きの判定を先に行うので読まない。
間引きは待ちの記録をそのまま返すので、保留の確認を間引きの後ろに置いても、待ちの記録は変わらない。
有効な保留が1件でもあれば、作業項目を作らず、影響調査(Claudeの実行)も走らせずに待つ。
保留を読めないときも、保留なしとは扱わず、同じように待つ。
読めないのは、表が無いとき、DBに届かないとき、行が壊れているとき、例外が出たときである。
待ちの記録は変えない。
保留が続いても、待ちの上限の起点は前の記録から続く。

待ったPRがある周回は、種類を分けて1件ずつ通知にまとめる。
壊れた行と想定外の失敗は、リポジトリごとの通知になる。

| 状態 | 通知の種類 | 重要度 | 本文 |
| --- | --- | --- | --- |
| 保留がある | `dependabot_merge_held` | 情報 | 一覧と解除の操作 |
| 保留を読めない | `dependabot_merge_hold_unreadable` | 要対応 | 読めない原因の種類と、最初に確かめること |

どちらの通知も、PRの数を本文に載せない。
数が変わるたびに本文が変わり、別の行が並ぶためである。
待ったPRの数は、取得の周回のログ(`pull requests wait for merge holds`)と、周回の結果の`held`に残る。
保留の`reason`と`holder`は、通知とログのどちらにも載せない。

保留を読めない通知は、保留を読めた次の取得の周回で、自動で解決する。
人の作業は、自動で回復できないときの受け皿だけにするためである。
解決の条件は、原因の種類で分ける。

- 表を読めない(`missing_table`、`read_failed`)通知は、その周回で保留の読み取りが1件以上あり、読めなかったものが1件も無いときに解決する。
- 壊れた行(`corrupt`)と想定外の失敗(`error`)の通知は、本文の先頭に、リポジトリ名とコロンを置く。
  その周回で、そのリポジトリの保留を読めたときだけ解決する。
  別のリポジトリを読めても、壊れたままのリポジトリの通知は残る。
  リポジトリ名は小文字にそろえる。
  間引きでそのリポジトリの保留を読まなかった周回は、解決しない。

候補のPRが無い周回でも、未解決の通知があれば、取得が保留を読む。
リポジトリごとの通知は、そのリポジトリを読む。
表そのものの通知は、周回でまだ何も読んでいなければ、1つのリポジトリを読む。
この読み取りでは、通知を新しく残さない。
読めなかったときは、通知が残る。
監視の対象から外れたリポジトリの通知は、読まないので解決しない。

保留が解けるか、読めるようになれば、次の取得が自動で再開する。
dependabotがrebaseして新しいheadになったPRは、新しいheadとして評価する。

終了(`dependabot_finish`)は、マージの直前にもう一度読む。
取得から終了までの間に置かれた保留を、最後に確かめるためである。
読む位置は、試運転(`dependabot_merge_enabled`が偽)の判定より前である。
保留があるか読めなければ、マージせずに、作業項目を人の対応待ち(`needs_human`)で終える。
この作業項目は、保留が解けても再開しない。
dependabotの作業項目は再実行できないので、人がPRを確認して手でマージする。
次の操作は、通知に載る。

終了のステップのログと通知に載せるのは、種類、件数、保留のidだけである。
`reason`と`holder`は、DBに書ける主体が決める信頼できない文字列なので、載せない。

保留を読んでからマージを要求するまでの数秒は、受け入れる。
保留は止めるだけの補助で、元の保護(レビューとゲート)が残るためである。
Factoryの側で保留が止めるのは、dependabotの自動マージだけである。
取得の待ちは、`dependabot_merge_enabled`が偽の試運転中も働く。
`dependabot_merge_enabled`が真のときだけ働くのは、終了のステップのマージの直前の最後の確認である。
ローカルのセッションの`gh pr merge`は、フックが止める([ローカルのセッションのフック](#ローカルのセッションのフック))。
マージを要求するFactoryの処理は終了のステップだけで、配線テストが固定する。

## CLI

`mise run hold:list`、`mise run hold:place`、`mise run hold:release`が、`scripts/hold.ts`を呼ぶ。
miseのタスクを使えないときは、`mise exec -- bun ./scripts/hold.ts <コマンド>`と書く。
composeに要る環境変数を、miseが渡すためである。

| コマンド | 内容 |
| --- | --- |
| `list` | 有効な保留、未解除で無効な行、有効なスケジュールの凍結とdeployの保留の件数を表示する |
| `place --scope merge --target <owner>/<repo> --minutes <n> --reason <text>` | 保留を置く |
| `release <id>` | 保留を解除する |

終了コードは、引数の誤りが2、拒否と失敗が1である。

`list`は、読み取り専用の接続で読む。
有効な保留を先に表示してから、無効な未解除の行(`invalid`と表示する)を表示する。
無効な行を読めなくても、読めた有効な保留は先に表示し、その後に失敗を表示して終了コード1で終わる。
読めなければ、理由を表示して失敗にする。
行が壊れているときは、回復の手順を表示する。
`target`、`reason`、`holder`は、制御文字と書式文字を空白にして表示する。
行の文字列を信用せず、表示で一覧の行を偽装させないためである。
凍結の件数は、`wmill`を使えないときは警告にとどめる。
`list`と`place`は、保留が止める経路の説明を表示する。

置く主体は、環境変数`CLAUDECODE`で分ける。
あれば`session`で、`holder`は`session:<ブランチ>`になる。
無ければ`human`である。
`human`の置く操作と解除は、端末で`yes`を入力して確かめる。
`session`(`CLAUDECODE`があるClaude Codeのセッション)は、確認なしで置ける。
`session`は、自分の`holder`の保留だけ解除できる。
この区別は誤操作を防ぐためのもので、権限の境界ではない。
迂回のための環境変数は設けない。

`place`が受け付ける範囲は、読み手のある`merge`だけである。
読み手の無い`claim`は、DBを読み書きする前に拒否する。
置いても何も止まらず、守られていると誤解させるためである。
`list`と`release`は、両方の範囲を扱う。

### psqlの経路

`scripts/hold_psql.ts`が、`holds.ts`の関数に渡す接続を作る。
接続先のデータベースは、呼び出し側が必ず渡す。
CLIは本番のデータベースを渡し、実DBの検査は使い捨てのデータベースだけを渡す。

- composeのDBのコンテナで`psql`を起動し、文を標準入力で渡す。
  `-c`で渡すと変数が展開されないためである。
- 値は文にも埋め込まない。
  文字列と数値はpsqlの変数に渡し、文には`:'pN'`を書く。
  psqlが引用符つきの文字列にするので、引用符、バックスラッシュ、`:name`を含む値もそのまま束縛される。
  `null`は`NULL`と直接書く。
  変数の番号は、値の位置である。
  NULを含む文字列と、文字列と数値以外の値は、例外にする。
- 読み取りは`default_transaction_read_only=on`で接続する。
  書き込みの文は、セッションの設定で拒否される。
- 文の時間は10秒、書き込みのロックの待ちは5秒、1回の呼び出し全体は20秒に上限を置く。
- `fetch()`は、文を`WITH q AS (...) SELECT json_agg(...)`で包み、結果を1つのJSONで読む。
  行は`id`の列を持つ。
  `execute()`は包まない。
- 文ごとに別のプロセスを起動し、`BEGIN`も付けない。
  `placeHold`の2つの文は、文ごとの自動コミットを前提にするためである。
- 終了コードが0でなければ、標準エラーの先頭200字を、制御文字を空白にして、例外の文に載せる。
  `holds.ts`が`read_failed`か`missing_table`に分類する。

書き込みが全体の上限を超えたときは、結果が不明である。
強制終了で止まるのはdockerのクライアントだけで、コンテナの中のpsqlは止まらない。
`hold:list`で確かめる。
値はプロセスの引数に現れるので、`reason`と`holder`に秘密を書かない。

## ローカルのセッションのフック

`scripts/claude-hooks/merge-guard.ts`が、ローカルのセッションのBashのコマンドを、実行の前に判定する。
マージと反映を、保留と凍結が有効な間は止めるためである。
`.claude/settings.json`が、`bash-guard`とは別の項目として登録する。
2つのフックは並行して動き、どちらかが拒否すれば止まる。
判定は主セッションとsubagentで同じで、拒否の文だけが違う。
操作の見つけ方は`merge-targets.ts`、保留と凍結の読み方は`merge-read.ts`にある。

### 止める操作

`gh`の判定は、安全と確かめられた形だけを対象外にし、それ以外はマージとして扱う。
綴りを列挙してマージを見つける方式は、列挙に無い綴りで破られるためである。
マージとして扱っても、止まるのは保留が有効なときと、保留を読めないときだけである。

| 操作 | 止める条件 |
| --- | --- |
| `gh pr`のうち、対象外の形以外 | `merge`はリポジトリが決まれば、そのリポジトリのマージの保留が有効なとき。決まらないものと`merge`以外は、どのリポジトリでもマージの保留が有効なとき |
| `gh api`のうち、対象外の形以外 | パスから`repos/<owner>/<repo>/`が決まれば、そのリポジトリの保留。決まらなければ、どのリポジトリでも |
| 語に`merge`を含む`gh alias set`と`gh alias import` | どのリポジトリでもマージの保留が有効 |
| `xargs`の後ろの`gh pr`、`gh api`、`gh alias`、`wmill` | `gh`はどのリポジトリでもマージの保留が有効。`wmill`は反映の保留かスケジュールの凍結が有効 |
| `wmill sync push`(`--dry-run`を除く) | deployの保留かスケジュールの凍結が有効 |
| `wmill datatable migrate up`と`migrate down` | deployの保留が有効 |

`gh`のグループの前にオプションがあると、cobraは知らないオプションを値を取るものとして読みうる。
`--help`と`--version`以外のオプションがグループの前にあれば、マージとして扱う(`gh -R o/r pr merge 1`、`gh -X PUT api ...`)。
`gh pr`のサブコマンドの前にも、`-R`と`--repo`と`--help`以外のオプションがあれば、マージとして扱う。

`gh pr`が対象外になるのは、サブコマンドが文字どおり次のどれかのときである。
`view`、`list`、`checks`、`create`、`diff`、`comment`、`status`、`edit`、`ready`、`review`である。
`checkout`、`reopen`、`close`、`lock`、`unlock`と、別名の`co`、`ls`、`new`も対象外である。
`merge`は、値を持たない`--help`と`-h`、`--auto`の無い値を持たない`--disable-auto`のときだけ対象外になる。
`--help=false`や`--disable-auto=0`のように値を付けた形は、有効にするとは限らないので、マージとして扱う。
サブコマンドが実行時に決まる、または上記以外(`merge`を含む)なら、マージとして扱う。

`gh api`が対象外になるのは、次の条件をすべて満たすときである。

- メソッドが文字どおりのGETか、指定が無い。
- 本文を送る指定(`--input`、メソッドを指定しない`-f`と`-F`)が無い。
- エンドポイントが`graphql`でない。

GETではPRをマージできないので、パスに`merge`を含んでも対象外にする。
メソッドが実行時に決まる場合は、マージとして扱う。
エンドポイントは、スキームとホスト、先頭と末尾の`/`、クエリ、GHESの`api/v3/`を外した形で見る。
`..`を含むパスは、リポジトリを決めない。
GraphQLは、queryが文字どおりで、`mutation`の語を含まないと確かめられたときだけ対象外になる。
`mergeBranch`や`updateRef`のような、マージを要求する3つのmutation以外の書き込みも、この規則で覆う。
次のqueryは、マージとして扱う。

- queryが無い。
- 実行時に決まる。
- ファイルから読む。
- `--input`で渡す。

コメントの投稿などの書き込みのメソッドも、保留が有効な間は止まる。
安全側に倒すので、止めすぎは受け入れる。

オプションの値は、読み飛ばしてから判定する。
短いオプションは、pflagと同じに読む。
束ねた文字(`-dR o/held`、`-iXPUT`)は、1文字ずつ見る。
値を取る文字に当たったら、その後ろを値にする。
後ろが空なら次の語が値で、先頭の`=`は落とす(`-X=PUT`)。
値を取らない文字にも`=値`を付けられる(`-h=false`)。
`gh pr merge 1 --body --disable-auto`では、`--disable-auto`は本文の値なので、マージとして扱う。
`wmill sync push -i --dry-run`では、`--dry-run`は`-i`の値なので、pushとして扱う。
`wmill`で値を取るオプションは、次のとおりである。

- 短い形: `-i`、`-e`
- 長い形(絞り込み): `--includes`、`--excludes`、`--extra-includes`
- 長い形(接続): `--workspace`、`--token`、`--base-url`、`--config-dir`、`--env`、`--branch`
- 長い形(そのほか): `--message`、`--parallel`、`--repository`、`--datatable`

`--dry-run=false`のように値を付けた形は、`--dry-run`とみなさず、対象にする。
`wmill workspace merge`(別名`profile merge`)は、反映として扱う。
`mise run push`のようなラッパーは対象にしない。
ラッパーの中で、凍結の入口(`scripts/freeze.ts`)が止める。

コマンド行は、字句に分けてから見る。
`sh -c`、`eval`、`$(...)`、`env`、`timeout`、`xargs`、`mise exec --`、絶対パスは外して判定する。
前置きの短いオプションは、getoptと同じに読む。値を取る最初の文字から後ろが値で、後ろが空なら次の語が値である。
`env -P`、`xargs -J`、`-R`、`-S`、`--max-args`のような値を取るオプションも読み飛ばす。
前置きを外し切れなかったとき、残った語に`gh`か`wmill`があれば(`gh pr merge 1`が1語の場合を含む)、リポジトリを決めないマージか反映として扱う。
`env -S`の文字列は、`env`と同じ規則で分ける。空白と引用符で分け、`;`、`|`、`&`、`(`は演算子とせず語の一部にする。
文字列が実行時に決まる、引用符が閉じない、知らない逃れを含むときは、読めないものとして扱う。
読めない`env -S`は、`bash-guard`が拒否し、`merge-guard`はマージと反映のすべてとして扱う。
標準入力でシェルに渡す文字列(`echo '...' | sh`、ヒアドキュメント)は、深さ4まで読み直す。
字句に分けられないコマンド行は、何も見つけない。`bash-guard`が拒否するためである。
実行する名前や、`gh`のグループとサブコマンドが実行時に決まる語は、マージとして扱う。

### 対象のリポジトリ

`--repo`、`-R`、前置きの`GH_REPO`、PRのURL、`gh api`のパスの`repos/<owner>/<repo>/`を、すべて集める。
値は、末尾の`owner/repo`を小文字にし、`.git`を落として、保留の対象の形に合わせる。
候補が1つに決まるときだけ、そのリポジトリの保留と照合する。

次のときは、リポジトリが決まらないものとして扱い、有効なマージの保留が1件でもあれば止める。

- 候補が無い(`gh pr merge 123`)。
- 候補の値が食い違う(`--repo`の繰り返し、URLと`--repo`)。
- 値が`owner/repo`の形に合わない、置換記号(`{owner}`)を含む、実行時に決まる。
- PRを指す位置の語が実行時に決まる。その語がURLの可能性があるためである。

回避は、`--repo <owner>/<repo>`を文字どおり書くことである。
他のリポジトリの保留でも止まるのは、安全側に倒すためである。

### 読み方

対象の操作に当たったときだけ、読みの部品(`merge-read.ts`)を動的に読み込む。
対象外のコマンドは、解析だけで許可する。DBを読まず、変数も読まない。

- マージの保留は、全件(`scope`が`merge`の有効な行)を1回で読み、リポジトリの照合はメモリ上で行う。
  `listActiveHolds`を、読み取り専用の接続(`default_transaction_read_only=on`)で呼ぶ。
- deployの保留とスケジュールの凍結は、変数`f/factory/freezes`を`wmill variable get`で読む。
- 読みは子プロセスで行い、`mise exec -C <リポジトリの根> --`で包む。
  composeが`mise`の環境変数を要し、`wmill`も`mise`のツールのためである。
  `mise`は、PATH、`/opt/homebrew/bin`、`$HOME/.local/bin`、`/usr/local/bin`の順に探す。
- 子の環境では、`mise`のツールの自動インストールを止める(`MISE_AUTO_INSTALL=0`など)。
  読みのためにネットワークへ出ず、入っていないツールは「コマンドが見つからない」の失敗になる。
- 子は新しいプロセスグループで起動する。
  読みの上限は6秒で、上限に達したらプロセスグループごと終了する。
  `mise`や`docker`の孫が標準出力を握り続けても、結果は子の終了かタイマーで決める。
- フック自身にも6.5秒の上限があり、超えたら拒否する。
  判定を書き出したら、残った待ちを待たずにプロセスを終了する。
- 子の標準エラーは、秘密値を伏せてから使う。
- マージの保留と凍結の両方に当たるコマンド行は、並行して読む。
- 結果は保存しない。保留は置いた直後に効かせるためである。

### 読めないとき

読めないときは、すべて拒否する。
次の場合が当たる。

- 表が無い。
- 行が壊れている。
- `mise`か`docker`が無い。
- 子プロセスが非ゼロで終わる。
- 時間切れになる。
- 読みの処理が例外を投げる。
「保留なし」と取り違えると、保留を置いた意味が外れるためである。

クラウドのセッションには`mise`と`docker`が無く、保留を読めない。
そのため、マージ系と反映系のコマンドは拒否になる。
ただし、`bun`か24以上の`node`が無い環境では、起動スクリプトが警告を出して通す。

### 拒否の文

文に載せるのは、保留のid、検証した対象、期限(日本時間)、置いた主体の種類だけである。
`reason`と`holder`は、DBに書ける主体が決める文字列なので載せない。
対象は`owner/repo`の形に合うときだけ載せ、合わなければ`<invalid target>`にして、長さを切る。
読めない理由は、制御文字を空白にして200字までにする。

主セッションの文は、`mise run hold:list`で確かめることと、人に尋ねることを示す。
subagentの文は、マージと反映をしないと伝える。主セッションへの報告で終えるよう促す。
どちらの文にも、保留の解除の手順は載せない。
止められたエージェントに迂回を勧めないためである。
解除の手順は、[保留のスキル](../../.claude/skills/hold/SKILL.md)に置く。

deployの保留の文は、期限まで待つか、置いた人に頼むことと、`mise run freeze:list`を示す。
スケジュールの凍結だけが有効なときの`wmill sync push`は、除外を付ける`mise run push`を案内する。

### 限界

判定は語の字面で見る。ベストエフォートの規則で、境界ではない。
次は追わない。

- 別名や関数、変数や連結で組んだ語、スクリプトのファイルの中の呼び出し。
- `curl`、`python`、`hub`、GitHubのMCPによるマージ。
- GraphQLの`mergeBranch`。
- `find -exec`、`parallel`、`watch`の後ろに書いたコマンド。`xargs`は追う。
- `bunx wmill`、`npx wmill`、`wmill script push`などの個別のpush、`wmill schedule enable`。
- 保留を置く前から有効だった自動マージ。

迂回のための環境変数は設けない。
残るリスクは[セキュリティ](../security.md)の「保留」に書く。

## subagentの拒否

`scripts/claude-hooks/hold-guard.ts`が、subagentの保留の操作を拒否する。
`bash-guard`が、subagentのBashのコマンドだけに適用する。
主セッションと人は、止められない。
許すのは一覧(`list`)だけである。
subagentが保留を置くと、確認する相手がいないまま、自動マージを止められるためである。
凍結のCLIのうち、deployの保留を置く操作(`--scope deploy`)と、凍結の解除(`release`)も同じ規則で拒否する。
`--scope`の値が実行時に決まる形は、`deploy`かを判定できないので拒否する。
凍結のCLIを指す語の直後の`--`は読み飛ばし、globは凍結のファイル名に当たりうれば拒否する。
`-e`の直後の文字列と標準入力のコードに、凍結のCLIと`release`か`deploy`が書かれていても拒否する。
`bun test -t "deploy freeze"`のように、コードでない引数の文字列は読まない。
実行系の標準入力へ流し込むファイル(`bun run - < scripts/hold.ts`)が、保留か凍結のコードなら拒否する。
パイプ、ヒアストリング、プロセス置換で流し込む形も、入力元が保留か凍結のコードか、読めないものなら拒否する。
パイプの前の`cat`が標準入力から保留か凍結のコードを読む形も同じである。

拒否を既定にする。
コマンドの語には、値を取るオプションや実行の前置きが混ざる。
値を取るオプションの一覧を読み飛ばす方式は、一覧に無いオプションで破られるためである。
保留のコードを指す語を含む呼び出しは、次の許可に当たらない限り拒否する。

- `bun`、`bunx`、`node`、`tsx`、`ts-node`、`deno`、`npx`、`npm`、`pnpm`、`pnpx`、`yarn`と、スクリプトの直接の実行。
  語のどれかが、保留のコード(`hold`、`hold_psql`、`holds`)を指していれば拒否する。
  拡張子は省ける。`bun`が拡張子の無いパスを`hold.ts`に解決することを、実機で確かめてある。
  引用符の外のglobと文字クラス(`scripts/hol?.ts`、`scripts/hol[d].ts`、`scripts/*`)は、ファイル名の部分が保留のコードの名前に当たりうれば拒否する。
  ディレクトリは見ない。`scripts//hol?.ts`や`scripts/./hol?.ts`のように、ディレクトリの書き方が揺れても同じである。
  `[:lower:]`、`[=o=]`、`[.o.]`のようなPOSIXの文字クラスは、括弧の中のどこにあっても読み解かず、当たりうるものとして拒否する。
  語の途中の`(`は、zshでは引数のglobのまとまり(`(ho)ld.ts`)になりうるので、構文エラーとして拒否する。
  配列の代入、関数の定義、プロセス置換、制御語だけが前にある括弧は、拒否しない。
  `{hold.ts,place}`のようなブレースは、展開した綴りと、`{`、`}`、`,`を空白にした綴りの両方で判定する。
  `-e`などの文字列と、標準入力で渡すコードに含まれる場合も同じである。
  `bun exec '<文字列>'`は、文字列をシェルの入力として読み、中のコマンドも判定する。
  `$'...'`の中の`\x64`、`\144`、`\u0064`は、文字に展開してから判定する。
  `$'...'`の中のNULは、bashと同じに、閉じの引用符までを捨てる。切り詰めない綴りも、別の綴りとして判定する。
  `$"..."`は、ふつうの二重引用符として読む。
  zshの`=bun`のように`=`で始まるコマンドは、`=`を外した名前として読む。
- `mise`: 全体オプション(`-q`、`-C <dir>`、`--cd=<dir>`、`-E <env>`など)を読み飛ばして、サブコマンドを見る。
  実行系のサブコマンド(`run`、`r`、`tasks run`、`watch`、`w`、`exec`、`x`)かタスク名(`mise hold:place`)がある呼び出しを調べる。
  その呼び出しに、`hold:place`か`hold:release`を指しうる語が1つでもあれば、位置を問わず拒否する。
  `hold:`で始まる`hold:list`以外の語、globや文字クラスが当たる語(`hold:[pr]*`、`h[o]ld:place`)、実行時に決まる語、ブレースを含む語が当たる。
  `mise tasks info hold:place`のような、実行しないサブコマンドは拒否しない。
  `--`より後ろはタスクへの引数なので、globと実行時に決まる語は見ない。`hold:`で名指しする語だけ見る。
  この版のmiseは、`--`より後ろの`:::`をタスクの区切りとして実行しない。実測で確かめた。
  実行時に決まる語で拒否したときは、拒否の文にその原因を示す。
  `mise -q exec -- bun scripts/hold.ts place`のように、全体オプションを前に置いた`mise exec`は、内側のコマンドとして判定する。
  全体オプションの一覧は、値を取るもの(`-C`、`-E`、`-j`、`-P`、`-s`、`-t`、`--log-level`、`--output`など)と、値を取らない長いものを持つ。
  束の中で最初に値を取る文字が末尾でなければ、後ろの文字は値の一部である(`-EC`は`-E`が値`C`を取る)。
  一覧に無い長いオプション(`=`の無いもの)があると、サブコマンドの位置が決まらないので、`mise`のコマンド全体を拒否する。
  `exec`か`x`が語にあれば、位置を問わず、その後ろの語を実行系のコマンドとして判定する。
- `docker`、`docker-compose`、`psql`で、語か標準入力の文字列に`holds`を含むもの。
  ヒアドキュメントと、パイプの前の`echo`や`printf`も見る。

許可は次の2つだけである。

1. 保留のコードを指す語の直後の語が`list`である。
2. 最初のオペランドが検査の道具(`test`、`biome`、`@biomejs/biome`、`tsc`、`scripts/lint-*.ts`)である。
   `@biomejs/biome@1.9.4`のような版付きの名前と、`npx --yes`や`-y`の後ろも、同じに扱う。
   `bunx biome check scripts/hold.ts`は、実行ではなく検査なので止めない。

止められない形は、残るリスクとして受け入れる。
境界ではなく、誤操作と、拒否を知らない呼び出しを止める補助である。
詳しくは[セキュリティ](../security.md)の「保留」に書く。

- 別名の呼び出し(`cp scripts/hold.ts /tmp/h.ts`の後に実行する形)。
- 変数や文字列の連結で組んだパス、動的なimport。
- `docker compose exec db psql`に渡す語を組み立てて書く形。
- subagentが新しいファイルを書いて実行する形。
- コマンドを起動する前置き(`find -exec`、`watch`、`parallel`、`ssh`、`/usr/bin/time`、`caffeinate`など)の後ろに実行系を置く形。
- 実行系以外が文字列で受け取るコード(`python -c`、`perl -e`など)。
  `mise-tasks/`と`.mise-tasks/`は保護パスだが、止めるのはFactoryのpr_fixとimplementのフローだけである。
  ローカルのsubagentには効かない。

BashとDockerを持つ主体は、psqlで保留を直接書ける。

### 全セッションの拒否

Consoleの解除scriptを1コマンドで呼ぶ形は、subagentだけでなく、主セッションを含むすべてのセッションで拒否する。
subagentの拒否と違い、`bash-guard`は、セッションの種類で分けずに`findConsoleReleaseCall`を適用する。
解除scriptの名前を軸にして、拒否を既定にする。
プログラムは問わない。次のどれかに、名前、名前に当たりうるglob、ブレースの形があれば拒否する。

- コマンドの語
- 変数代入の値
- 標準入力の文字列(ヒアドキュメント、ヒアストリング、パイプの連鎖の`echo`と`printf`)
- 読み取りのプログラム以外の前にある、パイプの上流の語

`npx windmill-cli`、`bunx windmill-cli`、`bun x`、`pnpm dlx`、`deno run npm:`のような実行系の包み方も、名前で止まる。
シェルは、`-c`の直後の文字列を再帰で別に調べ、それ以外の語を名前に当てる。

読み取りのプログラム(`git`、`gh`、`grep`、`rg`、`cat`、`wc`など)と、検査の道具(`bun test`、`bunx biome`、`mise run`)は、名前だけでは拒否しない。
次のときは拒否する。

- 同じコマンドに実行を表す語(`wmill`、`curl`、`npx`、`bun`、`sh`など)が並ぶ。
- 実行を委ねるオプション(`git -c`、`git rebase`、`gh alias set`、`rg --pre`)がある。
- 変数代入の値に名前がある。
`sed`、`bat`、`ag`は、名前がファイルのパスの形の語にあるときだけ通す。
`awk`は拒否する。名前を含む検索は、`grep`、`rg`、Readツールを使う。

`wmill`は、解除scriptを実行せずに読む・配る副コマンド(`script get`、`script push`、`job list`、`job history`など)を通す。
名前が語に現れない`wmill jobs push`は拒否する。

凍結の変数`f/factory/freezes`を書く形も拒否する。
`wmill variable add`と`wmill variable push`が対象である。
変数を書くURL(`/variables/update`、`/variables/create`、`/variables/delete`)を呼ぶ形も対象である。
URLの経路と変数のパスのglobも当てる。

ソースは、Readツールか`git show`で読む。
パイプの上流の語にある名前は、`wmill`、実行するプログラム、`xargs`が受ける読み取りのプログラムに当てる。
下流に名前がある読み取り(`wmill job list ... | grep hold_release`)は通す。
ベストエフォートで、ハッシュでの呼び出し(`run_wait_result/h/<hash>`)、パーセント符号化したパス、変数やファイルで組み立てた名前は止められない。
名前をシェルの変数に束ねる形(`for`、`select`、`printf -v`、`$_`)も、同じ類として止めない。
`for`と`select`を止めると、正規のループも止まるためである。

## 参照の禁止

`f/`とmigrationの中で、`holds.ts`の外に、表の名前(`factory.holds`)を直接書かない。
書き込みと読み取りは、`holds.ts`の関数を通す。
有効の条件(24時間の上限など)と書き込みの制限を、`holds.ts`に集めるためである。
保留を読む処理は、`holds.ts`の関数を使う。

この決まりを守らせる仕組みは無く、参照の混入を検出するテストがある。
Windmillのscriptはすべて同じdatatableの接続を持つので、検出をすり抜けるコードは表を読み書きできる。
決まりの範囲も限られる。
許可した読み取りの関数(`listActiveHolds`)は、呼び出し側から`sql`を受け取る。
呼び出し側が`strings`を書き換えた接続を渡す迂回は、止めない。
`f/`の外のコード(ローカルのフックなど)は、走査の対象にならない。
`scripts/hold.ts`と`scripts/hold_psql.ts`は、表の名前を書かない。
`hold_wiring.test.ts`が、この2つに表の名前が無いことを固定する。

実行時に`holds.ts`を読み込んでよい`f/`のファイルは、次の3つの分類に挙げたものだけである。
どの分類も、読み込む名前が一覧と一致することを、配線テストが固定する。型は読み込みに数えない。

| 分類 | テストの定数 | ファイル | 読み込む名前 | 意味 |
| --- | --- | --- | --- | --- |
| 止める読み手 | `HOLD_READERS` | `poll_dependabot.ts`、`dependabot_finish.ts` | `listActiveHolds` | 読んで止まる |
| 表示の読み手 | `HOLD_VIEWERS` | `console_holds.ts` | `listActiveHolds` | 人に見せるだけで、何も止めない |
| 解除の書き手 | `HOLD_RELEASERS` | `hold_release.ts` | `listActiveHolds`、`releaseHold` | 人の操作で解除する |

読み込む名前を足すときは、テストの該当する定数に足す。
`releaseHold`を読み込んでよいのは、解除の書き手だけである。
`placeHold`を読み込む`f/`のファイルは無く、解除の書き手が読み込まないことも名前の一致で固定する。
解除の書き手のファイルは、すべて保護パスに入れる(下の「追加の守り」)。
ローカルのフックの読みの部品(`scripts/claude-hooks/merge-read.ts`)は`f/`の外にあるので、この一覧に入れない。
配線テストの別の検査が、`listActiveHolds`だけを読み込むこと、書く関数と書き込みの接続を使わないこと、データベース名を定数から取ることを固定する。

解除scriptの名前(`hold_release`と`freeze_release`)は、各scriptの`.ts`、`.script.yaml`、`.lock`のほかの、`f/`のどのファイルにも書かない。
`.lock`とflowの定義を含めて走査する。
書くと、自動のコードから解除scriptを起動できるためである。
保護パスの一覧(`protected_paths.ts`)だけは、パスの文字列を並べるだけなので、走査から外す。
通知の種類`hold_released`は、語の前後が英数字と`_`でない場合だけを名前として数えるので、当たらない。
`console/src/`では、許可リストと型付きの書き込みと戻りの型ガードのファイルだけに、この名前が出る。
名前を組み立てる形は検出できない。

書く関数(`placeHold`、`releaseHold`)は、`sql`に既定値を持たない。
これは呼び出し側に接続を選ばせるためで、参照は止めない。

`tests/scripts/hold_wiring.test.ts`は、次の参照を検出する。
`holds.ts`と、表を作る2本のmigrationでは認める。
この3つは走査から外すので、保護パスに入れる。

- `factory.holds`の名前。
  間に空白、SQLのコメント(入れ子のブロックコメントと行コメント)、引用符があってもよい。
  `datatable_db.factory.holds`のような3部の名前は、最後の2部で判定する。
- `holds_`で始まるインデックス、制約、シーケンスの名前。
  `key`、`idx`、`check`、`pkey`、`fkey`、`excl`、`seq`で終わる名前に限る(`holds_active_merge_key`、`holds_pkey`など)。
- `search_path`と`SET SCHEMA`。
  `SET SCHEMA`は`LOCAL`や`SESSION`を付けても、`SET search_path TO`の別名である。
- `DROP SCHEMA factory`と`ALTER SCHEMA factory`。
  表ごと消えるためである。
  スキーマの数に上限を設けず、文の終わりまで読む。
  初期のmigrationのdownにある`DROP SCHEMA IF EXISTS factory CASCADE`の1文(1件だけ)は認める。
- `DROP OWNED BY`と`DROP DATABASE`。
  どちらも表を消せるためである。
- `datatable`の名前が`:factory`で終わる指定(`wmill.datatable("main:factory")`など)。
  windmill-clientは、スキーマ部があると実行時に`SET search_path`を足す。
  そのため、ソースに`search_path`と`factory.holds`が現れずに、スキーマの付かない名前で書ける。
- 動詞の直後の、スキーマの付かない`holds`。
  対象の動詞は、`INSERT INTO`、`UPDATE`、`DELETE FROM`、`TRUNCATE`、`MERGE INTO`、`ALTER TABLE`、`DROP TABLE`、`COPY`である。

最後の規則は、動詞の位置から先を読み、`holds`の後ろにSQLの構造が続くときだけ当てる。
`UPDATE`は`SET`、`COPY`は`FROM`、`TO`、`(`のどれか、`INSERT INTO`は列または`VALUES`、`MERGE INTO`は`USING`が要る。
`DELETE FROM`、`TRUNCATE`、`DROP TABLE`は、文字列の終わりで終わる形も当てる。
`holds`単独の語や、構造の続かない英文(`could not update holds`、`copy holds`)は数えない。

検出する範囲は次のとおりである。

- `f/`のすべてのファイル(`holds.ts`を除く)。
  `.lock`も含む。
  flowの`content`が`!inline`で任意のファイルを指せるので、`.lock`をscriptの本文として参照させる経路がありうるためである。
  TypeScriptは`Bun.Transpiler`で変換したコードを読み、JavaScriptのコメントは消える。
  SQL、シェル、Python、YAMLなど、ほかの形式は生のテキストを読む。
- `migrations/datatable/main/`の、表を作る2本以外。
- 同じ範囲で、`holds.ts`以外が、読み取りの2つの関数と型のほかを読み込むこと。
  名前空間の読み込み、再export、動的な読み込み、`.js`など拡張子違いの指定、絶対パスの指定も検出する。

読み方は次のとおりである。
`factory`と動詞などの目印の出現位置ごとに、その位置から先の数トークンをSQLの字句で読む。
空白、行コメント、入れ子のブロックコメント、引用符を読み飛ばす。
起点を出現位置に固定するので、手前にある別の字句の`/*`や引用符に引きずられない。
行コメントの終わりは、実際の改行だけの読みと、JavaScriptの文字列の改行のエスケープも含む読みの両方で評価し、どちらかで当たれば検出とする。

英文のログは、`factory.holds`を含まなければ当たらない。
`factory.holds`を含む文字列は、英文でも当たる。誤検知を許して、見逃しを減らすためである。
次のような、表の名前を書くだけの文字列も当たる。

- 後のmigrationのSQLコメント(`-- 保留(factory.holds)とは別の表`)
- `COMMENT ON ... IS 'see factory.holds'`
- `.script.yaml`の`description`
- TypeScriptのログ文字列

誤検知の規則を直すには、テストが保護パスなので、保護パスの変更としてPRを出す。
当たったときの診断は、ファイル、変換する前のソースの行番号、前後の抜粋を示す。

検出するのは文字列の形だけで、見つけられない入力がある。
次は例であり、すべてではない。

- 文字列の連結で名前を組み立てるコード
- `${}`で名前を組み立てるテンプレート(`factory.${"holds"}`など)
- 名前をJavaScriptの文字列のエスケープ(`\u0066actory`など)で書くコード
- migrationの動的SQL。
  `EXECUTE format('DELETE FROM %I.%I', 'factory', 'holds')`、`EXECUTE 'DELETE FROM factory.' || 'holds'`、カタログを引くループで名前を作る形がある。
  `search_path`やスキーマ無しの`holds`の規則も、動的SQLでは塞げない。
- `search_path`の語を分ける形。
  `PGOPTIONS=-csearch_path=factory`(語の境界に当たらない)や、`set_config('search_'||'path', ...)`がある。
- 保留のモジュールの名前を組み立てるimport
- `f/`とmigrationの外のコード(`scripts/`など)

datatableの接続の既定の`search_path`には`factory`が入っていない([実機での確認](#実機での確認))。
入っていれば、スキーマの付かない`holds`が、`datatable`の名前の指定なしで`factory.holds`を指す。
上の動詞の規則は、その場合も働く。

接続の`role`(windmill-clientの`datatable(name, { role })`、1.817.0)は、Windmillの文書がEnterprise Editionの機能と書いている。
このリポジトリはCommunity Editionなので、DBの層で書き手を分離する設計はしない。

表の定義を変えるmigration(scopeを広げるなど)は、表を作るmigrationと並べて、テストの`HOLDS_MIGRATION_FILES`に足す。
これは保護パスの変更として出す。

追加の守りは次のとおりである。

- `holds.ts`とそのテスト、実DBの検査、CLIとpsqlの経路とそのテストは、保護パス(`f/factory/lib/protected_paths.ts`)に入れる。
  CLIが実行時に読み込む`scripts/freeze.ts`、`lib/freezes.ts`、`lib/freeze_apply.ts`も入れる。
  書き換えられると、CLIの実行に任意の処理を足せるためである。
  拒否のフックの`scripts/claude-hooks/`とそのテスト、miseのタスクのディレクトリ(`mise-tasks/`と`.mise-tasks/`)も入れる。
  置いたファイルがタスクとして実行されるので、拒否の外から保留を操作できるためである。
- Consoleの解除scriptとその部品(`hold_release.ts`、`freeze_release.ts`、`lib/console_holds_support.ts`)と、そのテストも入れる。
  書き換えられると、他の主体の保留を無条件に外せるためである。
- Consoleの置くscript(`console_hold_place.ts`)とscheduleを止めるscript(`console_schedule_stop.ts`)と、そのテストも入れる。
  書き換えられると、置ける期限の上限が外れたり、止めてはならないscheduleを止められたりするためである。
  読み取りだけの`console_holds.ts`は入れない。置く操作を持たず、読み込める名前を配線テストが固定する。
- 実DBの検査が使う`scripts/test-db-sql.ts`は守らない。
  ほかの実DBの検査も使う部品で、守ると日常の変更を止めるためである。
- `holds.ts`は何もimportしない。
  接続の型(`HoldSqlClient`)も自前で持つ。
  保護の外のモジュールに、判定が依存しないようにするためである。
- `holds.ts`は`main`をエクスポートしない。
  `runScriptByPath`やフローの`path:`から直接実行する経路を作らないためである。

## 反映の順序

`self_update`は、`wmill sync push`の後に`wmill datatable migrate up`を走らせる。
そのため、新しいコードが先に反映され、表の無い時間ができる。
読み取りは、表が無いことを`missing_table`として返し、「保留なし」と扱わない。
migrationが失敗すると、`self_update`は次の回で再試行する。

保留を読む処理を足すPRは、表を作るmigrationの反映が済んでからマージする。
反映済みかは、`f/factory/deployed_sha`が、表を作るmigrationのコミット以降かで確かめる。
先にマージすると、読む処理が表の無い間に`missing_table`を受け、保留の有無を判定できないためである。

## 検査

| 検査 | 確かめること |
| --- | --- |
| `tests/lib/holds.test.ts` | 有効の判定、入力の検証、解除の権限、行の解析、表が無いことの判定、表示の無害化 |
| `tests/lib/holds_db.test.ts` | 偽の接続で、読み取りの失敗の種類、置く操作の2つの文と入力の検証、解除、接続の型の互換 |
| `tests/scripts/hold_psql.test.ts` | psqlの引数、値の束縛、読み書きのモード、接続先、時間切れ、失敗の文 |
| `tests/scripts/hold.test.ts` | 引数、主体、`claim`の拒否、一覧と置く操作と解除、表示の無害化、CLIの接続先 |
| `tests/scripts/dependabot_finish.test.ts`、`tests/scripts/poll_dependabot.test.ts` | 保留があるとき、読めないときに、マージせず作業項目も作らないこと。読む位置。読めない通知の解決 |
| `tests/scripts/claude-hooks/bash-guard.test.ts` | subagentの拒否と許可の形、主セッションを止めないこと、主セッションを含む全セッションでConsoleの解除scriptの呼び出しを拒否し、検査やビルドなどの近い作業を許すこと |
| `tests/scripts/claude-hooks/merge-targets.test.ts` | マージと反映の操作の見つけ方、リポジトリの候補の集め方と食い違い、入れ子のシェル、見つけない形 |
| `tests/scripts/claude-hooks/merge-read.test.ts` | 読みの子プロセスの起動の形、失敗の種類、時間切れとプロセスグループの終了、`mise`の探索、子の環境、凍結の変数の読み方 |
| `tests/scripts/claude-hooks/merge-guard.test.ts` | 判定、リポジトリの照合、読めないときの拒否、時間切れ、主セッションとsubagentの文言、敵対的な文字列を載せないこと |
| `tests/scripts/claude-hooks/merge-guard-process.test.ts` | 実プロセスのフックが、偽の`mise`で保留を読んで拒否と許可を返すこと。孫が出力を握っても期限内に拒否すること。nodeで動くこと |
| `tests/scripts/hold_wiring.test.ts` | 表への参照の混入、読む処理と表示の読み手と解除の書き手の名前、解除の書き手が保護パスであること、解除scriptの名前が`f/`のほかに無いこと、マージを要求するファイル、CLIが表の名前を持たないこと、フックの読みの部品が読み取りだけであること、miseのタスク、`test-db.sh`が実DBの検査を呼ぶ位置 |
| `tests/scripts/console_holds.test.ts`、`hold_release.test.ts`、`freeze_release.test.ts` | Consoleの読み取りの失敗の分離と無害化、解除の主体と操作者、固定の理由と`holds.ts`の出力の一致、通知と通知の失敗、凍結の書いた後の読み直し |
| `tests/scripts/console_holds_contract.test.ts` | Consoleの型ガードがbackendの戻りを通ること、ラベルがbackendの値を漏らさないこと |
| `scripts/test-db-holds.ts` | `mise run test:db`が流す。制約、部分一意インデックス、置く操作のSQLを本物のPostgreSQLで確かめる。psqlの経路で値の束縛と読み取り専用の接続も確かめる |

実DBの検査のうち、制約と文の検査は、値を定数として埋め込む検査用のクライアントで流す。
CLIの経路は、`hold_psql.ts`に使い捨てのデータベースを渡して流す。
本番のデータベースには書かない。
どちらも、`wmill.datatable()`の束縛の経路は通らない。

## 実機での確認

Consoleからの解除の確認は、人が行う。
ログイン済みのブラウザの自動操作は、Bashのフックの外で解除のボタンを押せるためである。
実装した主体は、解除scriptの確認をテストの偽で代える。
ローカルのスタックの`wmill script run`はフックが拒否するので、人の端末で行う。

人の確認の手順は、次のとおりである。

1. `mise run hold:place`で、使い捨ての対象と短い期限の保留を置く。
2. Consoleのシステムの画面に、置いた保留が出ることを確かめる。
3. 「解除」を押し、確認のダイアログの内容を読んで確かめる。
4. 解除すると、`mise run hold:list`から消え、`released_by`が`human`になり、情報の通知`hold_released`が出る。
5. 同じidをもう一度解除すると、「すでに解除されています」になり、通知は増えない。
6. 凍結は、`mise run freeze:place`でスケジュールの凍結を置き、同じ手順で確かめる。deployの保留は、反映の直後に短い期限で試す。
7. セッションが置いた保留を、人として解除できることを確かめる。

外部の挙動に依存する前提の確認の結果である。
確認は、mainの`9dae4761`を反映したローカルのスタックで行った。
`wmill.datatable()`の確認は、稼働中のWindmillのワークスペースで、保留を1行置いて解除する使い捨てのスクリプトを流して行った。

| 前提 | 結果 |
| --- | --- |
| psqlの標準入力、`:'name'`の展開、`-X`、`ON_ERROR_STOP`、`docker compose exec -e PGOPTIONS`、読み取り専用の接続、終了コード | 確認済み。引用符、バックスラッシュ、`:name`を含む値を、実DBの検査が通す |
| psqlのpostgresロールの既定の`search_path` | 確認済み。`"$user", public`で、ロールとデータベースの個別の設定は無く、スキーマ無しの`holds`は解決しない |
| `wmill.datatable()`の接続の既定の`search_path`に`factory`が入らない | 確認済み。`"$user", public`で、スキーマ無しの`SELECT 1 FROM holds`は`relation "holds" does not exist`になる |
| `wmill.datatable()`で`listActiveHolds`と同じ形の読み取りを呼び、行が1件あるときに破損にならない | 確認済み。1件を正しく読み戻せた |
| `make_interval(mins => n::integer)`の、`wmill.datatable()`の束縛での型の解決 | 確認済み。`expires_at - created_at`がちょうど5分になった。書き込みはpsqlだけを通るが、`placeHold`を`wmill.datatable()`で呼ぶ処理を足すときの前提になる |

`search_path`に`factory`が入っていると、スキーマ無しの`holds`が`factory.holds`を指す。
入っていないことは確認済みだが、参照の検出の動詞の規則は、入っていた場合も働く。
