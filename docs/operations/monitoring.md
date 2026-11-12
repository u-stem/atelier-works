# workerとスケジュールの監視の運用

workerの検知と負荷の記録、スケジュールの失敗の検出、自己更新の打ち切りが働いていることを確かめる手順である。
Factoryを運用する人が読む。
[運用](../operations.md)の手順のうち、監視の仕組みを確かめるものをこの文書に置く。

## Console用のworkerの検知を確かめる

Console用のworkerがジョブを受けているかどうかは、自己更新(`self_update`)が毎回の最後に確かめる。
workerの一覧を読むAPIは、ジョブのトークンでは読めない(Forbidden)ので、読めるqueueとジョブの履歴を見る。
判定は次の順で決める。

1. tag `console`のジョブのうち、予定時刻を過ぎても実行が始まっていないものを、古い順に100件まで読む。
   予定時刻から5分以上待っているものが1件でもあれば、workerがジョブを受けていないと判定する。
2. 待っているジョブが残っている(5分未満)か、Console用のworkerが`console_fetch_watch`を30分以内に完了していれば、問題なしと判定する。
   ジョブが作られていることが、スケジュールが生きている証拠になる。
3. どちらも無ければ、判定できないものとして扱う。

完了の記録は、`console_fetch_watch`の完了した実行を新しい順に10件読み、tagが`console`で、取り消されていないものだけを数える。
手動の実行やpreviewはdefaultのworkerで動き、人が取り消したジョブもworkerの動作の証拠にならないためである。
完了時刻は、`completed_at`があればそれを使い、空なら開始時刻に所要時間を足して出す。
Windmillの応答では`completed_at`が空のことがある。
失敗した実行は、workerがジョブを受けて動いた証拠として数える。

`console_fetch_watch`が10分ごとにtag `console`のジョブを作る。
workerがジョブを受けなければそのジョブが待ち続けるので、止まってから約20分かけて検知する。
内訳は、ジョブの作成の間隔10分、待ちの5分、自己更新の間隔2分に、自己更新の実行時間を足した値である。
この確認は自己更新の最後に走るので、同じ回で反映が走ると、その分だけ検知が遅れうる。
反映の`wmill`は2回で最大10分かかり、約20分の余裕の3分を超えうる。

通知`console_worker_missing`が立つのは、workerが居ないときだけではない。
workerが居ても、枠が塞がっているときや、tagの設定がずれてジョブを受けないときにも立つ。
通知の次の操作に従い、コンテナの状態、再起動、Windmillの画面での実行中のジョブとワーカーグループのtagの順に確かめる。

次の点に注意する。

- workerが動いていても、ジョブが大量に溜まると5分以上待つことがある。
  通知が出たら、待っているジョブの数と実行中のジョブを確かめる。
- workerは居るがジョブが毎回すぐ失敗するときは、この検知では拾わない。
  スケジュールの失敗の検出が拾う([scheduleの失敗の検出](#scheduleの失敗の検出))。
- `mise run up`でConsole用のworkerを作り直している間は、`console_worker_missing`が出うる。
  作り直しが終われば、通知を解決する。
- この検知は、`console_fetch_watch`のスケジュールが有効なことを前提にする。
  スケジュールを無効にするか削除すると、待つジョブと完了の記録が新しく増えなくなる。
  判定できない回が続き、1時間で`console_worker_check_failed`になる。

確認できなかった回は、自己更新のジョブログに警告を残し、通知は出さない。
警告は次の4種類である。

- `could not list the waiting console jobs`: 待っているジョブの一覧を読むAPIが失敗した。
  権限が足りないときもこうなる。
- `could not list the recent console_fetch_watch runs`: 完了した実行の履歴を読むAPIが失敗した。
- `could not confirm the console worker from the job lists`: 応答が一覧の形でない。
  または、待つジョブも30分以内の完了も無い(完了は、Console用のworkerのものだけを数える)。
- `console worker check timed out`: 10秒以内に終わらなかった。

最初に確認できなかった時刻を、自己更新のstateのキー`console_worker_unknown_since_ms`に残す。
回数ではなく時刻で数えるので、自己更新の間隔を変えても、続いた時間の意味は変わらない。
stateを読めなかった回は、時刻を書かない。
その時刻から1時間続くと、通知`console_worker_check_failed`を残し、Discordにも知らせる。
確認できれば時刻を消す。
stateに回数のキー`console_worker_unknown_count`があれば、読まず、書くときに消す。

マージの後は、次の手順で検知が動いていることを確かめる。
Console用のworkerを止めて戻すコマンドは次のとおりである。

```bash
mise exec -- docker compose -f infra/docker-compose.yml stop windmill_worker_console
mise exec -- docker compose -f infra/docker-compose.yml start windmill_worker_console
```

1. 正常な状態で1時間以上、自己更新のジョブログに上の警告が出ず、通知`console_worker_check_failed`も出ないことを見る。
2. `stop`でConsole用のworkerを止める。
3. 約20分以内に、通知`console_worker_missing`ができ、Discordにも届くことを見る。
   反映と重なった回では、最大10分遅れうる。
4. `start`で戻し、通知を解決する。

Consoleが止まっていてもDiscordには届くので、通知の確認先はConsoleに限らない。

## 定期ジョブ用のworkerの検知を確かめる

定期ジョブ用のworkerがジョブを受けているかどうかは、自己更新(`self_update`)が毎回の最後に、Console用のworkerの確認に続けて確かめる。
判定は、tag `periodic`のジョブのうち、予定時刻を過ぎても実行が始まっていないものを、古い順に100件まで読んで決める。
予定時刻から13分以上待っているものが1件でもあれば、workerがジョブを受けていないと判定し、通知`periodic_worker_missing`を残してDiscordにも送る。
13分未満の待ちと、待つジョブが無いことは、問題なしと判定する。
しきい値は、tag `periodic`を付けた各scriptについて、他のscriptの`timeout`の合計に余裕を足した値以上にしている。
枠が1つなので、長く動くジョブの後ろで待つ間を、workerの不在と誤って知らせないためである。
今の5本では、`detect_schedule_failures`が最も待たされ、他の4本の`timeout`の合計である480秒まで待つ。
通知の解決は、本文のしきい値より前の固定の部分で選ぶので、しきい値を変える前に残した通知も、自動で解決される。

Console用のworkerの確認と違い、動作の証拠は求めない。
tag `periodic`を付けたscriptが無い間や、スケジュールが無効な間は、待つジョブがそもそも作られない。
証拠を求めると、その間も判定できない回が続き、確認の失敗が通知されるためである。
待つジョブが無くなるか、13分未満になると、残した通知を自動で解決する。

通知が立つのは、workerが居ないときだけではない。
workerが居ても、枠が塞がっているときや、tagの設定がずれてジョブを受けないときにも立つ。
通知の次の操作に従い、コンテナの状態、カスタムtagの許可、Windmillの画面での実行中のジョブとワーカーグループのtagの順に確かめる。

次の点に注意する。

- この検知は、tag `periodic`のジョブが1件以上作られて初めて働く。
  tagを付けたscriptが無い間は、workerが止まっていても気づけない。
- workerの枠は1つなので、長く動くジョブがあると、ほかのジョブが13分以上待ちうる。
  通知が出たら、実行中のジョブと、そのscriptの`timeout`を確かめる。
- workerは居るがジョブが毎回すぐ失敗するときは、この検知では拾わない。
  スケジュールの失敗の検出が拾う([scheduleの失敗の検出](#scheduleの失敗の検出))。
- `mise run up`で定期ジョブ用のworkerを作り直している間は、通知が出うる。
  作り直しが終われば、自動で解決する。
- スケジュールの`permissioned_as`がsuperadminなら、カスタムtag`periodic`の許可が無くても動く。
  superadminでなければ、許可が要る。
  `notify_daily_summary`、`auto_retry_pr_review`、`collect_github`、`default_worker_watch`、`detect_schedule_failures`のスケジュールの`permissioned_as`は`u/admin`である。
  値は`wmill schedule get <scriptのパス> --json`で読める。
  許可を欠くと、ジョブは積まれないことがある。
  実機では確かめていないので、起きうる事象として扱う。
  ジョブが積まれなければ、この検知も、スケジュールの失敗の検出も働かず、どちらでも拾えない。
  `mise run doctor`の「カスタムtag」の項目で、`periodic`が`OK`であることを確かめて防ぐ。
  `NG`なら`mise run instance:tags`を実行する。
- defaultのworkerが止まったときの検知(`default_worker_watch`)と、スケジュールの失敗の検出(`detect_schedule_failures`)も、このworkerで動く。
  このworkerが止まると、どちらも止まる。
  defaultのworkerの検知は、片方だけが止まるときは、もう一方が拾う。
- 一覧を読めなかった回と、応答が一覧の形でない回は、判定できないものとして扱う。
  通知は出さず、残した通知も解決しない。
  自己更新のジョブログに警告を残す。

警告は次の3種類である。

- `could not list the waiting periodic jobs`: 待っているジョブの一覧を読むAPIが失敗した。
  権限が足りないときもこうなる。
- `could not confirm the periodic worker from the job list`: 応答が一覧の形でない。
- `periodic worker check timed out`: 10秒以内に終わらなかった。

tag `periodic`を付けたscriptの反映の後に、次の手順で検知が動いていることを実機で確かめる。
定期ジョブ用のworkerを止めて戻すコマンドは次のとおりである。

```bash
mise exec -- docker compose -f infra/docker-compose.yml stop windmill_worker_periodic
mise exec -- docker compose -f infra/docker-compose.yml start windmill_worker_periodic
```

1. `stop`で定期ジョブ用のworkerを止める。
2. tag `periodic`のscriptの次の予定から約18分以内に、通知`periodic_worker_missing`ができ、Discordにも届くことを見る。
   内訳は、待ちの13分と、自己更新の間隔2分に、自己更新の実行時間を足した値である。
3. `start`で戻す。
   待ちのジョブが動き出して数分以内に、通知が自動で解決されることを見る。

tag `periodic`を付けたscriptが、定期ジョブ用のworkerで動くことは、反映の後に次のコマンドで確かめる。
反映は`self_update`が自動で行う。

```bash
wmill job list --json --script-path f/factory/auto_retry_pr_review --limit 3
wmill job get <完了したジョブのID> --json
```

`job list`の各ジョブの`tag`が`periodic`になっていること、`job get`の`worker`の名前に`periodic`が含まれ、`default`でないことを見る。
反映の前に作られたジョブは、`tag`が`bun`のまま残る。

続けて、`auto_retry_pr_review`の`job list`の`created_at`と`started_at`が、5分刻みで1件ずつ並ぶことを見る。
スケジュールは、今のジョブの開始時に次の回を1件だけ積み、queueは予定時刻の順に拾う、という前提を確かめるためである。
同じ予定時刻のジョブが複数並ぶときや、`started_at`が予定時刻から大きく遅れるときは、前提が崩れている。

付与を戻すときは、`*.script.yaml`から`tag: periodic`の行を消して反映する。
反映の後に作られるジョブは、defaultのworkerで動く。
tag `periodic`で既にqueueに入ったジョブは、定期ジョブ用のworkerが動いていれば、そのworkerが処理する。
workerが動いていないときは、queueに残ったtag `periodic`のジョブが消えない。
`mise run up`でworkerを起動して処理させるか、Windmillの画面か`wmill job cancel <ジョブのID>`で取り消す。
tagを外して反映した後は、次の回のスケジュールが積まれることを`wmill job list --script-path <scriptのパス>`で確かめる。
Windmillが次の回を積む時点の挙動は、実機で確かめていない。

## defaultのworkerの検知を確かめる

defaultのworkerが止まっていないかは、tag `periodic`のscript `default_worker_watch`が5分ごとに確かめる。
defaultのworkerの中で動くscriptは、そのworkerが止まると動かず、止まったことを知らせられない。
そこで、定期ジョブ用のworkerで動かす。
定期ジョブ用のworkerが止まったことは、逆に、defaultのworkerで動く`self_update`が確かめる([定期ジョブ用のworkerの検知を確かめる](#定期ジョブ用のworkerの検知を確かめる))。
このscriptは、defaultのworkerの確認の後に、scheduleの失敗を拾う検出器が止まっていないかも確かめる([scheduleの失敗の検出](#scheduleの失敗の検出))。
2つの確認は独立していて、片方が失敗しても、もう一方を止めない。

通知するのは、defaultのworkerが止まっているときだけである。
枠がすべて塞がっていた割合や、queueの待ちの長さでは通知しない。
Claudeの長いジョブ(実装は最長6時間)がdefaultの枠を埋め、後ろのジョブが長く待つのは、設計どおりの状態だからである。
通知しても運用者の行動につながらない。
枠の占有の記録は、日次のまとめとConsoleのシステムの画面で見える([枠の占有](#枠の占有))。
待ちが長いことと、defaultで動いているジョブが無いことの両方が成り立つときだけ、通知する。

判定は、次の順に決める。
実行中のジョブと、予定時刻を過ぎても実行が始まっていないジョブを、それぞれ100件まで読む。
待ちは古い順に読む。

1. 待ちの応答が一覧の形でなければ、判定できないものとして扱う。
2. defaultのworkerが受けるtagのジョブの最長の待ちが10分未満なら、問題なしと判定する。
   ただし、待ちの一覧に形の読めない要素がある場合と、一覧が1ページを埋めている場合は、判定できないものとして扱う。
   10分以上の待ちを読み落としている可能性を、除けないためである。
   defaultのworkerが受けるtagは、[枠の使用数の数え方を確かめる](#枠の使用数の数え方を確かめる)の数え方と同じである。
   tag `console`、tag `periodic`、nativeのworkerのtagのジョブは、defaultの枠を使わないので数えない。
3. defaultで動いているジョブが1つでもあれば、問題なしと判定する。
   フローの親ジョブは、動き出した後は枠を使い続けないので、動いているジョブに数えない。
4. 実行中の一覧に、次のどれかがあるときは、判定できないものとして扱う。
   形が読めない要素、受けるworkerが分からないtagの要素、1ページを埋める件数である。
   それらがdefaultで動いている可能性を、除けないためである。
5. それ以外は、止まりの候補とする。

1回の観測では止まりと決めない。
ジョブの切り替わりの隙間や、workerを作り直す瞬間には、長い待ちがあるのに動くジョブが無い観測も起こりうるためである。
候補になったときは、同じ実行の中で60秒おいて、2つの一覧を読み直す。
最も古い待ちのジョブIDが同じままで、defaultで動くジョブが無いときだけ、止まりと判定する。
止まりと判定すると、通知`default_worker_missing`を残してDiscordにも送る。
最も古い待ちが別のジョブに替わっていたり、defaultで動くジョブが現れたりしていれば、queueは動いているので問題なしと判定する。
読み直しの失敗や、想定外の形は、判定できないものとして扱う。
1回目が問題なしか判定できないときは、読み直さない。

しきい値の10分は、workerの再起動(`mise run up`)で受けない間と、ジョブを拾うまでの遅れを見込んだ値である。
動いているジョブが無いので、先に動くジョブの後ろで待っているのではない。
止まってから通知までの遅れは、最大で約20分である。
内訳は、待つジョブが次に予定される時刻までの約90秒、しきい値の600秒、確認の周期の300秒、読み直しの60秒である。
読み直しを含めると、確認の上限は100秒になる(観測ごとの上限20秒を2回と、おく60秒)。
続けて行う検出器の確認の上限10秒を足しても110秒で、scriptの`timeout`の120秒に収まる。

待ちが10分未満になるか、defaultで動くジョブが現れると、残した通知を自動で解決する。
一覧を読めなかった回、応答の形が想定外の回、時間切れの回は、判定できないものとして扱う。
通知は出さず、残した通知も解決しない。
確認できない状態が続いても、運用者の行動につながらないので、通知にはしない。
scriptのジョブログに警告を残す。

警告は次の6種類である。

- `could not list the waiting default jobs`: 待っているジョブの一覧を読むAPIが失敗した。
  権限が足りないときもこうなる。
- `could not list the running default jobs`: 実行中のジョブの一覧を読むAPIが失敗した。
- `could not confirm the default worker from the job lists`: 応答が想定外の形で、判定できない。
- `could not read the id of the oldest waiting default job`: 最も古い待ちのジョブIDが読めず、読み直しで同じジョブかを比べられない。
- `could not wait before reading the default jobs again`: 読み直す前のおく時間が失敗した。
- `default worker check timed out`: 確認全体の上限(100秒)以内に終わらなかった。

通知が立つのは、workerが居ないときだけではない。
workerが居ても、ジョブを受けられない状態のときにも立つ。
通知の次の操作に従い、コンテナの状態、`mise run up`での起動、Windmillの画面のWorkers画面の順に確かめる。
通知を記録してからDiscordに送るまでの間にscriptが終わると、通知はConsoleに残るがDiscordには届かない。
次の回は同じ通知を重ねて記録しないので、Discordへは送り直されない。
これは、同種の検知と同じ挙動である。

### 拾わない状態

この検知が拾うのは、defaultのworkerだけが止まり、定期ジョブ用のworkerが動いている状態である。
次の状態は拾わない。

- defaultのworkerは居るが、ジョブが毎回すぐ失敗する。
  待ちが短く、止まりと判定されない。
  失敗の検出(`detect_schedule_failures`)は、定期ジョブ用のworkerで動くので、defaultのworkerのジョブが一斉に失敗しても鳴る([scheduleの失敗の検出](#scheduleの失敗の検出))。
- 確認できない状態が続く。
  `unknown`は警告ログだけで、通知にしない。
  ジョブログの警告を見ないと気づけない。
- 定期ジョブ用のworkerとdefaultのworkerが両方止まる。
  Windmillのserver、DB、docker、ホストの共通の障害も同じである。
  互いの監視は、片方だけが止まるときに働く。
  この状態は、外部の死活監視が拾う。
  検出器が5分ごとに叩くURLが途絶えると、監視のサービスが知らせる([セットアップ](../setup.md#外部の死活監視を設定する))。
- 長いジョブ(最長6時間)がdefaultの枠を埋めている間は、`self_update`が待たされ、定期ジョブ用のworkerの確認が走らない。
  その間に定期ジョブ用のworkerが止まっても、気づけない。

次の点に注意する。

- この検知は、定期ジョブ用のworkerが動いていることを前提にする。
  定期ジョブ用のworkerが止まっているときは、`periodic_worker_missing`が拾う。
- `mise run up`でdefaultのworkerを作り直している間は、通知が出うる。
  作り直しが終われば、自動で解決する。
- 待ちの一覧は、古い順に100件までしか読まない。
  defaultのworker以外のtagの古い待ちが100件を超えて並ぶと、defaultの待ちを読み落とす。
  1ページを埋める一覧は判定できないものとして扱うので、誤って問題なしとは判定しない。
- スケジュールの`permissioned_as`は、反映の後に`wmill schedule get f/factory/default_worker_watch --json`で確かめる。

反映の後に、次の手順で検知が動いていることを実機で確かめる。
defaultのworkerを止めて戻すコマンドは次のとおりである。
止めている間は、自己更新も止まる。

```bash
mise exec -- docker compose -f infra/docker-compose.yml stop windmill_worker
mise exec -- docker compose -f infra/docker-compose.yml start windmill_worker
```

1. `stop`でdefaultのworkerを止める。
2. 約20分以内に、通知`default_worker_missing`ができ、Discordにも届くことを見る。
3. `start`で戻す。
   待ちのジョブが動き出して数分以内に、通知が自動で解決されることを見る。

## カスタムtagの許可を確かめる

Consoleのscriptはtag`console`を、定期ジョブ用workerで動かすscriptはtag`periodic`を持つ。
superadminでない主体は、インスタンスのカスタムtagに許可されたtagしか使えない。
許可が無いと、scriptの呼び出しが`Tag console is not included in the allowed CUSTOM_TAGS`のように拒まれる。
運用者のアカウントはsuperadminなので、許可が無くても動き、漏れに気づきにくい。

許可は`mise run doctor`の「カスタムtag」で確かめる。
doctorは、死活を確かめたポート(`WM_HTTP_PORT`)の`127.0.0.1`にだけ、管理者の資格情報を送る。
ログインの前に`/api/version`がWindmillの応答かを確かめ、違えば送らずに止まる。
`WM_BASE_URL`は使わない。
`WM_HTTP_PORT`だけを変えたときに、ポートの取り違えで別のサービスへパスワードを誤って送らないためである。
Windmillを装うローカルのプロセスは防がない。
残るリスクは[セキュリティ](../security.md)の「Console用workerの境界」にある。

| 表示 | 意味 | 対処 |
| --- | --- | --- |
| `OK` | tag`console`と`periodic`のそれぞれが許可されている | 要らない |
| `NG` | tag`console`か`periodic`が許可されていない。tagごとに1行出る | `mise run instance:tags`を実行する |
| `WARN` | 確かめられていない。失敗には数えない。終了コードと、標準エラーの先頭行が添えられる | 添えられた理由を見る。ログインが拒まれたなら、`WM_ADMIN_PASSWORD`が実際のパスワードと合っているかを確かめる |

`NG`になるのは、確認のコマンドが「許可されていない」という専用の終了コードを返したときだけである。
bunやmiseの失敗は、`WARN`として理由を添えて表示する。
環境の不具合を、許可の漏れと取り違えないためである。

`mise run instance:tags`は、既存のtagを保ち、`console`と`periodic`のうち無いものだけ足す。
書き込みの後は、実効の値にtagが現れるまで、数秒の間に数回読み直す。
何度実行しても結果は同じである。
読み取りと書き込みの間に排他は無い。
同じ設定を、Windmillの画面や別の`instance:tags`で同時に編集すると、後の書き込みが先の変更を上書きしうる。
同時には実行しない。

## workerの負荷の記録を確かめる

`sample_worker_load`が2分ごとに、defaultのworkerの負荷を1行ずつ`factory.worker_samples`に記録する。
ポーリングの間隔やジョブのメモリを見直すとき、待ちとメモリのどちらが先に効くかを、この記録で判断する。
直近24時間の最大値と最新の値は、Consoleのシステムの画面の「workerの負荷」で見られる。
閾値を超えたときの通知は[閾値の通知](../operations.md#閾値の通知)にある。
記録の行を読むコマンドは次のとおりである。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT sampled_at, running_jobs, running_by_script, waiting_jobs, max_wait_seconds, lag_seconds, mem_working_set_bytes, mem_anon_bytes, mem_pressure_total_us FROM factory.worker_samples ORDER BY sampled_at DESC LIMIT 10"
```

反映の後は、次の順で動いていることを確かめる。

1. 反映の数分後に、行が2分おきに増えていることを見る。
2. 最新の行で、`mem_pressure_total_us`以外の列が空でないことを見る。
   確かめた環境のworkerには`memory.pressure`が無かった。
   `memory.pressure`が無ければ`mem_pressure_total_us`は空になり、これは異常ではない。
   あれば値が入る。
3. `wmill job list --script-path f/factory/sample_worker_load`で直近のジョブを選ぶ。
   `wmill job result <id>`の`outcome`が`complete`であることを見る。
   `partial`や`failed`なら、`wmill job logs <id>`の警告から原因を探す。
4. 記録のジョブは、defaultのworkerが1つなので、ほかのジョブが動いていない間にしか動かない。
   そのため、`running_jobs`は常に0で、`running_by_script`は空になる。
   0が数え落としでないことは、[枠の使用数の数え方を確かめる](#枠の使用数の数え方を確かめる)に従って確かめる。

### 枠の占有

- `running_jobs`は、実行中のジョブのうち、defaultのworkerが受けるtagのものの数である。
  記録するジョブ自身は数えない。
- 記録のジョブは、枠が1つ空いたときにしか動かない。
  そのため、`slots`の枠がすべて埋まった状態は、行として残らない。
- defaultのworkerは同時に1つのジョブしか動かさず、記録のジョブ自身がその1つを使う。
  そのため、`running_jobs`は常に0である。
  0は数え落としではない。
  記録のジョブが動けるのは、ほかに動くジョブが無い間だけだからである([枠の使用数の数え方を確かめる](#枠の使用数の数え方を確かめる))。
- 塞がりの目安は、`lag_seconds`の大きさと、`sampled_at`の間隔の空白である。
  `running_jobs`の大きさでは判定しない。
  Consoleの「枠が塞がっていた記録」は、他のジョブが使える枠のある記録(`slots`が2以上)だけを数える。
  枠が1つの記録は数えないので、「不明」と表示される。
  空白だけでは停止と区別できないので、見分け方は[予定の欠け](#予定の欠け)と[日次のまとめでの見方](../operations.md#日次のまとめでの見方)に従う。
- 内訳は`running_by_script`に、件数の多い10件のscriptのパスと、残りをまとめた`other`で載る。
- 数えるtagは、Windmillの既定でdefaultのworkerグループが受けるものである。
  `infra/docker-compose.yml`の`windmill_worker`は`WORKER_TAGS`を設定しないので、既定が使われる。
- tag `console`のジョブはConsole用のworkerが、tag `periodic`のジョブは定期ジョブ用のworkerが動かす。
  tag `postgresql`などnativeのworkerが受けるtagのジョブは、nativeのworkerが動かす。
  どちらも数えない。
- `wmill.datatable()`のクエリは、tag `postgresql`のプレビューとして投げられ、nativeのworkerが動かす。
  tag `bun`のジョブは、defaultのworkerが動かす。
  どちらも実機で確かめている。
- 動き出したフローの親ジョブは、枠を使い続けない。
  実際の処理は子のscriptが枠を使うので、実行中には数えない。
  まだ始まっていない親は、枠が空くのを待つので、待ちには数える。
- どのworkerが受けるかを知らないtagのジョブは、数えない。
  ジョブログに、件数とtag名の先頭5件が、記録のたびに1回、警告として残る。

### 枠の使用数の数え方を確かめる

`running_jobs`がずっと0のとき、数え落としか、本当に0かを次の順で確かめる。
読み取りだけで、実行や設定の変更はしない。
Windmill本体のデータベースは`windmill`、`factory.worker_samples`は`datatable_db`にあり、どちらも`db`のコンテナで読む。
次の例は、`windmill`を読む形である。
`datatable_db`を読むときは、`-d`の値を変える。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d windmill -c "SELECT 1"
```

1. 記録のジョブの権限で、ジョブの一覧が絞られていないことを確かめる。
   記録のジョブは、スケジュールを作ったユーザーの権限で動く。
   `usr`表の`is_admin`が真なら、一覧は絞られない。

   ```sql
   SELECT DISTINCT j.permissioned_as_email, u.is_admin
   FROM v2_job j
   JOIN usr u ON u.workspace_id = j.workspace_id AND u.email = j.permissioned_as_email
   WHERE j.runnable_path = 'f/factory/sample_worker_load'
     AND j.created_at > now() - interval '1 day'
   ```

2. 数える対象のtagに漏れが無いことを確かめる。
   `v2_job`表の`tag`の一覧が、defaultのworkerが受けるtagと、nativeやConsole用のworkerが受けるtagに収まっていればよい。
   前者は`f/factory/lib/worker_load_support.ts`の`DEFAULT_WORKER_TAGS`、後者は`OTHER_WORKER_TAGS`である。
   後者には、Console用と定期ジョブ用のworkerのtagも入る。
   収まらないtagがあれば、記録のジョブのログに警告が出る。
   `job_logs`表で、その警告が無いことも確かめる。

   ```sql
   SELECT tag, count(*) FROM v2_job
   WHERE created_at > now() - interval '7 days'
   GROUP BY tag ORDER BY tag
   ```

   ```sql
   SELECT count(*) AS runs,
          count(*) FILTER (WHERE l.logs LIKE '%no worker is known to listen to%') AS warned
   FROM v2_job j
   JOIN job_logs l ON l.job_id = j.id
   WHERE j.runnable_path = 'f/factory/sample_worker_load'
     AND j.created_at > now() - interval '1 day'
   ```

3. 記録の時刻に動いていたジョブを突き合わせる。
   記録のジョブの`started_at`を記録の時刻とみなし、その時刻に動いていた、数える対象のジョブがある記録の数を求める。
   数えない対象として、記録のジョブ自身とフローの親ジョブ(`FLOW_PARENT_KINDS`)を除く。
   tag `console`、tag `periodic`、nativeのworkerのtag(`OTHER_WORKER_TAGS`)のジョブも除く。
   境界の丸めで数ミリ秒だけ重なるジョブは、100ミリ秒より長く重なるものだけを数えて除く。
   `with_counted_jobs`が0なら、`running_jobs`が0なのは数え落としではない。

   ```sql
   SELECT count(*) AS samples,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1
            FROM v2_job_completed o
            JOIN v2_job oj ON oj.id = o.id
            WHERE oj.workspace_id = 'factory'
              AND oj.runnable_path IS DISTINCT FROM 'f/factory/sample_worker_load'
              AND oj.kind NOT IN ('flow', 'flowpreview', 'unassigned_flow')
              AND oj.tag NOT IN ('console', 'periodic', 'nativets', 'bunnative', 'postgresql',
                                 'mysql', 'mssql', 'graphql', 'snowflake', 'bigquery', 'oracledb')
              AND o.started_at <= s.started_at
              AND s.started_at + interval '100 milliseconds' < o.completed_at
              AND o.completed_at > now() - interval '2 days'
          )) AS with_counted_jobs
   FROM v2_job_completed s
   JOIN v2_job sj ON sj.id = s.id
   WHERE sj.runnable_path = 'f/factory/sample_worker_load'
     AND s.completed_at > now() - interval '1 day'
   ```

   `running_jobs`が1以上の行の数は、`datatable_db`で数える。

   ```sql
   SELECT count(*) AS samples, count(*) FILTER (WHERE running_jobs > 0) AS with_running
   FROM factory.worker_samples
   WHERE sampled_at > now() - interval '1 day'
   ```

4. 同じワーカー名のジョブが、時間で重なるかを見る。
   `v2_job_completed`表の`worker`が同じジョブ同士で、実行の時間が100ミリ秒より長く重なる組を数える。
   フローの親ジョブは、同じworkerの子のscriptと重なるので除く。
   `worker_ping`表では、defaultのworkerの行を、`worker_group`が`default`、`native_mode`が偽で、`ping_at`が直近のものとして選ぶ。
   停止したコンテナの行も残るので、`ping_at`で絞る。

   ```sql
   SELECT count(*) AS overlaps
   FROM v2_job_completed a
   JOIN v2_job ja ON ja.id = a.id
   JOIN v2_job_completed b
     ON b.worker = a.worker AND a.id < b.id
    AND a.started_at + interval '100 milliseconds' < b.completed_at
    AND b.started_at + interval '100 milliseconds' < a.completed_at
   JOIN v2_job jb ON jb.id = b.id
   WHERE a.worker LIKE 'wk-default-%'
     AND a.completed_at > now() - interval '1 day'
     AND b.completed_at > now() - interval '1 day'
     AND ja.kind NOT IN ('flow', 'flowpreview', 'unassigned_flow')
     AND jb.kind NOT IN ('flow', 'flowpreview', 'unassigned_flow')
   ```

   ```sql
   SELECT worker FROM worker_ping
   WHERE worker_group = 'default' AND NOT native_mode
     AND ping_at > now() - interval '5 minutes'
   ```

確かめた環境の結果は次のとおりである。

- 記録のジョブは管理者の権限で動き、一覧は絞られない。
- ジョブのtagは`bun`、`flow`、`dependency`、`console`、`postgresql`だけで、未知のtagは無い。
  ジョブログに未知のtagの警告は無い。
- 記録の時刻に、数える対象のジョブが動いていた記録は無い。
  `running_jobs`は、数え落としではなく、実際に0だった。
- Claudeのジョブが動いている間の記録は、そのジョブのステップが終わった直後に始まる。
  開始が遅れ、`lag_seconds`に出る。
- defaultのworkerは、コンテナごとに`worker_ping`の行が1つで、同じワーカー名のジョブは実質的に重ならない。
  重なるのは、境界の数ミリ秒の丸めと、フローの親ジョブだけである。
  同時に動くジョブは1つである。
  Claudeのジョブが動く間、記録のジョブも、ほかの定期のジョブも待つ。
  tag`periodic`を付けた定期ジョブは、定期ジョブ用のworkerが動かすので待たない。
  該当するのは、`notify_daily_summary`、`auto_retry_pr_review`、`collect_github`、`default_worker_watch`である。
- 1つのコンテナで複数のworkerが動くと、`worker_ping`の行も複数になる。
  nativeのworkerは1つのコンテナに8行あり、名前の末尾が行ごとに違う。
  defaultのworkerの1行は、複数のworkerが1行にまとまった表示ではない。
- Windmill 1.817.0は、nativeでないworkerの`NUM_WORKERS`が2以上だと、1に落とす。
  そのため、defaultのworkerとConsole用のworkerは、`NUM_WORKERS`を置かず、コンテナにつき1つで動く。
  nativeのworkerは、`NATIVE_MODE`で8つに固定される。
- `NUM_WORKERS`を2にして起動すると、起動の初めに次の警告が出る。
  `NUM_WORKERS=2 > 1 is only safe for native workers. Falling back to NUM_WORKERS=1.`
  起動ログの設定の行には`NUM_WORKERS: 2`と出るので、環境変数は届いている。

workerが1つであることは、`worker_ping`の行の数で確かめる。
`worker_group`が`default`、`native_mode`が偽で、`ping_at`が直近の行が1つであればよい。

### 並列に動かす別の手段

環境変数`I_ACK_NUM_WORKERS_IS_UNSAFE`を足すと、`NUM_WORKERS`の制限が外れ、警告が次の文に変わる。
`Running with NUM_WORKERS=3 without native mode. This is not recommended.`

この手段は採らない。
信頼できない入力を扱うジョブが同じコンテナで並列に動くので、ジョブ同士の分離が弱まる。
Windmillも推奨していない。
並列に動かすなら、コンテナを増やす(`deploy.replicas`)形になる。
その場合は、共有のボリュームと検査の枠の設計を見直す必要がある。

再現した範囲は、使い捨てのコンテナで、警告が上の文に変わることまでである。
コンテナは、ネットワークと実機のデータベースに届かない。
実機のworkerで、行が3つになることは確かめていない。

### queueの待ち

- `waiting_jobs`と`max_wait_seconds`は、予定時刻を過ぎても開始していないジョブを、古いものから100件まで読んで数える。
  予定時刻が未来のジョブは数えない。
  待つジョブが無ければ`max_wait_seconds`は0になる。
- 記録するジョブ自身が始まった後の様子なので、`max_wait_seconds`は自分の遅れ(`lag_seconds`)で打ち切られる。
  待ちの深さの下限として読む。
- `lag_seconds`は、記録するジョブ自身の予定時刻(`scheduled_for`)から開始までの秒数である。
- `sampled_at`は、値を読み始めた時刻である。
  挿入のジョブが遅れても、測った時刻が残る。

### 枠の数

`slots`は、コードの定数`DEFAULT_WORKER_SLOTS`で、行の値は記録時点のコードの値である。
workerから読んだ値ではない。
nativeでないworkerは1つで動くので、値は1である。
`DEFAULT_WORKER_SLOTS`が1でなくなると、テストが落ちる。

### メモリ

- `mem_current_bytes`は、ページキャッシュを含む。
  上限に近くても、回収できるキャッシュなら逼迫ではない。
- 逼迫の判断には、プロセスが確保した`mem_anon_bytes`と、非アクティブなファイルキャッシュを除いた`mem_working_set_bytes`を使う。
  主に`mem_anon_bytes`を読む。
- `mem_peak_bytes`は、コンテナの起動からの累積の最大値で、キャッシュも含む。
  判断には使わない。
  前の行より増えたかどうかを見る印にだけ使う。
- 上限への到達は、`mem_events_max`、`mem_oom`、`mem_oom_kill`で見る。
  どれもコンテナの起動からの累積の回数なので、前の行との差を取る。
- 読めなかった値は空のまま残る。
  0は、読めて0だったことを表す。
- `mem_limit_bytes`の空は、上限が無いことと、読めなかったことの両方を表し、区別できない。

### 予定の欠け

予定の欠けは、行の`sampled_at`の間隔で数える。
間隔が2分より開いていれば、その間の予定が実行されていない。
枠が塞がると、予定時刻から開始までが遅れ、さらに塞がると予定そのものが飛ばされる。
ホストのスリープ、`mise run up`によるworkerの作り直し、Windmillの再起動でも、予定が飛ばされ、再開直後の遅れが大きくなる。
塞がりの割合は、行数ではなく、遅れの合計か、欠けた予定の回数を窓の長さで割った値から求める。
欠けや遅れが塞がりによるのか停止によるのかは、空白の時刻にジョブが動いていたかで見分ける。

### 限界

- 割合の通知は、記録が止まる間は判定が動かない。
  Claudeのジョブが動く間は、枠が塞がって記録のジョブが動けず、最もメモリが膨らむ間は判定されない。
  早めの警告として効くのは、Claudeのジョブの前後に、8割を超える場合だけである。
  Claudeのジョブの最中の膨らみは、OOMの通知が出るまで来ないことが多い。
- メモリの通知は、取りこぼす経路がある。
  割合は`mem_anon_bytes`で判定するので、共有メモリ(shmem、`/dev/shm`)やカーネルのメモリは数えない。
  2分の間に起きた急な山は、記録の瞬間に無ければ見えない。
- OOMの増分は、コンテナの再起動をまたぐと見落とすことがある。
  OOMで落ちて作り直されたコンテナは、累積が0から始まる。
  再起動の直後の記録が0なら、増えたと見なさない。
  前後で同じ値になった場合も、増えたと見なさない。
  再起動の目安は、`mem_peak_bytes`が前の行より減った回である。
- OOMの通知は、最新の行での増分だけで判定する。
  増えた回に通知を残せないと、次の回は差が0になり、そのOOMは通知されない。
  ジョブログに警告だけが残る。
  通知を持ち越す仕組みは足さない。
- 2分より短い塞がりは見えない。
  値は、記録した瞬間の様子である。
- 日への振り分けは`sampled_at`で行う。
  日をまたぐ遅れがあると、1日の行数が721行になりうる。
  欠けは0%に丸めて表示する。
- 空白は、`sampled_at`の間隔で数える。
  隣り合う行の間隔に加えて、日の両端も数える。
  範囲の最初の行は、始端の10分前までの直近の行との間隔で、その行が無ければ始端との間隔で数える。
  最後の行は、終端との間隔で数える。
  正常な日の両端の間隔は、記録の周期と遅れの範囲に収まり、4分を超えない。
- 日をまたぐ1回の停止は、前日の終わり側と当日の始まり側の空白に分かれて出る。
  23時から8時までのホストのスリープなら、前日に1時間、当日に8時間の空白が出る。
- OOMの増分は、再起動で累積が戻ると現在値を数える。
  累積が戻った後、前の値を超えるまでに増えた分は、再起動と判別できず、差だけを数えるので、増分を少なく数えうる。
- OOMで落ちて作り直されたworkerでは、新しいcgroupの`memory.events`が0から始まるので、workerを止めたその1回が記録されない。
  `mem_peak_bytes`が前の行より減った回は、再起動の目安になる。
  ただし、集計では使っていない。
- 5分ごとの`poll_*`が作る山は、2分ごとの記録の位相に入らないことがある。
  記録は30秒に始まり、`poll_*`は0秒に始まる。
  山に当たる回の割合は偏るので、行の平均を占有率として使わない。
- `waiting_jobs`は100件で頭打ちになる。
  `max_wait_seconds`は古い順に読むので、頭打ちでも正しい。
- 実行中のジョブの一覧が100件を超えると、全件を読めない。
  100件に達した一覧は打ち切られているので、そこに自分のジョブが無くても、読めた回として扱う。
- 実行中と待ちの一覧は、スケジュールの実行ユーザーの権限で見える範囲に絞られる可能性がある。
  絞られると、`running_jobs`と`waiting_jobs`は実際より少なくなる。
  この前提は確かめていない。
  反映の後の手順5で、管理者の件数と合うかを見る。
- メモリはコンテナ全体の値で、ジョブごとの内訳は取れない。
  内訳は`running_by_script`の件数から推す。
- `memory.pressure`が無い環境では、`mem_pressure_total_us`は空になる。
- tagの割り当てを変えたときは、数えるtagの一覧(`DEFAULT_WORKER_TAGS`)を直す。
  変えるのは、defaultのworkerに`WORKER_TAGS`を設定したときと、nativeのworkerのtagを変えたときである。
- 単一ステップのフロー(`singlestepflow`)の親ジョブは、枠を使うかを確かめていないので、除かずに数える。
  `running_jobs`が多めに出うる。
- 2分ごとの実行は、1回ごとに、記録のジョブ(tag `bun`)と、挿入のジョブと直近の記録を読むジョブ(どちらもtag `postgresql`のプレビュー)ができる。
  Windmillのジョブ履歴とログに、1日に2160件以上を足す。
- 失敗が続く間は、noticeを扱うクエリのジョブも加わる。
- ジョブ履歴の保持期間は、公式文書では自前運用の無償版(Community Edition)で最大30日である。
  1日2160件の増加と合わせると、記録だけで約6.5万件が履歴に残りうる。
  保持期間を変える設定(`retention_period_secs`)はEnterprise Editionだけで、実機のインスタンス設定にも行が無い。
  設定が未設定のときの既定値は、Windmillのソース(`backend/src/monitor.rs`の`retention_period_secs`の読み込み)で30日(2592000秒)と確かめた。
  公式文書には既定値の数値が無い。
  `self_update`は2分ごとなので1日に720件を足し、30日で約2.2万件になる。
  `auto_retry_stale_image`は、候補があるときと通知を解決した回だけ起動するので、`self_update`の間隔に比例して増えない。
- 記録の表は、DBの掃除が、`sampled_at`から30日(`retention_logs_days`)を過ぎた行を消す。
  掃除が毎日動いていれば、行数は約2.2万行で頭打ちになる。
  詳しくは[保持期間](../operations.md#保持期間)の節に書く。
- 掃除は、保持期間を過ぎた行をすべて消す。
  記録が保持期間より長く止まると、最後の標本も消え、「止まった」と「一度も記録していない」を表から区別できなくなる。
  この表の窓を読んで判定する処理は、窓に標本が無いときを「判定できない」として扱う。

### 記録できない状態

記録が取れない状態は、ジョブが成功のまま続く。
`sample_worker_load`は例外を投げないので、スケジュールの失敗の通知(`schedule_failing`)は出ない。
代わりに、完全には記録できない回を数え、5回(10分)続くと通知`worker_sample_failed`を残す。
完全に記録できた回は、次をすべて満たす回である。

- queueの2つの応答が一覧で、空でなければ、形を読める要素が1つ以上ある。
  空の一覧も、完全な回になる。
- 実行中の一覧から、記録するジョブ自身を読めた。
  100件未満の一覧に自分が居ない、またはその`tag`と`job_kind`が読めないときは、応答の形が変わったと見なす。
  この場合は`running_jobs`と`running_by_script`を空にして、完全な回に数えない。
- `memory.current`と`memory.stat`の`anon`が読めた。
- 記録するジョブ自身の予定時刻と開始の遅れが取れた。
- 行の挿入が成功した。

`memory.peak`と`memory.pressure`が読めなくても、完全な回として数える。
回数はWindmillのstateに持つ。
stateを読めなかった回は、数えず、stateも書かない。
stateを読めない状態が続くと、失敗が数えられず、通知も出ない。
ジョブログの`could not read the sampling state`が続いていないかを、反映の後に見る。

stateはscriptのパスごとに持つ。
パスを変えたときや、stateを消したときは、回数が0から読み直される。
直前に未解決の`worker_sample_failed`があっても、回数が上限に届かないので、自動では解決されない。
その場合は、人がConsoleから解決する。

完全な回に戻り、直前の連続失敗の回数が上限(5回)以上だったときは、`worker_sample_failed`を自動で解決する。
解決者は`sample_worker_load`である。
解決に失敗した回は、回数を戻さず、次の回でやり直す。

外への呼び出しは、1回5秒、全体で20秒までに区切る。
ジョブの上限(`timeout`は30秒)より前に終えるためである。
全体の20秒を使い切ると、残りの呼び出しは飛ばす。
実行中の一覧の取得が失敗した回は、自分のジョブの情報を直接は読まない。

警告は、ジョブログに次の文で残る。

- `could not read the running jobs`、`could not read the waiting jobs`: queueを読むAPIが失敗した。
- `could not read the sampling job`: 自分のジョブの情報を直接読むAPIが失敗した。
  `lag_seconds`だけが空になる。
- `the running jobs response has elements of an unexpected shape`: 形を読めず、数えなかった要素がある。
  `malformed`に件数が載る。
- `the waiting jobs response has elements of an unexpected shape`: 待ちの一覧で、同じ状態になった。
- `the running jobs response has an unexpected shape`: 応答が一覧でないか、すべての要素の形を読めない。
- `the waiting jobs response has an unexpected shape`: 待ちの一覧で、同じ状態になった。
- `the sampling job is not readable in the running jobs`: 実行中の一覧から、記録するジョブ自身を読めなかった。
- `jobs with a tag no worker is known to listen to are not counted`: どのworkerが受けるかを知らないtagのジョブがある。
  `jobs`に件数、`tags`にtag名の先頭5件が載る。
  そのジョブは数えないので、`running_jobs`と`waiting_jobs`が少なく出うる。
  defaultのworkerが受けるtagなら、`DEFAULT_WORKER_TAGS`に足す。
- `could not read memory.current`: cgroupのファイルを読めなかった。
  `memory.max`、`memory.stat`、`memory.events`も同じ形の文になる。
- `could not record the worker sample`: DBへの挿入が失敗した。
  この回は行が残らない。
- `could not read the sampling state`: stateを読めなかった。
  この回は失敗を数えず、stateも書かない。
- `could not resolve the sampling failure notice`: noticeの解決に失敗した。
  noticeが残り、回数は戻さず、次の回で解決をやり直す。
- `could not write the sampling state`: stateへの書き込みが失敗した。
  この回の回数が残らず、次の回は前の値から数え直す。
- `could not update the sampling failure count`: 回数の更新の途中で例外が出た。
  主な原因はnoticeの記録の失敗で、この回は通知が残らない。
  回数が上限以上の間は、次の回で記録をやり直す。

## scheduleの失敗の検出

このWindmillは、scheduleの失敗時の呼び出し(`on_failure`)を呼ばない。
そのため、どのscheduleにも`on_failure`を設定しない。
scheduleが起こしたジョブの失敗は、script`detect_schedule_failures`(検出器)が、Windmillのジョブ履歴から拾う。
tag `periodic`のworkerで、5分ごとに動く。
defaultのworkerで動かすと、長いジョブ(実装は最長6時間)が枠を塞ぐ間、検知が止まるためである。

拾った失敗は、`factory.job_failures`に記録し、Discordの`job_failed`と、要対応の`schedule_failing`で知らせる。
失敗の発生から通知までは、最大5分遅れる。

### 拾う失敗

拾うのは、`f/factory/`の下のscriptかflowで、scheduleが起こした根のジョブの失敗である。
Factory以外の個人のscheduleは拾わない。
次の実行は拾わない。

- scheduleが起こしていない実行。
  手動の実行とpreviewである。
- 前回の実行中で見送られた回(`is_skipped`)。
- 人が取り消した実行。

ジョブの上限(`timeout`)による取り消しは、失敗として拾う。
ジョブ履歴で`canceled_by`が`timeout`のものである。
この値は実機で未確認である。

記録の`flow_path`は、失敗したscriptかflowのpathにする。
連続した失敗の判定が読むジョブ履歴と同じ値である。

### 読む範囲

前回の続きの位置は、検出器自身の直近の成功したscheduleの実行の結果に、`processed_until`として持つ。
手動の実行、preview、前回の実行中で見送られた回(`is_skipped`)は数えない。
見送られた回の`success`の値は、実機で未確認である。
表は足さず、変数も増やさない。
続きの位置と心拍の元のデータは、ジョブ履歴の1か所に集まる。

完了ジョブの一覧の要素には、`completed_at`が無い。
実機で確かめた。
要素にあるのは`created_at`、`started_at`、`duration_ms`(ミリ秒の数値)などである。
完了時刻は、`started_at`に`duration_ms`を足して求める。
`duration_ms`が数値でない要素は、読めない要素として数える。
その回は警告`the failure list has elements that could not be read`を残し、IDと欠けている項目の名前を最大5件載せる。
値は載せない。

一覧は`created_at`の昇順で返る。
実機で確かめた。
逆転は0件で、`started_at`では逆転する。

- 完了時刻が続きの位置以降の失敗を、新しい失敗とする。
- 一覧は開始時刻でしか絞れないので、続きの位置の7時間前から開始したジョブを読む。
  `timeout`を持たないscriptが、インスタンスの`job_default_timeout`(21600秒以上にする決まりである)まで動きうるためである。
- 続きの位置が現在から24時間より古いときは、24時間前から読む。
  このとき、警告`the last scan is older than the maximum window; scanning the last day only`を残す。
  検出器が長く止まった後に、古い失敗を束で届けないためである。
- 通常の回は、次の`processed_until`を、この回の開始の1分前にする。
  全件を読み終えた回も、ページの上限で打ち切った回も同じである。
  完了時刻の記録と一覧への表示のずれで取りこぼさないためである。
  重なった分は、記録済みとして飛ばす。
- 1回に読むのは、100件の5ページまでである。
  上限に達したら、読んだジョブの作成時刻の最大を、結果の`scan_started_after`に入れて成功で終える。
  あわせて、この回が完了時刻の下限に使った基準を、`scan_completed_from`に入れる。
  この回の`processed_until`は、通常の回と同じに、この回の開始の1分前まで進める。
  次の回(続きの回)は、`scan_started_after`をそのまま開始時刻の下限にし、遡りを引かない。
  完了時刻の下限は`scan_completed_from`を引き継ぎ、0にはしない。
  0にすると、基準を作った直後に打ち切られたとき、過去の失敗を記録する。
  続きの回は、`processed_until`を進めずに、前回の値のまま返す。
  重なりは、記録済みの除外で吸収する。
  続きを読み終えた後の通常の回が、`processed_until`と7時間の遡りで読み直す。
  打ち切った回の時点で実行中で、後から失敗したジョブは、続きの回の下限より前に開始している。
  この読み直しで拾う。
  完了時刻で絞ると、未読の失敗のうち、開始が遅く完了の早いものを落とす。
  溜まった失敗を読み直し続ける問題も起きる。
  `scan_started_after`が24時間より古いときは、24時間前を下限にする。
  上限に達して、要求した下限より後に作成されたジョブが1件も読めないときだけ、進めないので例外にする。
- 前回の実行の結果を読めないときは、例外にして次の回に任せる。
  前回の実行が24時間より古ければ、24時間前から読み、次の警告を残す。
  `could not read the result of the previous run, which is older than a day; scanning the last day only`
  読めない状態が続いても、24時間で抜けるためである。
- 初回(成功した実行が無い)は、何も記録せず、続きの位置だけを作って成功で終える。
  過去の失敗をさかのぼって通知しない。
- 失敗した回は成功に数えないので、続きの位置が進まず、次の回が同じ範囲をやり直す。

### 記録と通知

失敗したジョブのIDを、`job_failures`の`job_id`とルートのジョブIDに記録する。
発生時刻は、失敗したジョブの完了時刻(開始時刻に所要時間を足した値)である。
`step`が空の行に同じジョブIDがあれば、記録済みとして飛ばす。
記録してから通知する。
表に一意索引は足さない。
同じ失敗が重なりうる経路は2つある。
1つは、1回の読み込みの中でページがずれて、同じジョブが2回出ることである。
抽出の段階で、ジョブIDにより1件にする。
もう1つは、手動の実行とpreviewの並行である。
下の既知の限界に書く。
scheduleの実行同士は、定期ジョブ用のworkerの枠が1つで、`no_flow_overlap`もあるので、並行しない。

エラー文は、失敗したジョブごとに`JobService.getJob`で読む。
制御文字を落とし、秘密をマスクし、2000文字に切る。
秘密の途中に制御文字があると、先にマスクしても一致しないので、この順にする。
制御文字を落とすのは、NULがtextの列に入らず、記録が毎回失敗して続きの位置が止まるためである。
改行とタブは残す。
読めなければ、読めなかった旨の固定の文で記録し、警告`could not read the error of a failed job`を残す。

通知は、scriptごとにまとめて、古い失敗から処理する。

1. 前回の失敗を、記録の前に1回だけ読む。
   束の2件目以降の前回は、束の直前の件とする。
2. 記録は全件に行う。
3. `job_failed`の判定は、束の全件に当てる。
   同じスケジュールの連続した失敗の初回と、前回の失敗からエラー文が変わったときだけ、通知の対象にする。
   1件でも該当すれば、そのscriptにつき1回だけ、最新の失敗の内容で送る。
   長い停止の後に、同じ失敗が束で届くのを防ぐ。
4. 直近3回の実行が続けて失敗しているかの判定(`schedule_failing`)は、scriptごとに1回、最後に行う。
   noticeを新しく残したとき、まだ`job_failed`を送っていなければ、Discordにも送る。

通知は、scriptの記録が終わった直後に送る。
後のscriptの処理で止まっても、記録済みのscriptの通知は残る。
記録に失敗した失敗は、通知もしない。
続きの位置が進まないので、次の回が記録と通知をやり直す。
記録に1件でも失敗した回は、残りを処理してから例外にする。

### 見えていない状態の検知

権限が足りないと、ジョブの一覧は黙って空になる。
空のままでは、失敗が無いことと区別できない。
そのため毎回、直近15分に開始した、検出器以外のscheduleのジョブが見えることを確かめる。
対象は、定期ジョブ用のworker(tag `periodic`)のジョブに絞る。
絞らないと、新しい20件が、scheduleの無い`console_query`のジョブで埋まり、見えていないと誤って判定する。

- 見えなければ、直近24時間で1件見えるかを確かめる。
  15分だけ見えない場合は、ホストのスリープ明けなどを疑い、警告`no job of another schedule started in the last 15 minutes`だけで続ける。
- 24時間でも見えなければ、権限不足の疑いがあるとして、例外にする。
  成功に数えないので、心拍が止まる。
  ただし、前回の続きの位置が24時間より古い回は、検出器が長く止まっていて見えないのが当然である。
  次の警告だけで続ける。
  `no job of another schedule is visible in the last 24 hours; continuing because the last scan is older than a day`

### 既知の限界

- 記録をやり直すと、同じscriptの`job_failed`が重なりうる。
  束の途中で記録に失敗した回は、記録できた分の通知を送った後に、残りを次の回が記録し、前回の失敗との比較で改めて通知の対象になりうるためである。
- 時間切れの取り消しで`canceled_by`が`timeout`になることは、実測まで未確認である。
  違う値なら、打ち切られた回は拾えない。
- 見送られた回の`success`の値は、実測まで未確認である。
- 数百件の失敗をこなす回の所要時間は、実測まで未確認である。
  `timeout`の60秒を超えると、その回は成功に数えず、記録済みの分を飛ばして次の回が続ける。
- 打ち切りが続くと、通常の回と続きの回が交互に走り、同じ失敗を読み直す。
  溜まった失敗が遡りの7時間より古くなるまで続く。
  同じ回の中の重複はジョブIDで除き、前の回で記録した分は記録済みの除外で飛ばすので、記録は重ならない。
- 続きの位置には、`created_at`の最大を使う。
  一覧が`created_at`の昇順で返ることは確かめた。
  未読の要素は、作成が後なので、開始もそれ以降になる。
  `startedAfter`が排他であることは、SDKの型の説明による。
  比較が違っても、ミリ秒に切り捨てた値で重なって読むだけで、取りこぼさない。
- 1回で処理する失敗の件数に上限は置かない。
  1回の実行が`timeout`の60秒を超えると、記録した分は残るが、通知が出ない。
  上限を置くと、完了順に処理した最後の失敗から続きの位置を決められない。
  開始時刻と作成時刻の順が完了順とずれるためである。
  最大500件の記録と`getJob`が60秒に収まるかは、実測まで未確認である。
- 前回の続きの位置が24時間より古い回は、見えていることの確認が警告に緩む。
  権限の不足が続いても、検出器は成功し続ける。
  心拍の通知は、24時間ごとに解決と再発を繰り返す。
- 進みが極端に遅い間は、心拍で気づけない。
  検出器は成功し続けるので、通知が出ない。
- 検出器を手動で実行する場合と、previewで実行する場合には、`no_flow_overlap`が効かない。
  効くのはscheduleの実行だけである。
  手動の実行はscriptのtag `periodic`を持つので、同じworkerの枠で順に動き、先の回の記録が見える。
  previewのtagはscriptのtagを持たない。
  defaultのworkerで並行して動き、同じ失敗を二重に記録しうる。
  表に一意索引を足していないので、DBは重なりを止めない。
  この並行は、実機で未確認である。

### 検出器が止まったとき

検出器の心拍は、検出器自身の直近の成功した実行の完了時刻である。
Windmillのジョブ履歴が元なので、検出器は成功を偽れない。
`default_worker_watch`が5分ごとに、defaultのworkerの確認の後に確かめる。
検出器と別のscriptで確かめるのは、同じscriptで確かめると、止まったときに誰も気づけないためである。

判定は次の表のとおりである。

| 状態 | 結果 | 動き |
| --- | --- | --- |
| 最後の成功が25分以内 | 問題なし | 残した通知を解決する |
| 最後の成功が25分より古く、見る側のscheduleの実行がその後に3回以上完了している | 止まり | 通知`schedule_detector_stale`を残し、Discordにも送る |
| 同じで、検出器のscheduleが無効 | 無効 | 原因を分けた本文の通知を残し、Discordにも送る |
| 最後の成功が古く、見る側の実行が3回未満 | 判定しない | 何もしない。ホストのスリープ明けなど |
| 成功が1件も無く、scheduleの更新が25分以内 | 判定しない | 何もしない。反映の直後である |
| 成功が1件も無く、scheduleの更新が25分より前 | 止まり。無効なら無効 | 通知を残し、Discordにも送る |
| 履歴やscheduleを読めない、10秒以内に終わらない | 判定しない | 何もしない。警告のログだけ残す |

25分は、定期ジョブ用のworkerの待ちのしきい値(13分)に、検出器の間隔(5分)の2回分を足した値より長い。
待たされて遅れた回と、その次の回が続けて失敗しても、誤って知らせないためである。
検出器自身が履歴を読めずに失敗している間は、最後の成功が古くなるので、この確認が拾う。

通知の本文は、原因ごとの固定の文で、時刻を含めない。
同じ本文の未解決の通知は、重ねて残さない。
解決は、本文の固定の先頭で選ぶので、しきい値を変える前に残した通知も、自動で解決される。

警告は次の6種類である。

- `could not list the runs of the schedule detector`: 検出器の成功した実行の一覧を読めない。
- `could not count the runs of the watch script`: 見る側のscheduleの実行の一覧を読めない。
- `could not read the schedule of the detector`: 検出器のscheduleを読めない。
- `could not record the schedule detector problem`: 通知を記録できない。
- `could not resolve the schedule detector problem`: 通知を解決できない。
- `schedule detector check timed out`: 確認が10秒以内に終わらなかった。

### 拾わない状態

- 検出器と`default_worker_watch`が同時に黙って止まる状態。
  どちらも、定期ジョブ用のworkerで動く。
  定期ジョブ用のworkerが止まった状態は、`self_update`の`periodic_worker_missing`が拾う。
- Windmillのserver、DB、docker、ホストの共通の障害。
  この障害は、外部の死活監視が拾う([セットアップ](../setup.md#外部の死活監視を設定する))。
  検出器が成功した回だけURLを叩くので、検出器が例外で終わり続ける状態も拾う。
- 失敗が起きてから、最大5分より前の通知。
- ジョブ履歴に残らない失敗。
  履歴から消えたジョブは読めない。
- ジョブの一覧を、検出器と`default_worker_watch`の両方が読めない状態。
  たとえばscheduleの`permissioned_as`の主体からAPIの権限が外れたときに起きる。
  検出器は例外で終わり続け、成功が無いので、記録と通知が残らない。
  心拍の確認は、一覧を読めないので判定せず、警告のログだけを残す。
  この状態は、外部の死活監視が拾う。
  外部の死活監視を設定していなければ、Windmillのジョブ履歴を人が見て気づく。

### 確かめ方

反映の後、検出器のscheduleが有効になり、初回の実行が基準を作る回として成功する。
次の手順で動いていることを確かめる。

1. 検出器の直近のジョブが成功していることを見る。
   `wmill job list --script-path f/factory/detect_schedule_failures --limit 3`でジョブを選び、`wmill job result <ジョブのID>`の`mode`が、初回は`bootstrap`、以降は`scan`であることを見る。
2. 初回の後に、`job_failures`の`step`が空の行が、過去の失敗の分だけ増えていないことを見る。
3. scheduleから`on_failure`の行を外した反映で、サーバー側のscheduleの`on_failure`が消えたかを見る。
   `wmill schedule get <scheduleのpath> --json`で、`on_failure`が`null`か無いことを確かめる。
   行を外した反映で消えるかは、実機で未確認である。
   消えなくても、このWindmillは呼ばないので、動きは変わらない。
   旧ハンドラ`f/factory/on_error_schedule`は、反映が`--keep-deleted`を付けるので、サーバーに残る。
   害は無い。
   `mise run push:prune`で消すのは任意で、人が実行する。
4. 使い捨てのscheduleを失敗させて、記録と通知を確かめる。
   scriptは`f/factory/_probe_`で始まる名前にする。
   検出器は`f/factory/`の下だけを拾う。
   scheduleは2分ごとにし、`on_failure`を付けない。
   3回失敗させた後で、`step`が空の行が、回数分、重複せずにできることを見る。
   初回に`job_failed`が、3回目に`schedule_failing`が出ることも見る。
   行の`occurred_at`と`root_job_id`が、失敗したジョブのものであることも見る。
5. 検出器のスケジュールを止めて、心拍を確かめる。
   凍結で止める。

   ```bash
   mise run freeze:place -- --target f/factory/detect_schedule_failures --minutes 40 --reason "心拍の確認"
   ```

   Windmillの画面でscheduleを無効にしても、次の反映で戻る。
   25分と見る側の次の実行のあとに、`schedule_detector_stale`ができ、Discordにも届くことを見る。
   凍結を解除し、検出器が成功すると、通知が自動で解決されることを見る。
6. 終わったら、使い捨てのscheduleを元の状態に戻し、出た通知をConsoleで解決する。
   `job_failures`の使い捨ての行は、[自己更新の打ち切りを確かめる](#自己更新の打ち切りを確かめる)の手順と同じく、SELECTで確かめてから`id`を指定して消す。
   週次の監査(月曜9時30分)の前に消す。

## 続けて失敗するスケジュールの検知を確かめる

スケジュールの直近3回の実行が続けて失敗したかどうかは、検出器(`detect_schedule_failures`)がジョブ履歴を読んで判定する([scheduleの失敗の検出](#scheduleの失敗の検出))。
飛ばされた回(前回の実行中で見送った回)と、人が取り消した回は、失敗として数えず、連続も切らない。
ジョブの上限(`timeout`)で打ち切られた回は、失敗として数える。
時間切れの取り消しは、ジョブ履歴で`canceled_by`が`timeout`になる想定で判定する。
この値は実機で未確認である。
マージの後は、次の手順で検知が動いていることを確かめる。

1. 失敗する状態を作る。
   たとえば、あるスケジュールのscriptを一時的に失敗させるか、直近3回が失敗の状態を用意する。
2. 失敗が3回続いた後で、通知`schedule_failing`ができていることを見る。
3. `detect_schedule_failures`のジョブログに、次のエラーが出ていないことを見る。
   履歴を読めなかったときは`failed to read the schedule history`である。
   通知を記録できなかったときは`failed to record the schedule failing notice`である。
   通知`schedule_failing_check_failed`を記録できなかったときは`failed to record the schedule check failure`である。
4. 3回目の失敗から、検出器の次の回(最大5分後)までに通知ができていなければ、検出器のジョブが成功しているかを見る。
   失敗の記録に失敗した回は、次の回がやり直す。

ジョブ履歴を読めないとき(APIの失敗と、想定外の形の応答)は、通知`schedule_failing_check_failed`が残る。
その場合は、ジョブ履歴を読む権限を確かめる。

## 自己更新の打ち切りを確かめる

`self_update`のジョブには、全体の上限(3400秒)がある。
値の内訳は[アーキテクチャ](../architecture.md)の「自己更新」に書く。
通常は、各コマンドの上限と、区切った呼び出し(1回30秒)の上限で先に終わる。
全体の上限は、それでも止まったときの最後の砦である。

上限で打ち切られた回は、最後に行うConsole用のworker、定期ジョブ用のworker、収集の鮮度の確認が走らない。
打ち切られるまでの最大約57分は、2分ごとの次の約28回が飛ばされる。
この間は、自己更新の反映と、Console用と定期ジョブ用のworkerの停止の検知と、収集の停止の検知が止まる。

気づく経路は、検出器(`detect_schedule_failures`)である([scheduleの失敗の検出](#scheduleの失敗の検出))。
打ち切られた回を失敗として拾い、最大5分遅れてDiscordの`job_failed`で知らせる。
打ち切りが3回続くと、通知`schedule_failing`が残る。

次の点を実機で確かめていない。
確かめるまでは、頼れる経路とみなさない。
確かめていなければ、自己更新が止まっても気づけない。
なお、ユーザー名が`timeout`の人が取り消した回は、時間切れと見分けられず、失敗に数えられる。

- 時間切れの取り消しが、ジョブ履歴で`canceled_by`が`timeout`になること。
  違う値なら、打ち切られた回が失敗として数えられない。
  `job_failed`も`schedule_failing`も出ない。

あわせて、`self_update`の実行ユーザーに`f/factory/deployed_sha`が見えることも実機で確かめる。
見えないと存在の確認が`false`になり、全体を反映し直す。
このとき、見えない既存の変数に対して、`setVariable`の作成が既存のパスと衝突しうる。

確かめるには、本番の`self_update`やロックには触れず、使い捨てのscriptとスケジュールを使う。
検出器は`f/factory/`の下だけを拾うので、scriptは`f/factory/_probe_timeout`の名前でWindmillの画面から作る。
自己更新の`wmill sync push`は`--keep-deleted`を付けるため、リポジトリに無いこのscriptとスケジュールを消さない。
削除を確定する`mise run push:prune`は人が実行するので、その前に使い捨ての資産を消しておく。

次の点に注意する。

- 作る人は、`f/factory`のスケジュールと同じ権限(admin)にする。
  検出器はスケジュールの`permissioned_as`で動くので、ジョブ履歴を読む権限を欠くと、拾えない。
- 手順の前に、Discordのチャンネルの人へ知らせる。
  使い捨てのスケジュールの失敗が、`job_failed`として届くためである。
- 検出器は、`factory.job_failures`に`flow_path`が`f/factory/_probe_timeout`の行を残す。
  この行は週次監査(月曜9時30分)の証跡に入るので、後片付けで消すか、監査の前に手順を終える。

手順は次のとおりである。

1. `self_update`の上限が反映されていることを確かめる。
   `wmill script get f/factory/self_update`の出力で、`timeout`が3400であることを見る。
   3400秒がインスタンスの上限で切り詰められないのは、セルフホストの上限が環境変数`TIMEOUT`で、未設定なら7日だからである。
   `job_default_timeout`は21600秒以上にする決まりなので、3400秒はその範囲に収まる([実装フローの仕様](../internals/implement.md)の「Windmillのtimeoutで打ち切られたとき」)。
2. `f/factory/_probe_timeout`というscriptを作る。
   子プロセスを起動せず、60秒待つだけにする。
   設定の`timeout`は10秒にする。

   ```ts
   export async function main() {
     await new Promise((resolve) => setTimeout(resolve, 60_000));
   }
   ```

3. `f/factory/_probe_timeout`のスケジュールを作る。
   cronは`0 */2 * * * *`(2分ごと)にし、`no_flow_overlap`を有効にする。
   失敗時のハンドラは付けない。
4. スケジュールの実行を待つ。
   手動の実行は、scheduleが起こしていないので検出器が拾わない。
   手動では確かめられない。
5. `wmill job list --script-path f/factory/_probe_timeout`で打ち切られた回を見つける。
   `wmill job get <id> --json`で`canceled`、`canceled_by`、`canceled_reason`を読む。
   出力に`canceled_by`が無いときは、Windmillの画面のジョブ詳細で読む。
   `canceled_by`が`timeout`であることを見る。
   違う値なら、`f/factory/lib/schedule_failing.ts`と`f/factory/lib/schedule_failure_scan.ts`の判定を、読んだ値に合わせて直す。
6. 打ち切られた回の後、検出器の次の回(最大5分後)までに、Discordに`job_failed`が届いたことを見る。
   届かなければ、検出器のジョブが成功しているかを見る。
   コマンドは`wmill job list --script-path f/factory/detect_schedule_failures --limit 3`である。
7. 通知`schedule_failing`まで見るなら、打ち切りが3回続くまで(約6分)待つ。
   Consoleの**要対応**に出ることを見る。
8. 終わったら、スケジュールとscriptを消す。
   出た`schedule_failing`は、Consoleで解決する。
9. `factory.job_failures`に残った使い捨ての記録を消す。
   Data Tableのデータベースに接続し、消す前に行を確かめる。
   データベース名は、`main`のData Tableのresource_pathで、既定は`datatable_db`である。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT id, flow_path, occurred_at FROM factory.job_failures WHERE flow_path = 'f/factory/_probe_timeout'"
   ```

   表示された行の件数が使い捨ての実行の回数と合うことを確かめ、行の`id`を控える。
   確かめた`id`だけを、同じ`flow_path`の条件で消す。
   `<確かめたid>`には、控えた`id`をカンマで区切って並べる。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "DELETE FROM factory.job_failures WHERE flow_path = 'f/factory/_probe_timeout' AND id IN (<確かめたid>)"
   ```

   `u/<user>/timeout_probe_child`と`u/<user>/timeout_probe_tail`は手動で実行する。
   scheduleが起こしていない実行で、`f/factory/`の外のscriptでもあるので、検出器は拾わず、通常は行が付かない。
   SELECTで行が出た場合だけ、同じ手順で消す。

打ち切りの扱いの確認は、同じ手順の使い捨てのscriptで続ける。

- 打ち切りが子を止めるか。
  `u/<user>/timeout_probe_child`を作り、`timeout`を10秒にする。
  本体で、`Bun.spawn(["sleep", "600"], { detached: true })`で別のセッションの子を起動し、60秒待つ。
  `wmill script run`で実行し、打ち切られた後に、後述の`ps`で`sleep 600`が残っているかを見る。
  残っていれば、Windmillの打ち切りは子を止めない。
  確かめたら、残った`sleep`を`kill`で止め、scriptを消す。
- 取り残した処理が、ジョブの終わりを遅らせるか。
  `withCallTimeout`は呼び出しを中断しないので、時間切れの後も処理が残りうる。
  `u/<user>/timeout_probe_tail`を作り、60秒のタイマーを残したまま、すぐに戻るようにする。
  実行して`wmill job get <id>`の`duration_ms`を見る。
  60秒近くかかるなら、取り残した処理が終わりを遅らせる。
  実際の`self_update`では、区切った呼び出しが時間切れになった回で、ジョブの終了がログの最後の時刻より大きく遅れないかを見る。

## 打ち切りで残ったプロセスを確かめる

Windmillの打ち切りが子プロセスを止めるかは、上の手順で確かめる。
止めなければ、子の実行中に打ち切られたとき、`wmill sync push`などが上限なしで残る。
残った`wmill sync push`は次の回の作業ツリーを読み続け、`wmill datatable migrate up`は次の回と並行しうる。
リスクは[セキュリティ](../security.md)の「自己更新の打ち切り」に書く。

打ち切られた回の後は、workerで残ったプロセスを探す。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker ps -eo pid,pgid,etime,args
```

出力から`wmill`、`npm`、`git`を探し、経過時間(`etime`)が打ち切りより長いものがあれば残っている。
内容を確かめてから、`kill <pid>`で止める。

## 自己更新が繰り返し打ち切られるとき

自己更新が打ち切られ続けると、反映とConsole用のworkerの停止の検知が止まる。
次の順で復旧する。

1. `wmill job list --script-path f/factory/self_update`で、打ち切りが続いているかを見る。
   原因はジョブのログで確かめる。
2. 上の「打ち切りで残ったプロセスを確かめる」で、残った`wmill`、`npm`、`git`を探して止める。
3. ホスト側のcheckoutで`git pull --ff-only`を実行する。
   続けて`mise run push`と`mise run migrate`を実行し、自己更新が済ませるはずだった反映を手で行う。
   `mise run push`は`--keep-deleted`付きなので、削除は反映しない。
   凍結中のスケジュールは、pushから除かれる([凍結とdeployの保留の内部仕様](../internals/freezes.md))。
4. 次の回で自己更新が成功することを見る。
   次の「打ち切られた回の記録を確かめる」の見比べで、`deployed_sha`がself cloneのHEADと同じになっていることを確かめる。

## 自己更新の起動の種類を確かめる

自己更新は、実行のたびに最初のログ(`self_update started`)へ、起動の種類(`trigger`)を出す。
値は`schedule`、`manual`、`unknown`のいずれかで、判定は[アーキテクチャ](../architecture.md)の「自己更新」に書く。
判定は、実機の定期のジョブでWindmillが`WM_SCHEDULE_PATH`を与えることを前提にする。
この前提は、コードの試験では確かめられないので、反映の後に次の手順で確かめる。

1. 反映の後の定期の回を`wmill job list --script-path f/factory/self_update`で見つけ、`wmill job logs <id>`でログを読む。
   `self_update started`の`trigger`が`schedule`で、`schedule_path`にスケジュールのパスが入っていることを見る。
2. `wmill script run f/factory/self_update`で手動の回を走らせ、同じログの`trigger`が`manual`であることを見る。
3. 食い違うときは、同じログの`schedule_path`、`has_job_kind`、`has_parent_job`、`has_root_flow_job`を見る。
   判定の入力に使うべき環境変数を、この値から探す。

同じ範囲(反映前の版と反映後の版が同じ)の成功が`factory.deployments`に2件記録されたときは、ジョブ履歴で2つの実行の開始時刻の重なりと起動元を確かめる。
起動元が定期と手動のどちらなのかは、このログの`trigger`で切り分ける。
原因の1つは、手動と定期の2つの実行が重なり、どちらも成功の記録の前に反映を始めたことである。
`deployed_sha`を直前の版に戻して再反映した運用の結果であれば、同じ範囲が2件になっても異常ではない。

## 区切った呼び出しが時間切れになったとき

`self_update`の区切った呼び出しが30秒で終わらないと、例外にする。
呼び出し自体は中断しないので、後から完了することがある。

- 更新のうち、`wmill_token`の取得を含め、それ以降の失敗と時間切れは、更新の失敗として`factory.deployments`に記録する。
  記録されない範囲は[アーキテクチャ](../architecture.md)の「自己更新」に書く。
  ジョブの失敗は、Discordの`job_failed`と、3回続いたときの`schedule_failing`で知る。
  ただし`deployed_sha`の更新が時間切れのときは、変数を読み直し、書けていれば成功として続ける。
  成功の記録そのものが時間切れのときは、反映が済んでいるので失敗にしない。
  ログに警告を残し、成功として終わる。
  この回の`deployments`の行は欠けることがある。
  後から成功の行が入ることもある。
  監査は、失敗の時刻以前で最後の成功の行から稼働版を導く。
  そのため、成功の行が欠けると、次の成功の行までの間の失敗が1つ前の版に帰属しうる。
- `deployed_sha`の読み取りが時間切れのときは、未デプロイとは扱わず、更新を失敗にする。
  読み取りがそれ以外で失敗したときは、区切った`existsVariable`で変数の有無を確かめる。
  `false`のときだけ未デプロイとして全体を反映し直す。
  `true`のときと、確認できないときも、更新を失敗にする。
  このとき、エラーは`Variable not found at f/factory/deployed_sha or not visible to you`になるが、変数が存在することもある。
  一時的な失敗か、存在の確認(`existsVariable`)の失敗を疑う。
- noticeの挿入が時間切れになり、後から挿入されたときは、その回のDiscordの通知は出ない。
  次の回からは、同じ本文の未解決のnoticeがあるので、通知しない。
  Consoleの要対応には残る。
- stateの読み取りが失敗か時間切れの回は、stateを書かない。
  確認できなかった回数の積み上げを、0に戻さないためである。
  stateを書けなかった回は、警告だけにして、noticeの判定は数えた回数で続ける。
- Console用workerの確認で、stateを書けなかった回の後は、保存された回数が実際と食い違う。
  回数を0に戻す書き込みが失敗すると、古い回数が残る。
  その後は、1回の確認失敗でも通知`console_worker_check_failed`が出うる。
  回数を増やす書き込みが失敗すると、保存された回数は実際より少なくなり、通知が遅れる。

## 打ち切られた回の記録を確かめる

打ち切られた回は`factory.deployments`に記録が残らない。
成功と失敗のどちらの記録も、更新の最後のほうで書くためである。

`wmill sync push`と`wmill datatable migrate up`が済み、`deployed_sha`を更新した後で、記録の前に打ち切られることがある。
このときは、その版の反映が済んでいるのに`deployments`に行が無い。
次の回は、`deployed_sha`がself cloneのHEADと同じなので、何もせずに終わる。
欠けた記録は補われない。

見分けるには、次の3つを見比べる。

- `deployed_sha`の値。
  Windmillの画面で変数`f/factory/deployed_sha`を開いて読む。
- self cloneのHEAD。
- `deployments`の最新の行の`sha_to`。

self cloneのHEADは、次のコマンドで読む。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker git -C /workspaces/factory/atelier-works rev-parse HEAD
```

`deployed_sha`とHEADが違えば、反映が済んでいないか、打ち切りが`deployed_sha`の更新より前に当たっている。
通知`deployed_sha_mismatch`が残り、次の回が反映をやり直す。
`deployed_sha`とHEADが同じで、`deployments`の最新の`sha_to`だけが違えば、その版の記録が欠けている。
`wmill job list --script-path f/factory/self_update`で、打ち切られた回の時刻が、その版の反映の時刻と合うかを確かめる。

`sha_to`がHEADと同じで、`result`が`failed`の行だけがあることもある。
`deployed_sha`の更新が時間切れになった後で、実は書けていた場合の組である。
更新は読み直しで成功として続けるので、この組は起きにくい。
起きていれば、`deployed_sha`がHEADと同じかを見て、同じなら反映は済んでいる。

欠けた記録は監査の「デプロイ」に出ないので、必要なら人が補う。
