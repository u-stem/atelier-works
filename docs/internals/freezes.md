# 凍結とdeployの保留の内部仕様

反映に関わる2つの止め方の仕様である。
同じ変数に置き、同じCLIで扱う。

- スケジュールの凍結: 確認作業のためにWindmillの画面でスケジュールを止めている間、無関係な反映がスケジュールを有効に戻さないようにする。
  指定したスケジュールを`wmill sync push`から外す。
- deployの保留: migrationのような作業の間、反映全体(push、migration、`self_update`の反映)を待たせる。

次のファイルの凍結と保留に関わる部分を変更する人と、これらを使う人が読む。

- `f/factory/lib/freezes.ts`
- `f/factory/lib/freeze_apply.ts`
- `scripts/freeze.ts`
- `f/factory/self_update.ts`
- `f/factory/poll_issues.ts`
- `f/factory/lib/poll_support.ts`

保留のCLIは、起動のたびに次の3つのファイルを読み込むので、これらを保護パスに入れる。

- `scripts/freeze.ts`
- `f/factory/lib/freezes.ts`
- `f/factory/lib/freeze_apply.ts`

これらを変更するPRは、`self_update`の修正も含め、人が確認してマージする。

残るリスクは[セキュリティ](../security.md)の「凍結とdeployの保留」に書く。

凍結とdeployの保留は、反映を止める仕組みである。
自動マージやIssueの取り込みを止める保留は、表に置く別の仕組みで、[保留の内部仕様](holds.md)に書く。

## 方針

`self_update`と`mise run push`は、リポジトリの定義でスケジュールを上書きする。
画面で止めても、次の反映で有効に戻る。
凍結は、この上書きからスケジュール1つを期限つきで外す。

migrationの前後のように、反映そのものを待たせたい作業もある。
deployの保留は、有効なあいだ、人の操作と`self_update`の両方の反映を止める。

状態は、sync対象から外したWindmillの変数に置く。
sync対象に含めると、無関係なpushが凍結を消すためである。
判断できないときは反映しない(fail-closed)。

## データ

状態は、秘密でない変数`f/factory/freezes`にJSONで置く。
`wmill.yaml`の`excludes`に`f/factory/freezes.variable.yaml`を足してあるので、syncの対象にならない。
スケジュールの凍結は配列`freezes`に、deployの保留は別の配列`deploy_freezes`に置く。
2つの配列を合わせて最大50件で、行のidは配列をまたいで一意である。

`deploy_freezes`を別の配列にするのは、この配列を知らない版の読み手と書き手を壊さないためである。
読み手は知らない最上位のキーを無視するので、古い版は`deploy_freezes`を無視して、スケジュールの凍結だけを扱う。
`target`が`f/`の形でない行が`freezes`に混ざると、古い版の読み手は変数全体を壊れていると判定する。

`deploy_freezes`が無い変数は、空として読む。
保留が1件も無いときは、書き出すJSONにキーを出さない。

項目は次のとおりである。
deployの保留の行は`target`を持たない。
対象が常に反映全体だからである。

| 項目 | 内容 |
| --- | --- |
| `id` | 行の識別子。解除に使う |
| `target` | 凍結するスケジュールのパス(`f/<folder>/<name>`)。`freezes`の行だけが持つ |
| `reason` | 凍結の理由 |
| `holder_kind` | 置いた主体の種類。`session`(Claudeの作業)か`human`(人) |
| `holder` | 置いた主体。`session`では`session:<ブランチ名>` |
| `created_at` | 置いた時刻 |
| `expires_at` | 期限 |
| `released_at` | 解除した時刻。解除していなければ空 |

期限の上限は、読み手と置く側で違う。

| 行の種類 | 置くときの上限 | 読み手の上限 |
| --- | --- | --- |
| スケジュールの凍結 | 24時間 | 24時間 |
| deployの保留 | 120分 | 24時間 |

読み手の上限を置く側より緩くするのは、手で書いた行が変数全体を壊さないようにするためである。

`f/factory/self_update`は凍結できない。
凍結すると、凍結を戻す追従も止まるためである。
同じ`target`に有効な凍結を2つ置けない。
同じ主体(`holder_kind`と`holder`)は、有効なdeployの保留を1件までしか置けない。
別の主体は重ねて置ける。

期限切れは、書き込みに頼らず、時刻で無効と数える。
解除済みの行と期限切れの行を、終わった行と呼ぶ。
置くときに、終わってから24時間を過ぎた行を、両方の配列から捨てる。

## 除外の作り方

`wmill sync push --excludes`は、`wmill.yaml`の`excludes`を置き換える。
そのため、`wmill.yaml`の`excludes`と、有効な凍結の`<target>.schedule.yaml`の和を、`--excludes=<値>`の1要素で渡す。

`wmill.yaml`の`excludes`に次の3項目のどれかが欠けているときは、反映しない。
欠けたまま渡すと、秘密でない設定や反映済みのshaまでpushで上書きするためである。

- `factory_config.resource.yaml`
- `deployed_sha.variable.yaml`
- `freezes.variable.yaml`

実在しない`target`の凍結は、除外に足したうえで警告を出す。

## 追従

終わった行が`freezes`にあると、`self_update`は、shaが変わらない回でも`wmill sync push`だけをやり直す。
やり直しで、凍結のあいだ除外していたスケジュールが、リポジトリの定義へ戻る。
migrationと`deployed_sha`の更新はしない。
pushが成功したら、その行を消す。
この一連を追従と呼ぶ。

追従だけの回が失敗しても、`deployments`に失敗の行を足さない。
反映の対象のコミットが無く、次の回が再試行するためである。
行を消す書き込みが失敗したときは警告だけを残し、次の回が同じpushを繰り返す。

終わった`deploy_freezes`の行は、追従の対象にならない。
戻すべき設定が無いためである。
次の`place`で捨てる。

終わってから24時間を過ぎた`freezes`の行は、次の`place`で捨てる。
捨てた行は追従のpushが行われないので、スケジュールは次の反映で戻る。

## 読めないとき

`self_update`が変数を読めない、または壊れていると判定した回の動作は、反映が要るかで分かれる。
deployの保留が読めないときも同じである。

| 回の種類 | 動作 |
| --- | --- |
| 反映が要る(shaが変わった) | 失敗にする。pushも、migrationも、`deployed_sha`の更新もしない |
| 反映が不要 | 警告だけを残して終わる |

失敗の文言に回復手順`freeze:reset`を示すのは、変数が壊れていると判定したときだけである。
読み取りの失敗(APIのエラー、10秒の時間切れ)には示さない。
読み取りの失敗は一時的なことが多く、次の回の再試行を待つ。

`wmill variable list`が100件以上を返したときは、変数が無いと判定できないので、読み取りの失敗として扱う。

読む段と書く段は、それぞれ`FREEZE_PHASE_TIMEOUT_MS`(10秒)で包む。
段の中は、変数のAPIとファイルの読み取り(`wmill.yaml`の読み込みと`f/`の列挙)だけで、子プロセスは起動しない。
区切った呼び出しの数には数えず、ジョブ全体の最悪の長さに2段ぶんを足す([アーキテクチャ](../architecture.md)の「自己更新」)。
deployの保留の判定は読む段の中で済ませるので、段は増えない。

## deployの保留が効く経路

有効なdeployの保留があるときの、経路ごとの動作である。

| 経路 | 保留があるとき | 変数を読めないとき |
| --- | --- | --- |
| `self_update` | 反映全体を見送る | 反映が要る回は失敗、不要な回は警告 |
| `mise run push`、`push:prune` | 拒否する。`push:dry`は通る | 拒否する |
| `mise run migrate` | 拒否する | 拒否する |
| `mise run deploy` | 先頭の確認で拒否する。通った後は、`freeze.ts apply`も拒否する | 先頭の確認は警告で通る。`freeze.ts apply`は拒否する |
| `mise run up` | コンテナに触れる前の確認で拒否する | 警告で通す |
| `scripts/bootstrap.sh`の全手順のモード | pushで止まる | pushで止まる |

`up`と`deploy`の確認(`freeze.ts check`)は、読めないときに警告だけで通す。
Windmillが止まっていると変数を読めず、スタックを起こせなくなるためである。
`check`が変数を読む待ちは10秒で打ち切り、同じく警告で通す。
`up`は復旧の道具なので、応答しないサーバーで長く止まらないようにする。
読めないまま反映が進むことは無い。
`deploy`の後段の`freeze.ts apply`と、`push`、`migrate`は、読めないと拒否するためである。

`mise run deploy`は、先頭の確認を通った後に別の主体が保留を置くと、workerを作り直した後の`freeze.ts apply`で止まる。
`apply`は`set -e`の中にあるので、タスクは中断する。
保留を解除してから`mise run deploy`をやり直す。

覆わない経路がある。

- 人が手で打つ`wmill sync push`と`wmill datatable migrate up`。
- `scripts/bootstrap.sh`の全手順のモードのmigration。pushは`freeze.ts push`を通るので保留中に止まる。
- ホストの実行役(`scripts/host_apply/`)。

`freeze.ts apply`は、変数を1回読んで、pushに続けてmigrationを実行する。
pushとmigrationの間に保留が置かれても、migrationは続く。
読み直すと、読み直しと実行の間に同じ窓が残るためである。

## self_updateの見送り

保留が有効なあいだ、`self_update`は反映が要る回の途中で戻る。
`wmill sync push`、`wmill datatable migrate up`、`deployed_sha`の更新、`deployments`への記録、通知をしない。
戻り値は`held`で、理由は`deploy_freeze`である。
ログには、保留のidと期限だけを出す。
`reason`と`holder`は信頼できない文字列なので、出さない。

`deployed_sha`を進めないので、保留が切れた最初の回が、見送った範囲をそのまま反映する。
見送ったpushとmigrationも、この回が行う。
見送った回は記録を足さないので、失敗の行と通知は増えない。
見送りを確かめるには、ログと`freeze:list`を見る。

追従だけの回も、保留中は待つ。
終わった行は、保留が切れた後の回で追従する。
保留が24時間を超えて続くと、終わった行が次の`place`で捨てられうる。
捨てた行は追従されず、スケジュールは次の反映で戻る。

## 版の食い違いの通知

`poll_issues`は、`deployed_sha`がself cloneのHEADに追いつかない状態が30分を超えると、`deployed_sha_mismatch`の通知を出す。
保留中は`self_update`が反映を見送るため、追いつかなくても異常ではない。
通知を出す段になってから、有効なdeployの保留だけを読む。
あれば通知せず待つ側に読み替える。
読めないときは、反映の停止を見逃さないよう通知する。
読みは10秒で区切る。
保留が続くあいだは、食い違いを最初に見た時刻を、確かめるたびに今へ直す。
保留が終わった後の猶予30分は、保留の終わりから数える。

## 置く主体

環境変数`CLAUDECODE`があれば`session`、無ければ`human`として扱う。
この区別は誤操作を防ぐためで、権限の境界ではない。

| 操作 | `session` | `human` |
| --- | --- | --- |
| スケジュールの凍結を置く(`freeze:place`) | 置ける | 端末(TTY)で`yes`を入力して置く |
| deployの保留を置く(`freeze:place -- --scope deploy`) | 置ける。subagentは拒否される | 端末で`yes`を入力して置く |
| 解除(`freeze:release`) | 自分の`holder`の行だけ解除できる。subagentは拒否される | 端末で`yes`を入力して解除する |
| 壊れた変数を空に戻す(`freeze:reset`) | できない | 端末で`yes`を入力して実行する |
| 削除を反映するpush(`push:prune`) | できない | 端末で`yes`を入力して実行する |

`--dry-run`付きのpushは、どちらの主体も実行できる。

subagentの拒否は、[セキュリティ](../security.md)の「Claude Codeの拒否ルール」にある、ベストエフォートの規則である。

## 運用手順

スケジュールを画面で止めて確認する手順である。

1. 凍結を置く。

   ```bash
   mise run freeze:place -- --target f/factory/<name> --minutes <n> --reason <text>
   ```

2. `place`が表示する時刻(7分後)まで待つ。
   置く前に始まった`self_update`のpushが、終わるまでの時間にあたる。
3. 止める直前に`mise run freeze:list`を実行し、自分の行が残っているかを確かめる。
   同時に書き込むと、行を失うことがあるためである。
4. Windmillの画面でスケジュールを止める。
5. 確認する。
6. スケジュールを有効に戻す。
7. 凍結を解除する。
   解除を忘れても、期限で無効になる。

   ```bash
   mise run freeze:release -- <id>
   ```

解除か期限切れの後、`self_update`が次の回に追従のpushで、スケジュールをリポジトリの定義へ戻す。

`mise run freeze:list`で、凍結とdeployの保留の一覧を見る。
deployの保留は、対象の欄が`deploy`と表示される。
`id`は`place`と`list`の出力に表示される。

deployの保留を置く手順は、[運用](../operations.md)の「migrationの前にdeployを保留する」にある。

## 失敗の回復

凍結の変数が壊れると、反映が要る回は止まる。
人が端末で次を実行して、変数を空に戻す。
空に戻すと、すべての凍結とdeployの保留が消える。

```bash
mise run freeze:reset
```

`mise run deploy`と`mise run up`は、コンテナを変える前に`freeze.ts check`を実行する。
変数を読めないときは警告だけで進み、壊れていれば失敗する。

## 反映の経路

`mise run push`、`push:prune`、`push:dry`は、`scripts/freeze.ts push`を通る。
`mise run deploy`は、`scripts/freeze.ts apply`を通る。
このラッパーが除外を作って`wmill sync push`を実行する。
`mise run migrate`は、`scripts/freeze.ts migrate`を通る。
`scripts/bootstrap.sh`の全手順のモード(`mise run bootstrap`)も、同じラッパーを通してpushする。
凍結の変数がまだ無い初回は、一覧で無いと確かめられたときだけ、凍結なしとして進む。
変数を読めないとき、壊れているとき、`wmill.yaml`の除外が欠けているときは、bootstrapもpushの手順で止まる。
止まった後の回復は「失敗の回復」と同じである。
