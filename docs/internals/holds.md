# 保留の内部仕様

保留(hold)は、対象を進めないことを、期限つきで伝える仕組みである。
状態は表`factory.holds`に置き、読み書きは`f/factory/lib/holds.ts`が行う。
次のファイルの保留に関わる部分を変更する人が読む。

- `f/factory/lib/holds.ts`
- `migrations/datatable/main/20261023131355_holds.up.sql`
- `f/factory/poll_dependabot.ts`と`f/factory/steps/dependabot_finish.ts`(保留を読む処理)
- `scripts/hold.ts`と`scripts/hold_psql.ts`(CLI)
- `scripts/claude-hooks/hold-guard.ts`(subagentの拒否)
- `tests/scripts/hold_wiring.test.ts`
- `scripts/test-db-holds.ts`

残るリスクは[セキュリティ](../security.md)の「保留」に書く。

## 方針

保留は止めるためだけに使う。
保留の有無が、何かを許可することはない。
許可に使うと、偽の行を置くだけで保護が外れるためである。

保留を読んで止まる主体は、Factoryのdependabotの自動マージだけである。
範囲`claim`を読む主体は、まだ無い。
実装の状態は[アーキテクチャ](../architecture.md)の「未実装の機能」に書く。

## 凍結との違い

[スケジュールの凍結](freezes.md)は、スケジュールを`wmill sync push`から外す仕組みで、状態は`f/factory/freezes`の変数に置く。
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
| `claim` | Issueの取り込み | `owner/repo#number` | 対象ごとに排他 |

対象は小文字にそろえる。

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
有効な保留が1件でもあれば、作業項目を作らず、影響調査(Claudeの実行)も走らせずに待つ。
保留を読めないときも、保留なしとは扱わず、同じように待つ。
読めないのは、表が無いとき、DBに届かないとき、行が壊れているとき、例外が出たときである。
待ちの記録は変えない。
保留が続いても、待ちの上限の起点は前の記録から続く。

待ったPRの数は、取得の1周ごとに、種類を分けて1件の通知にまとめる。

| 状態 | 通知の種類 | 重要度 | 本文 |
| --- | --- | --- | --- |
| 保留がある | `dependabot_merge_held` | 情報 | 待っているPRの数と、一覧と解除の操作 |
| 保留を読めない | `dependabot_merge_hold_unreadable` | 要対応 | 読めない原因の種類と、最初に確かめること |

読めない通知にPRの数を載せないのは、同じ原因の未解決の通知を1件に保つためである。
保留の`reason`と`holder`は、どちらの通知にも載せない。

保留が解けるか、読めるようになれば、次の取得が自動で再開する。
dependabotがrebaseして新しいheadになったPRは、新しいheadとして評価する。

終了(`dependabot_finish`)は、マージの直前にもう一度読む。
取得から終了までの間に置かれた保留を、最後に確かめるためである。
読む位置は、試運転(`dependabot_merge_enabled`が偽)の判定より前である。
保留があるか読めなければ、マージせずに、作業項目を人の対応待ち(`needs_human`)で終える。
この作業項目は、保留が解けても再開しない。
dependabotの作業項目は再実行できないので、人がPRを確認して手でマージする。
次の操作は、通知に載る。

ログと通知に載せるのは、種類、件数、保留のidだけである。
`reason`と`holder`は、DBに書ける主体が決める信頼できない文字列なので、載せない。

保留を読んでからマージを要求するまでの数秒は、受け入れる。
保留は止めるだけの補助で、元の保護(レビューとゲート)が残るためである。
保留が止めるのは、Factoryのdependabotの自動マージだけである。
`dependabot_merge_enabled`が偽(試運転)のときは、自動マージが元から無いので、保留は取得の待ちにだけ効く。
`gh pr merge`は止まらない。
マージを要求するのは終了のステップだけで、配線テストが固定する。

## CLI

`mise run hold:list`、`mise run hold:place`、`mise run hold:release`が、`scripts/hold.ts`を呼ぶ。
miseのタスクを使えないときは、`mise exec -- bun ./scripts/hold.ts <コマンド>`と書く。
composeに要る環境変数を、miseが渡すためである。

| コマンド | 内容 |
| --- | --- |
| `list` | 有効な保留、未解除で無効な行、有効なスケジュールの凍結の件数を表示する |
| `place --scope merge --target <owner>/<repo> --minutes <n> --reason <text>` | 保留を置く |
| `release <id>` | 保留を解除する |

終了コードは、引数の誤りが2、拒否と失敗が1である。

`list`は、読み取り専用の接続で読む。
読めなければ、理由を表示して失敗にする。
行が壊れているときは、回復の手順を表示する。
無効な未解除の行は、`invalid`と表示する。
`reason`、`holder`、`released_by`は、制御文字と書式文字を空白にして表示する。
凍結の件数は、`wmill`を使えないときは警告にとどめる。
`list`と`place`は、保留が止める経路の説明を表示する。

置く主体は、環境変数`CLAUDECODE`で分ける。
あれば`session`で、`holder`は`session:<ブランチ>`になる。
無ければ`human`である。
`human`の置く操作と解除は、端末で`yes`を入力して確かめる。
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

## subagentの拒否

`scripts/claude-hooks/hold-guard.ts`が、subagentの保留の操作を拒否する。
`bash-guard`が、subagentのBashのコマンドだけに適用する。
主セッションと人は、止められない。
許すのは一覧(`list`)だけである。
subagentが保留を置くと、確認する相手がいないまま、自動マージを止められるためである。

拒否する形は次のとおりである。

- `bun`、`bunx`、`node`、`tsx`、`deno`、`npx`で`hold.ts`を実行し、直後の最初のオペランドが`list`でないもの。
  オペランドが無い形も拒否する。
  絶対パス、`bun run`、`mise exec --`の中も同じである。
- `bun -e`や`deno eval`などの文字列と、標準入力で渡すコードに、`hold.ts`、`hold_psql.ts`、`holds.ts`を含むもの。
- `mise run`、`mise r`、`mise tasks run`、`mise <task>`で、タスク`hold:place`か`hold:release`を指すもの。
  `hold:*`のようなglobと、実行時に決まる語も拒否する。
- `docker`、`docker-compose`、`psql`で、語か標準入力の文字列に`holds`を含むもの。
  ヒアドキュメントと、パイプの前の`echo`や`printf`も見る。

`bunx biome check scripts/hold.ts`のように、`hold.ts`の前に別のオペランドがある形は、実行ではなく検査なので止めない。

止められない形は、残るリスクとして受け入れる。
境界ではなく、誤操作と、拒否を知らない呼び出しを止める補助である。
詳しくは[セキュリティ](../security.md)の「保留」に書く。

- 別名の呼び出し(`cp scripts/hold.ts /tmp/h.ts`の後に実行する形)。
- 変数や文字列の連結で組んだパス、動的なimport。
- `docker compose exec db psql`に渡す語を組み立てて書く形。
- subagentが新しいファイルを書いて実行する形。

BashとDockerを持つ主体は、psqlで保留を直接書ける。

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

実行時に`holds.ts`を読み込んでよい`f/`のファイルは、保留を読む2つ(`poll_dependabot.ts`と`dependabot_finish.ts`)だけである。
読み込む名前は`listActiveHolds`だけで、型は読み込みに数えない。
読む処理を足す段では、テストの`HOLD_READERS`に足す。

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

datatableの接続の既定の`search_path`に`factory`が入っていないことは、確かめていない。
入っていれば、スキーマの付かない`holds`が、`datatable`の名前の指定なしで`factory.holds`を指す。
上の動詞の規則は、その場合も働く。

接続の`role`(windmill-clientの`datatable(name, { role })`、1.817.0)は、Windmillの文書がEnterprise Editionの機能と書いている。
このリポジトリはCommunity Editionなので、DBの層で書き手を分離する設計はしない。

表の定義を変えるmigration(scopeを広げるなど)は、表を作るmigrationと並べて、テストの`HOLDS_MIGRATION_FILES`に足す。
これは保護パスの変更として出す。

追加の守りは次のとおりである。

- `holds.ts`とそのテスト、実DBの検査、CLIとpsqlの経路とそのテストは、保護パス(`f/factory/lib/protected_paths.ts`)に入れる。
  拒否のフックの`scripts/claude-hooks/`とそのテスト、miseのタスクのディレクトリ(`mise-tasks/`と`.mise-tasks/`)も入れる。
  置いたファイルがタスクとして実行されるので、拒否の外から保留を操作できるためである。
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
| `tests/scripts/dependabot_finish.test.ts`、`tests/scripts/poll_dependabot.test.ts` | 保留があるとき、読めないときに、マージせず作業項目も作らないこと。読む位置 |
| `tests/scripts/claude-hooks/bash-guard.test.ts` | subagentの拒否と許可の形、主セッションを止めないこと |
| `tests/scripts/hold_wiring.test.ts` | 表への参照の混入、読む処理の名前、マージを要求するファイル、CLIが表の名前を持たないこと、miseのタスク、`test-db.sh`が実DBの検査を呼ぶ位置 |
| `scripts/test-db-holds.ts` | `mise run test:db`が流す。制約、部分一意インデックス、置く操作のSQLを本物のPostgreSQLで確かめる。psqlの経路で値の束縛と読み取り専用の接続も確かめる |

実DBの検査のうち、制約と文の検査は、値を定数として埋め込む検査用のクライアントで流す。
CLIの経路は、`hold_psql.ts`に使い捨てのデータベース(`factory_test`)を渡して流す。
本番のデータベースには書かない。
どちらも、`wmill.datatable()`の束縛の経路は通らない。

## 実機での確認

外部の挙動に依存する前提の確認の結果である。
確認は、mainの`9dae4761`を反映したローカルのスタックで行った。

| 前提 | 結果 |
| --- | --- |
| psqlの標準入力、`:'name'`の展開、`-X`、`ON_ERROR_STOP`、`docker compose exec -e PGOPTIONS`、読み取り専用の接続、終了コード | 確認済み。引用符、バックスラッシュ、`:name`を含む値を、実DBの検査が通す |
| psqlのpostgresロールの既定の`search_path` | 確認済み。`"$user", public`で、ロールとデータベースの個別の設定は無く、スキーマ無しの`holds`は解決しない |
| `wmill.datatable()`の接続の既定の`search_path`に`factory`が入らない | 未確認。ワークスペースで流す検証が要る |
| `wmill.datatable()`で`listActiveHolds`を呼び、行が1件あるときに破損にならない | 未確認。ワークスペースで流す検証が要る |
| `make_interval(mins => n::integer)`の、`wmill.datatable()`の束縛での型の解決 | 未確認。書き込みはpsqlだけを通るので、この段では前提にしない。`wmill.datatable()`から書く呼び出し元ができる段で確かめる |

未確認の前提のうち、`search_path`に`factory`が入っていた場合は、スキーマ無しの`holds`が`factory.holds`を指す。
参照の検出の動詞の規則が、その場合も働く。
読み取りで破損にならない前提は、`listActiveHolds`の行の解析を、偽の接続のテストと実DBの検査が固定している。
