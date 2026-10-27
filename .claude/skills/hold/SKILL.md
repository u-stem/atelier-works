---
name: hold
description: マージや反映を期限つきで止める保留を、置く・解除するときに使う。実機で確かめる前、スケジュールを止める前、migrationの前、保留で止まったときにも参照する。
---

# 保留

保留は、マージや反映を期限つきで止める印である。
止めるためだけに使い、何かを許可することはない。
仕様は[保留の内部仕様](../../../docs/internals/holds.md)と[凍結とdeployの保留の内部仕様](../../../docs/internals/freezes.md)にある。

## 止めるもの

| 種類 | 止めるもの | 期限の上限 | 置くコマンド |
| --- | --- | --- | --- |
| マージの保留 | `gh pr merge`などのマージと、Factoryのdependabotの自動マージ | 24時間 | `mise run hold:place` |
| deployの保留 | `wmill sync push`、`wmill datatable migrate`、`self_update`の反映 | 120分 | `mise run freeze:place -- --scope deploy` |
| スケジュールの凍結 | 指定したスケジュールを`wmill sync push`の対象から外す | 24時間 | `mise run freeze:place -- --target <path>` |

マージの保留はリポジトリ(`<owner>/<repo>`)ごとに置く。
ローカルのセッションのフックは、保留が有効な間、対象のリポジトリへのマージを止める。
`--repo`が文字どおり決まらないマージは、どのリポジトリの保留でも止める。
フックは、スケジュールの凍結が有効な間、除外を付けない手動の`wmill sync push`も止める。
その間のpushは`mise run push`を使う。

Issueの取り込みの保留(`claim`)は置けない。
Factoryの二重取りは、作業項目の一意制約が防ぐ。
人が着手する分の重複は防がない。
詳しくは[保留の内部仕様](../../../docs/internals/holds.md)の「Issueの二重取りを防ぐ仕組み」に書く。

## 置くタイミング

次の作業の前に、保留を置く。

- 実機で確かめる間、他のマージを入れたくないとき。マージの保留を置く
- スケジュールを止めて確かめるとき。スケジュールの凍結を置く
- migrationや、反映を挟みたくない作業の前。deployの保留を置く

## 手順

1. マージの保留を置く前に、自動マージを有効にしたPRを探す。
   GitHubは、保留を置いた後も、チェックが通れば自動マージを実行するためである。

   ```bash
   gh pr list --repo <owner>/<repo> --json number,autoMergeRequest --jq '.[] | select(.autoMergeRequest != null) | .number'
   ```

2. 保留を置く。
   理由には秘密を書かない。理由は一覧に表示される。

   ```bash
   mise run hold:place -- --scope merge --target <owner>/<repo> --minutes <分> --reason <理由>
   ```

3. 置けたことを一覧で確かめる。

   ```bash
   mise run hold:list
   mise run freeze:list
   ```

4. 作業を終えたら、置いた保留を解除する。

   ```bash
   mise run hold:release -- <id>
   ```

   deployの保留とスケジュールの凍結は`mise run freeze:release -- <id>`で解除する。

deployの保留を置いた後は、置く前に始まった`self_update`の回が終わるまで、約13分待つ。
`mise run freeze:place`が、作業を始めてよい時刻を表示する。

## 延長と解除

保留に延長の操作は無い。
続けるときは、解除して置き直す。

セッションが解除できるのは、自分の保留(`holder`が`session:<ブランチ>`)だけである。
同じブランチのセッションは同じ`holder`を共有する。
人は、端末で`yes`を入力して解除する。
人は、Consoleのシステムの画面の「保留と凍結」からも、確認のダイアログを通して解除できる。
人は、Consoleのシステムの画面の「保留と凍結」からも、確認のダイアログを通して置ける。
scheduleを止める準備として、スケジュールのタブから凍結を置くこともできる。
セッションが置くときは、CLIの`mise run hold:place`と`mise run freeze:place`を使う。

## 保留で止められたとき

フックの拒否の文には、保留のid、対象、期限、置いた主体の種類が載る。

1. `mise run hold:list`で、保留の理由と期限を確かめる。
2. 主セッションは、人に尋ねる。保留を置いた主体が解除するか、期限が切れるまで待つ。
3. 自分が置いた保留で、確認が済んだときだけ、解除してやり直す。
4. 保留を読めないという拒否は、保留なしを意味しない。
   スタックが止まっているなら`mise run up`で起動して、同じコマンドをやり直す。
   ツールが無いと出たら`mise install`を実行する。
   それでも読めないときは、人に頼む。

## しないこと

- subagentは、保留を置かず、解除もしない。主セッションに報告して終える。
- Consoleの書き込みのscript12本を、`wmill script run`や`curl`などで呼ばない。12本は次のとおりである。
  - `approval_decide`、`retry_work_item`、`audit_kickoff`、`manual_intake_submit`
  - `notice_resolve`、`hold_release`、`freeze_release`、`console_job_cancel`
  - `console_job_rerun`、`console_config_update`
  - `console_hold_place`、`console_schedule_stop`
- 12本の拒否は、フックが主セッションにも行う。運用者がConsoleの確認のダイアログを通す操作を、セッションが直接呼ぶと、その確認を通らないためである。解除の2本は、さらに端末での人の確認を通らずに、他の主体の保留を外す。
- 拒否は、12本のどれかの名前と、`bun`、`wmill`、`curl`などの語が、同じコマンドに並ぶと起きる。コミットメッセージやPR本文を、ヒアドキュメントや`-m`で渡すコマンドも同じである。メッセージやPR本文のファイルはWriteツールで書き、名前を並べない。
- 主セッションは、`wmill script preview`で12本を確かめられない。
- 凍結の変数を`wmill variable`で書かない。名前を含むコマンドは、読むだけでも拒否するので、ソースはReadツールか`git show`で読む。
- 解除は、人がConsoleの画面で行う。
- 保留で止められたマージを、別の経路(GitHubのWeb UI、MCP、APIの別の呼び出し)で通さない。
- クラウドのセッションは、保留を読めない。マージと反映は人に頼む。
- 理由に秘密を書かない。
