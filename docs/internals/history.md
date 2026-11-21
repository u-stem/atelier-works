# 遷移の履歴の内部仕様

遷移の履歴は、作業項目の状態遷移を、追記専用で、ハッシュでつないで残す記録である。
状態は表`factory.history_events`に置く。
次のファイルの履歴に関わる部分を変更する人が読む。

- `migrations/datatable/main/20261119100000_history_events.up.sql`と、対のdown
- `f/factory/lib/history.ts`(理由コードの一覧、検証の呼び出し、証跡パックの集計、保持の掃除)
- `f/factory/lib/audit_evidence.ts`(証跡パックの節「履歴の整合」)
- `f/factory/cleanup_db.ts`(保持期間を過ぎた連鎖の削除)
- `scripts/test-db-queries.ts`(実DBの検査)

## 目的

状態の遷移は`work_item_events`に残るが、理由は自由文の注記で、追記専用でもない。
作業項目を消すと、遷移も連鎖して消える。
遷移の履歴は、次の3つを満たすために置く。

- 遷移の理由を、決まった一覧の値(理由コード)で数えられる。
- 行を書き換えても、消しても、検証で見つかる。
- 作業項目と`work_item_events`が消えた後も、決めた期間は残る。

## 書き込み

`work_item_events`のAFTER INSERTトリガー(`history_events_record`)が、遷移1つにつき履歴を1行足す。
トリガーは遷移の行と同じ文、同じトランザクションの中で動く。
遷移が取り消されれば、履歴の行も残らない。

履歴の書き込みを遷移と同じトランザクションに入れるのは、意図した設計である。
履歴の書き込みが失敗すれば、遷移も失敗する。
可用性より、履歴の完全さを選ぶ。
履歴を非同期に書くと、遷移だけが残って履歴が欠けうるためである。

書き込みが失敗する原因は、次の2つである。

1. advisory lockが取れない。
   同じ作業項目への追記が、長いトランザクションの中で止まっているときに起きる。
   接続が`lock_timeout`を設定していれば、その時間で失敗する。
   設定していなければ(既定の0)、遷移は失敗せず、ロックが空くまで待ち続ける。
2. 規則の返す理由コードが、SQLの一覧にない。
   `reason_code`のCHECK制約に落ちる。
   TypeScriptとSQLの一覧と規則の一致は実DBの検査で確かめるので、食い違ったまま反映されない。

TypeScriptの呼び出し側は変えない。
`db.ts`の挿入、Consoleからの中止(`console_work_item_cancel.ts`)、migrationの直接の挿入は、どれも同じトリガーが拾う。
状態を移す文(`updateStatus`の系列)にも手を入れない。
`FOR UPDATE`のCTEと兄弟のCTEの組み合わせは、PostgreSQL 18で挙動が変わるため、文を変えずにトリガーで拾う。

履歴の行は、次の値を持つ。

| 列 | 内容 |
| --- | --- |
| `work_item_id` | 作業項目のID。外部キーを持たず、値だけで参照する。作業項目を消しても履歴は残る |
| `seq` | 作業項目ごとの連番。1から始まり、欠けずに続く |
| `kind` | 履歴の種類。`transition`(状態遷移)だけである |
| `reason_code` | 遷移の理由コード([理由コード](#理由コード)) |
| `from_status`、`to_status` | 遷移の前後の状態 |
| `actor` | 書いた主体。トリガーが書く行は`factory`である |
| `detail` | 元の遷移の行のID(`event_id`)と、注記の文字数(`note_chars`)。注記が無いときの文字数は`null`である |
| `occurred_at` | 遷移の時刻 |
| `prev_hash`、`row_hash` | 連鎖のハッシュ([ハッシュの連鎖](#ハッシュの連鎖)) |

注記の本文は`detail`に入れない。
注記は、外から来た文字列を含みうるためである。
履歴は、注記の中身ではなく、遷移の事実と理由コードだけを持つ。

連鎖は作業項目ごとである。
全体で1本の連鎖にすると、すべての挿入が1か所に並ぶ。
作業項目ごとなら、連鎖を丸ごと消しても、ほかの連鎖は壊れない。
同じ作業項目への追記は、作業項目ごとのadvisory lockで直列にする。
ロックはトランザクションの終わりまで持つ。
ほかの作業項目への追記は待たない。

移行が既存の遷移を取り込む処理は、連鎖ごとのロックを取らない。
履歴の表はその移行が作ったばかりで、`work_item_events`への書き込みも止めてあるので、追記は競合しない。
ロックは作業項目の数だけ1つのトランザクションに積み上がり、共有のロック表を使い切るおそれがあるため、取らない。
取り込みは、ロックを取らない`factory.history_append_unlocked`を使う。

## 理由コード

理由コードは、SQL関数`factory.history_reason_code(note, to_status)`が、注記の先頭から決める。
どの規則にも当たらない注記と、注記が空の遷移は`unspecified`になる。
一覧はSQL関数`factory.history_reason_codes()`が返し、TypeScriptの`HISTORY_REASON_CODES`と同じ並びにする。
TypeScriptは、同じ規則を表`HISTORY_NOTE_RULES`と関数`historyReasonCode`にも持つ。
実DBの検査が、一覧の一致と、表の各規則の注記をSQLに通した結果の一致を確かめる。
表の規則と本番の注記の定数の一致は、単体テストが確かめる。

| 理由コード | 条件 |
| --- | --- |
| `auto_retry` | 注記が`auto_retry:`で始まる。自動の再開 |
| `auto_retry_stalled` | 注記が`auto_retry_stalled:`で始まる。一時的な失敗で止まったPRレビューの再開を見送った記録 |
| `auto_retry_launch_failed` | 注記が`auto_retry_launch_failed:`で始まる。PRレビューの再開の起動に失敗した記録 |
| `manual_retry` | 注記が`retry_work_item:`で始まる。人の再実行 |
| `operator_cancelled` | 移り先が`cancelled`で、注記がConsoleからの中止の固定の文(`console: operator_cancelled`)と完全に一致する |
| `pr_fix_design_gap` | 注記が`pr_fix design gap:`で始まる。PRの修正から設計へ戻した |
| `implement_design_gap` | 注記が`implement design gap:`で始まる。実装から設計へ戻した |
| `implement_design_gap_exhausted` | 注記が`implement design gap exhausted:`で始まる。設計へ戻す上限に達した |
| `pr_fix_apply` | 注記が`pr_fix_apply:`で始まる。PR修正の適用で止めた |
| `reconcile` | 注記が`reconcile:`で始まる。PRの状態との照合による遷移 |
| `isolation_gate_closed` | 注記が`isolation gate closed:`で始まる。調査の隔離の門が閉じていた |
| `intake_refreshed` | 注記が`intake refreshed from the current issue`で始まる。取り込み内容の更新 |
| `approval_redispatch` | 注記が`approval handler restarted for request`と空白で始まる。承認の判断を反映する処理の再起動 |
| `superseded_by_newer_cycle` | 移り先が`cancelled`で、注記が`superseded by a newer cycle`で始まる。新しいサイクルによる取り消し |
| `ci_round` | 注記が`ci round:`で始まる。CIの失敗を直す回の停止 |
| `conflict_round` | 注記が`conflict round:`で始まる。競合を直す回の停止 |
| `unspecified` | 上のどれにも当たらない。注記が空の遷移を含む |

理由コードは注記の先頭から決めるので、注記を書く側が明示した値ではない。
先頭が同じ注記は、書いた処理が違っても、同じコードになる。
注記の無い通常の遷移(例えば、レビュー中からレビュー済みへの遷移)は、注記から決める仕組みでは理由を決められない。
そのため、`unspecified`は性質として多くなり、全遷移に対する割合は、明示の理由に移す対象を選ぶ目安にならない。
目安になるのは、注記があるのに`unspecified`になった遷移の数である。
注記があるのに規則に当たらないものは、呼び出し側が理由を明示する候補になる。
注記の有無は、`detail`の`note_chars`(0より大きければ注記がある)で見分ける。
証跡パックの節「履歴の整合」は、注記があるのに`unspecified`になった遷移の数と、注記のある遷移の数を出す。
注記が無く`unspecified`になった遷移の数は、参考として別の行に出す。
通常の遷移なので、不具合として扱わない。

すでに書いた行の理由コードは書き換えない。
理由コードは`row_hash`に含まれ、履歴は追記専用なので、あとから直せないためである。
この集計は、行の`detail`から読むので、migrationもスキーマの変更も要らない。

コードを足すときは、新しいmigrationで`history_reason_codes`と`history_reason_code`を置き換える。
同じ変更で、`HISTORY_REASON_CODES`、`HISTORY_NOTE_RULES`、単体テストの注記の表に足す。
単体テストの注記は本番のコードの定数から作ってあるので、定数の変更も検査が拾う。

## ハッシュの連鎖

`row_hash`は、行の次の項目を、この順に並べた文字列のsha256(16進)である。

1. `prev_hash`
2. `work_item_id`
3. `seq`
4. `kind`
5. `reason_code`
6. `from_status`
7. `to_status`
8. `actor`
9. `detail`(jsonbの文字列表現)
10. `occurred_at`

各項目は`<バイト長>:<値>`の形にし、値が`NULL`のときは`~`にして、`|`でつなぐ。
バイト長を付けるのは、値に区切りの文字が含まれても、項目の境界が曖昧にならないためである。
`occurred_at`は、接続の時刻帯に左右されないよう、UTCで`YYYY-MM-DD"T"HH24:MI:SS.US"Z"`の形(マイクロ秒まで)にする。
算出はSQL関数`factory.history_row_hash`が行い、トリガーと検証が同じ関数を使う。

連鎖の最初の行の`prev_hash`は、0を64個並べた文字列である。
2行目からは、同じ作業項目の1つ前の行の`row_hash`を`prev_hash`にする。

## 検証

`factory.history_verify(work_item_id)`が連鎖を検証する。
引数を省くと、すべての連鎖を調べる。
行のハッシュを再計算し、`prev_hash`のつながりと、`seq`が1から欠けずに続くことを確かめる。
壊れた連鎖だけを、最初に壊れた行の`seq`と理由つきで返す。

| 理由 | 意味 |
| --- | --- |
| `gap` | `seq`が欠けている。最初の行が1でないときを含む。欠けた次の行の`seq`を返す |
| `prev_hash_mismatch` | `prev_hash`が、1つ前の行の`row_hash`と合わない |
| `row_hash_mismatch` | 行の内容から求めたハッシュが、`row_hash`と合わない |

検証をSQLで行うので、言語をまたぐ正規化は要らない。
TypeScriptの呼び出しは`verifyHistory`である。

連鎖の末尾の行を消した場合と、連鎖を丸ごと消した場合は、検証では見つからない([R-HIST-01](../security-risks.md#r-hist-01))。
残った行だけで、連鎖が閉じているためである。

## 追記専用

行のトリガー`history_events_guard_row`が、UPDATEとDELETEを例外で拒む。
文のトリガー`history_events_guard_truncate`が、TRUNCATEを例外で拒む。
トランザクションの中で`factory.history_prune`を`on`にしたときだけ、通す。
印を立てるのは、保持の掃除の関数(`factory.history_prune_chains`)だけである。
印はトランザクションの中だけで有効で、トランザクションが終わると消える。
印は接頭辞つきの設定値なので、どのセッションからも立てられる([R-HIST-03](../security-risks.md#r-hist-03))。

この歯止めは安全柵である。
表の所有者はトリガーを外せるので、歯止めは改ざんを防がない。
改ざんを見つけるのは、ハッシュの連鎖である。
所有者が連鎖の途中の行を書き換えれば、検証が、その行を指す。
ただし、所有者がその行から先の連鎖をすべて計算し直せば、検証は通る([R-HIST-02](../security-risks.md#r-hist-02))。
この限界は、Windmillのscriptがすべて同じ接続で表に届くことから来る。

## 保持

保持期間は、設定`retention_history_days`(既定365日)である。
作業項目の保持期間(`retention_work_items_days`)とは独立している。
履歴は外部キーを持たないので、作業項目の削除では消えない。

`cleanup_db`が、作業項目がもう無く、最後の記録が保持期間より古い連鎖を、丸ごと消す。
連鎖の一部だけを消すことはない。
先頭の欠けた連鎖は、検証で`gap`になるためである。

作業項目が残る連鎖は、古くても消さない。
消すと、その作業項目の次の遷移が`seq`1から始まり、前の履歴が欠けたまま、検証が健全に見えてしまうためである。

削除はSQL関数`factory.history_prune_chains`が行う。
消す連鎖ごとに、追記と同じadvisory lockを、待たずに取る。
取れない連鎖は、別のトランザクションが使っている最中なので飛ばし、次の掃除が拾う。
掃除は待たないので、複数の連鎖へ書くトランザクションと、ロックを待ち合って止まることがない。
ロックを取った後で、最後の記録の時刻を確かめ直す。
掃除の間に新しい遷移が足された連鎖を、先頭の欠けた連鎖にしないためである。
1回に消す連鎖は1000件までで、残りは次の掃除が消す。
1つのトランザクションが持つadvisory lockの数を抑えるためである。
消した連鎖と行の数は、ログに残す。

## 証跡パックの節

証跡パックの節「履歴の整合」は、全連鎖の検証の結果と、期間内の遷移の理由コード別の件数を載せる。
内容は[監査の仕様の「遷移の履歴の整合」](audit.md#遷移の履歴の整合)に書く。

## 並行する書き込み

同じ作業項目への並行する追記は、advisory lockで順に並ぶ。
既定の分離水準(READ COMMITTED)では、ロックを取った後の文が、先の追記の結果を読む。
それより強い分離水準では、後の追記が同じ`seq`を取り、`(work_item_id, seq)`の一意制約に失敗しうる。
連鎖が分かれて残ることはない。
