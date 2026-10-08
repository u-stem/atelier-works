# 運用

## 運用ルール

- Issueを拾ったインスタンスの所有者が、そのIssueの承認を行う。
- 各インスタンスは稼働前に`f/factory/factory_config`の`instance_name`を必ず設定する(Discord通知・承認Inboxの担当表示に使われる)。
- 1つのIssueは1つのインスタンスが占有する。claim(assignee設定 + `factory`ラベルの消費)に成功したインスタンスだけがそのIssueを処理し、後から来た他インスタンスは撤退する。
- 既知の制約: claim(ラベル消費)の直後にDBへの登録が失敗すると、そのIssueはラベルも作業項目も無い状態になり、自動では拾い直されない。Discordの失敗通知を見て人が`factory`ラベルを付け直す。
- Issue・PRとも、付くラベルはトリガーのみ(2026-09-27方針変更): Issueは`factory`、PRは`factory:review` / `factory:fix`。付けると起動し、claim時に外れる(消費される)。以後はどの状態遷移でもIssue / PRのラベルは付け外しされず、状態はConsoleのPipelineタブで確認する。**もう一度処理させたい場合は、人が改めてトリガーラベルを付け直す**(新しいcycleとして扱われる)。ラベルが外れた後も、`tracked_pr_days`(既定30日)以内に更新があったPRは`poll_prs`がDB(`work_items`)から再発見し続けるため、人が新しいcommitをpushすれば自動で再レビューが起動する。それ以上追跡させたくない場合はPRをcloseするか、`tracked_pr_days`を過ぎるまで待つ。

## 日常運用

- Issueに`factory`ラベルを付けると拾われる(付与者はOWNER / MEMBER / COLLABORATORのいずれかである必要がある)。
- 手動フォームからも同じパイプラインにIssueを投入できる想定(`manual_intake`フロー)。
- **承認はFactory Console App(`f/factory/factory_console`)のInboxタブから行う**。Discord通知に記載されたURL、またはConsoleを直接開き、対象の作業項目を選択して要件定義書(見出し・表・図を含むConfluenceの文書ページに近い見た目で表示され、draw.io図はページ内にそのまま描画される)・未確定事項を確認したうえで承認 / 却下する(却下時は理由の入力が必須、補足は任意)。承認者は実行ユーザー(`WM_USERNAME`)として記録される。Appを使わない代替手順として、Windmill UIで`f/factory/approval_decide`を直接開き、`approval_request_id`(ConsoleのInboxに記載)/ `decision`(approve / reject) / `reason` / `note`を入力してRunすることもできる(`options`は要件定義承認では空のままでよい)。
- 要件定義書はConsoleの**要件定義タブ**からも一覧・閲覧できる(承認待ちに限らず、過去に生成されたすべてのattemptを含む)。Issueコメントの承認済みリンクやDiscord通知のリンクは`#requirements/<work_item_id>`という形式のフラグメントを末尾に付けており、これを開くと要件定義タブが自動的にその作業項目を選択する。ただしConsoleはWindmillの管理画面内で動くraw app(サンドボックスされた別オリジン)であるため、埋め込み元のURLを読み取れずこのジャンプが効かない場合がある(実行環境依存、未検証)。その場合はリンク本文に併記されている`work_item_id`を要件定義タブの一覧上部の絞り込み欄に入力して探す(一覧の各行にも`work_item_id`を表示している)か、ブラウザのアドレスバーで開いたConsoleのタブに直接`#requirements/<work_item_id>`を追記する。
- Issueに自動投稿されるコメントは、要件定義が承認されたときのConsoleリンク1件のみ。着手・承認待ち・却下・期限切れ・失敗・要人手といった運用上の状態はIssueには書かず、Discord通知とConsoleで確認する(GitHubには成果物のみを残す方針、2026-09-27)。
- Rejectすると要件定義が再生成され(`attempt`が加算される)、再度承認待ちになる。試行回数が上限を超えると`needs_human`になる。
- 失敗した作業項目はFactory Console AppのFailuresタブから再実行できる(`retry_work_item`)。kindを問わずラベルの付け外しはせず、対応するflowを直接再起動する: Issue kindは、最新の要件定義の承認がその作業項目のattemptに一致し、かつ`implement_enabled`が`true`なら`f/factory/implement`(`implementing`から)、そうでなければ`f/factory/pipeline`、PR kindは`f/factory/pr_review` / `f/factory/pr_fix`。再実行できるstatusは`failed` / `needs_human` / `expired` / `blocked` / `approved`(`approved`は実装の起動前に止まった場合のためで、実装フローへ再起動できないときは理由(`implement_enabled`が無効か、承認とattemptの不一致か)を示して拒否する)。承認がattemptに一致しているのに`implement_enabled`が無効な場合は、承認済みの要件定義を作り直さないよう、statusを問わず再実行を拒否する。状態の遷移は読み取ったstatusからのCASで、途中で別の処理がstatusを変えていれば再実行しない。作業項目に記録されたflowのジョブがまだ実行中(キュー待ちを含む)か、ジョブの状態を読めない(Windmill APIの一時的な障害など)ときは再実行を拒否する(実行中ならWindmillでそのジョブを止めるか終わるのを待ち、読めないときは時間をおいて再実行する)。実装フローとpipelineへの再起動では、CASで`flow_job_id`を空にしてから起動し、起動したジョブIDは空のままのときだけ記録する(pipelineでは記録までの間、reconcileは未記録として猶予を待つ)。起動の戻り値がジョブIDでなければ、作業項目を`needs_human`に戻してエラーにする(戻す処理が失敗しても、エラーは起動の失敗の理由のまま)。別の実行が既にリースを持っていて戻せないときは、起動の応答はエラーだったが別の実行が動いている旨のエラーにする。起動したジョブIDを、別の実行が先にリースを取っていたため記録しなかったときは、Failuresタブにその旨を表示する。トリガーラベルはclaim時に一度だけ消費され、再付与されない。PR kindは再起動後も`listTrackedPrs`によるDB上の追跡対象であり続ける。
- GitHub APIのrate limitに当たると、`retry-after`か`x-ratelimit-reset`(1秒の余裕を足す)が示す解除まで待って1回だけ再試行する。待つのは最大120秒(`f/factory/lib/github.ts`の`GITHUB_RATE_LIMIT_MAX_WAIT_MS`。1回の待ちはどのフローのステップのtimeoutよりも短い)で、それより長く待つ必要があるときと、再試行もrate limitで拒まれたときは、待たずに`GitHubRateLimitError`(メッセージは`GitHub rate limit on <endpoint>: ... (rerun after the limit resets)`)で失敗する。GraphQLの一次レート制限(HTTP 200で`errors[].type`が`RATE_LIMITED`)は待たずに同じエラーで失敗する。拒まれた要求の副作用は起きていない。search APIの1分ごとの上限と、`retry-after`があるときの二次レート制限はこの範囲で待てるが、1時間ごとの上限を使い切ったときは失敗する。失敗した作業項目は、解除を待ってからFailuresタブで再実行する。`needs_human`の通知では、次の操作にも解除を待ってから再実行するよう表示する。
- 監査は毎週月曜09:30に自動で走る(`audit_kickoff`schedule)。Consoleの**監査タブ**の「今すぐ監査」で前倒しできる(実行中の監査がある、対象期間が空、新しい記録が無い、日次予算超過のいずれかならスキップ理由が表示される)。監査レポートは監査タブで読む(一覧から選ぶと本文と提案の決定状況が表示される)。Discordの`audit_completed`通知のリンクは`#audit/<work_item_id>`を末尾に付けており、要件定義タブと同じ制約でジャンプが効かない場合は一覧から選ぶ。提案は承認Inboxに「改善提案」として並び、承認するとFactory自身のリポジトリにIssueが起票される。改善提案の承認欄では「起票と同時にfactoryラベルを付けて要件定義に進める」が既定でオンになっており、外せば起票のみになる。`factory_repo`は`repo_allowlist`の内容に関わらず常にFactoryの対象なので、ラベルを付けたIssueはそのまま要件定義に進む。
- 通知の種類: `picked` / `awaiting_approval` / `approved` / `rejected` / `needs_human` / `failed` / `expired` / `cancelled` / `pr_opened`(実装フローがPRを作成 / 更新した)/ `daily_summary`(前日のコスト・件数・失敗)/ `audit_completed`(監査で改善提案が1件以上生成された)。

## 承認後の自動実装(工程3、`implement`)

- `factory_config`の`implement_enabled`を`true`にすると、要件定義の承認後に`f/factory/implement`が自動で起動する(既定`false`。`false`の間は従来どおり`approved`で止まる)。
- 実装フローは実装ブランチ`factory/issue-<N>-wi-<work_item_id>`を作ってpushし、検査に通ったらコミットしてPRを作成する(既にPRがあれば本文を更新する)。PRには`factory:review`ラベルが付き、`poll_prs`が自動レビュー(`pr_review`)を起動する。PR本文の`Closes #N`で元のIssueに紐づく。マージは常に人が行う。
- 検査コマンドはリポジトリごとに`check_commands_by_repo`(`{"<owner>/<repo>": ["bun install --frozen-lockfile", "bun test", ...]}`)で設定する。エントリが無いリポジトリでは検査コマンドを実行しない(`allowed_check_commands`は使わない)。検査の前に毎回`git clean -fdX`で無視ファイル(`node_modules/`等)を消すので、先頭で依存関係をインストールする。worker imageにmiseは無いので、コマンドはworker内で直接動くもの(例: `bun install --frozen-lockfile`、`bun test`、`bunx --bun tsc --noEmit`、`bunx --bun biome check .`)にする。
- 検査コマンドはClaudeが書いたコードをworker内でrootとして実行するため、`check_commands_by_repo`のエントリは、workerのサンドボックスができるまで、Issueを信頼できる人だけが起票するリポジトリにだけ設定する。実装ブランチのpushで対象リポジトリ自身のCIも人のレビュー前に動くので、そのCIが使えるsecretsの範囲を確認しておく。検査コマンドはサンドボックスなしでworker内でrootとして実行され、実行のたびにnotice `unsandboxed_check_commands`が記録される。秘密情報の検査(gitleaks)は設定に関わらず毎ラウンド実行する。検査コマンドは常駐デーモンを残さないこと。ロックのfdを持ったまま残ると、以降のラウンドがロックを取れずに失敗する。fdを閉じて残ったものも、次の準備やpr_fixを止める。
- 保護パス(`.claude/**`、`.github/**`、`infra/**`、`mise.toml`、`package.json`、lockfile等)の変更は止めずにPR本文の「確認して欲しい点」とDiscordの`pr_opened`通知に載る。そのラウンドは検査コマンドを実行しない(PR本文の「動作確認結果」に「検査未実施」と理由が出る)ので、GitHub側のCIの結果を確認する。
- 実装が何も変更を生まなかった場合(分岐点から差分が無いまま完了と報告した場合)はそのラウンドを合格にせず修正を求める。完了時にコミットする新しい変更が無くても、ブランチに分岐点より先のコミット(途中経過のコミットなど)があれば、それを使ってPRを作成または更新する。ブランチに分岐点より先のものが何も無いときだけ`needs_human`(「実装が変更を生みませんでした」)にする。その場合は要件定義を見直すか、Issueを閉じる。
- ラウンド・予算上限、期限、停滞、差分超過で`needs_human`になった場合は、PRが無く秘密情報の検査に通れば途中の変更が実装ブランチにpushされている。PRがある場合(「PRがあるため途中の変更はpushせずworktreeに残しました」)と、symlink変更・Claude実行失敗・worktreeの`.git`の書き換えで止まった場合は、途中の変更をpushせずworktreeに残す。Discordの`needs_human`通知の「次の操作」に従い、ブランチを確認して人がPRを作る、要件を直す、または不要ならブランチを削除する。原因を取り除いたらConsoleのFailuresタブ(`retry_work_item`)から実装フローを再実行できる。途中経過のコミットは、再実行で実装が完了したときのコミットとは別のコミットとして残る。
- 実装が`requirements_gap`を返した場合は自動で要件定義の作り直し(attempt+1)に戻り、再承認後に同じブランチ名で実装をやり直す(既にPRがあればそのPRを更新する)。
- 設定値(既定): `implement_max_rounds`(5)、`implement_max_turns`(80)、`implement_max_budget_usd_per_run`(10)、`implement_timeout_sec`(3600)、`implement_check_timeout_sec`(900)、`implement_flow_timeout_sec`(14400)、`implement_max_changed_files`(60)、`implement_max_diff_lines`(3000)。1 Issueあたりの予算上限は`implement_max_rounds × implement_max_budget_usd_per_run`が目安で、Claudeの不正な出力を再試行する(1回の実行につき1回まで)と、その実行は最大で`implement_max_budget_usd_per_run`をもう1回使うので、最悪でその2倍になる。差分の上限(`implement_max_changed_files` / `implement_max_diff_lines`)は、既存のPRを更新する場合も含めて、実装ブランチと既定ブランチの分岐点(merge-base)からの差分で測る。時間設定と検査コマンド数は、`flow.yaml`の実装・検証ステップのtimeout(21600秒)に収まる組み合わせにする。準備ステップは、`implement_flow_timeout_sec`+600秒+検査コマンド数×(`implement_check_timeout_sec`+15秒)か、`implement_timeout_sec`+600秒が21600秒を超えると、worktreeに触れずに`needs_human`にする(既定値なら検査コマンド7件まで)。上限を上げるには、`flow.yaml`と`f/factory/lib/implement_support.ts`の`IMPLEMENT_STEP_TIMEOUT_SEC`を同じ変更で上げる。実装フローの実行中は時間設定を変えない(確かめるのは準備ステップだけである)。
- 実行時間: 実装フロー1回の実行には、作業領域の準備を始めてから`implement_flow_timeout_sec`(既定4時間)の期限がある。検査に失敗したラウンドの後は、期限までの残りが修正ラウンド1回の最悪の所要時間(`implement_timeout_sec`+600秒+検査コマンド数×(`implement_check_timeout_sec`+15秒)。既定値で検査コマンド4件なら7860秒)以上のときだけ次の修正ラウンドを始め、足りなければ修正をやめて`needs_human`にする。この条件を満たして始めた修正ラウンドは、Claude・gitleaks・検査コマンドがそれぞれのタイムアウトまでかかっても期限までに終わる。ただし、Claudeが不正な出力を返した後の1回の再試行だけは期限までの残りで打ち切る。再試行したラウンドは、gitleaksと検査コマンドが期限を過ぎて動くことがある。再試行が打ち切られた場合は、その変更を検査していないのでpushせず(worktreeに残す)、作業項目は`needs_human`になる。Claudeの各実行は`implement_timeout_sec`(既定1時間)と期限までの残りの短い方で打ち切る。検査コマンドは期限で切らず、1コマンドごとの`implement_check_timeout_sec`(既定15分)まで走らせる。最初の実装のClaudeが期限で打ち切られた(または期限後で起動しなかった)場合は、その差分は検査を経ていないのでpushせずに`needs_human`にする。検査に通ったラウンドは期限後でもPRを作る。期限は再実行(`retry_work_item`)のたびに最初から数え直す。検査コマンドが多いほど修正ラウンドを始められる時間が短くなるので、1リポジトリの検査コマンドは4件までを目安にする。実装フローの同時実行数は抑えていない。`cleanup_workspaces`は`claude_timeout_sec`と`implement_timeout_sec`の長い方に5分を足した時間を超えたheadless Claudeだけを孤児として停止する。
- `flow.yaml`の各ステップには、アプリ側の期限と各timeoutが効かなかったときの最後の打ち切りとして、Windmillのtimeoutを付けている。値は、準備が3600秒、完了が1800秒、実装と検証が21600秒(`f/factory/lib/implement_support.ts`の`IMPLEMENT_STEP_TIMEOUT_SEC`)である。準備は、リポジトリのロックの待ち(最大5回、1回300秒)とfactory cloneのロックの待ちだけで約1800秒かかりうるため、完了より長くしている。Windmillのtimeoutはジョブのプロセスにしかシグナルを送らないので、打ち切られたステップが起動したClaudeや検査コマンドは残り、作業項目は`failed`になる。再実行すると、残ったプロセスは前のジョブIDを持つので準備ステップが止めてから続ける(ジョブIDの無いものとpr_fixのものは、これまでどおり`needs_human`になる)。stepのtimeoutはインスタンスの上限(セルフホストでは環境変数`TIMEOUT`、未設定なら7日)を超えられない。インスタンスの`job_default_timeout`を設定する場合は、実装・検証ステップ(とpr_fixの検証ステップ)より先に打ち切らないよう21600秒以上にする。
- 実装フローは1回の実行で、worker(`NUM_WORKERS`の数だけある)の1つを数時間占有する。その間、他のflowが使えるworkerはその分減る。
- `self_update`は実行中の実装フローを待たずに新しいstepを反映するため、`implement_prepare`と`implement_finish`の間に別のバージョンのstepが動くことがある。実装フローの実行中(`implementing`の作業項目がある間)はmainへのマージとデプロイを避ける。
- 実装はIssueを取り込んだ時点の題名と本文(要件定義を作ったときと同じ内容)を使う。承認後にIssueを書き換えても実装には反映されず、現在のIssueが取り込み時点と違えばPR本文の「確認して欲しい点」に注記が出る。
- 承認の前にIssueの内容を直したいときは、Issueを書き換えるのではなく、ConsoleのInboxで却下し、直したい内容を却下理由(feedback)に書いて要件定義を作り直させる。承認の後に作り直すときは、先に既存のPRを閉じてから、Issueにトリガーラベルを付け直す(新しいサイクルとして別の作業項目・別のブランチ・別のPRになるため、旧PRを残すと重複する)。
- 実装フローを再実行するときは、ConsoleのFailuresタブ(`retry_work_item`)を使う。Windmillのrerunは新しいジョブIDで最初から走るため、準備ステップの最初で何もせずに終わる(`flow_job_id`のリース)。途中のステップからのrestartも新しいジョブIDで走るため、再開したステップ(生成・検証・完了)の最初のリースの確認で何もせずに終わる。どちらも、元の実行で進行中のClaudeの実行や検査を中断はしない。同じ作業項目で実装フローが重ねて起動された場合(起動の応答が失敗したが実際には動いていた場合など)も、後の実行は同じく何もせずに終わる。Windmillで取り消した実行のClaudeや検査コマンドは止まらずに残る。

  実装フローの再実行では、準備ステップが、同じ作業項目の前の実装フローのジョブが起動したプロセスを見つけて止めてから続ける。それ以外のプロセス(pr_fixのもの、持ち主の分からないもの)がworktreeを使っていれば`needs_human`になり、理由に残っているプロセスが載る。

  pr_fixの再実行では何も止めずに`blocked`になる。この場合は、理由に載ったプロセスが終わるのを待つか、何かを確かめて止めるか、`mise exec -- docker compose -f infra/docker-compose.yml restart windmill_worker`でworkerを再起動してから再実行する。workerの再起動は、同じコンテナで動いているすべてのジョブを止める。

  残ったClaudeは、`cleanup_workspaces`の孤児の掃除でも、閾値(`claude_timeout_sec`と`implement_timeout_sec`の長い方に5分を足した時間)を過ぎた後にだけ止まる。検査コマンドの生き残りはこの掃除の対象外である。
- 要件定義のフロー(`f/factory/pipeline`)も、再実行はConsoleのFailuresタブ(`retry_work_item`)を使う。Windmillのrerunや、Windmillの画面からの直接の実行は、作業項目の`flow_job_id`にそのジョブIDが記録されないので、準備ステップが何もせずに終わる。作業項目が終端ならすぐに、そうでなければ記録を最大60秒待ってから終わる。差し戻しの取り消しに失敗して同じ作業項目でpipelineが2本動いた場合も、記録されていない方は同じく何もせずに終わる。記録されていないpipelineの実行が例外で失敗しても、`on_error_flow`は作業項目を`failed`にしない(`flow_job_id`が空の間も同じ)。起動側が記録する前に止まった作業項目は、reconcileが猶予の後に孤児として`failed`にする。
- 実装フローの実行中にリースが移った場合(Issueのcloseによる取り消しで`cancelJob`が失敗したなど)、実装フローは次のリースの確認(生成ステップのClaude実行前、検証の各ラウンドの冒頭と修正ラウンドの前、完了ステップの最初と外への副作用の直前)で止まり、コミット・push・PR作成をしない。進行中のClaudeの実行や検査は中断しない。worktreeに残った途中の変更は、次の実行の準備で捨てられる。

## 通知

- 通知は行動が必要なものだけ送る。例えば再レビュー依頼の対象レビュアーが全員除外されて誰にも依頼できなかった場合、`pr_fixed`通知自体がすでに再レビュー依頼という結果を伝えているため、追加の通知はしない(再レビュー依頼のAPI呼び出し自体が失敗した場合は、`pr_fixed`通知の補足欄に記録する)。
- `needs_human`通知には対象(PR / Issue番号)・起きたこと・次の操作(何をすればよいか)が必ず載る。
- Discordのrate limit(HTTP 429)に当たると、`retry-after`(空・空白だけ・数でないときは本文の`retry_after`、どちらも無ければ1秒)だけ待って1回だけ再送する。待つのは最大30秒(`f/factory/lib/discord.ts`の`DISCORD_RETRY_MAX_WAIT_MS`。どのフローのステップのtimeoutよりも十分に短い)で、それより長く待つ必要があるときは、待たず再送もせずにその通知を諦め、ジョブログに`discord notify skipped: rate limit wait exceeds cap`のwarnを残す。
- 通知の失敗でフローは失敗しない。待ちが上限を超えたとき、再送もrate limitで拒まれたとき、その他の送信の失敗のいずれも、すべての呼び出し元が捕まえてジョブログにwarn(失敗の記録と通知を受け持つ`on_error_flow` / `on_error_schedule`などではerror)を残し、処理を続ける。届かなかった通知は再送されないので、ConsoleとGitHubで状態を確かめる。
- 承認依頼(`approval_requested`)の通知が届かなかったときは、ConsoleのNoticesタブに`approval_notify_failed`のnoticeを1件残す(`<owner>/<repo>#<Issue番号> (work item <id>)`と理由を載せる)。承認依頼自体は記録済みなので、ConsoleのInboxから承認 / 却下できる。webhookを設定していないときは残さない。
- 承認した要件定義について、Issueへの承認のコメントを投稿できなかったとき(GitHubのrate limitや5xx)は、ConsoleのNoticesタブに`approval_comment_failed`のnoticeを1件残す(`<owner>/<repo>#<Issue番号> (work item <id>)`、理由、要件定義を開くConsoleのリンクを載せる)。Discordには通知しない。承認は記録済みで、worktreeの片付けとimplementフローの起動はそのまま進む。必要なら、人がnoticeのリンクを載せたコメントをIssueに投稿する。

## PRの使い方(pr_review / pr_fix)

- Claudeが生成してGitHubに投稿する文章(指摘・コメント・返信・要約)は共通の文体規則に従う: 半角英数字と日本語の間に半角スペースを入れない(インラインコード・コードブロックの内部は対象外)、です・ます調、1文1行(要点が複数あれば箇条書き)。詳細は`.claude/skills/factory-review/SKILL.md` / `.claude/skills/factory-fix/SKILL.md`の「文体」節を参照。

### 起動条件

- PRに`factory:review`ラベルを付ける、またはPRのレビュー依頼・assigneeがこのインスタンスのアカウント(未処理のcommitがある場合)で自動起動。
- トリガーラベルは起動と同時に消費されて外れるが、`tracked_pr_days`(既定30日)以内に更新のあったPRは`poll_prs`がDB(`work_items`、`listTrackedPrs`)から再発見し続ける(例: レビュー完了後、人が改めて`factory:fix`ラベルを付け直した場合や、レビュー完了状態のまま人が新しいcommitをpushした場合)。
- コメント投稿者・レビュー者の`author_association`が`allowed_labeler_associations`に含まれることを確認してから起動する。

### PRレビュー(`pr_review`)

- 指摘がGitHubのCOMMENTとして投稿される。完了状態は`reviewed`。
- Factoryはレビューの開始コメントを投稿しない。レビュー指摘(インラインコメント + コード提案)と総評のみを投稿する。
- 運用者自身のアカウントで投稿するため、総評・インラインコメントとも1行目に`[pr_review 自動レビュー] @<author>`というロールタグ + メンションが付く。
- レビュー総評はClaudeの自由記述ではなく、次の固定4パターンのいずれかをflowが組み立てて投稿する: (1)指摘を投稿した場合(初回・再レビュー共通、行に紐づけられず投稿できなかった指摘があるだけの場合も含む)は件数 + 「確認お願いします。」(この場合、最終判断の一文は付かない)、(2)このPRへのFactoryレビューが過去にあり指摘0件の再レビューは「修正を確認しました。LGTMです。」+「最終的なApprove判断は人が行ってください。」、(3)初回レビューで指摘0件は「指摘はありません。LGTMです。」+ 同じ最終判断の一文、(4)このPRへのFactoryレビューが過去にあり指摘0件の再レビューだが、過去の`[MUST]`指摘で今回のresolve処理でも解決できなかったものが残っている場合は「新しい指摘はありません。未対応の指摘がN件残っています。確認お願いします。」(最終判断の一文は付かない)。Claudeの`summary`は`factory.reviews`に記録されるのみでGitHubには投稿されない。
- 再レビューでは、このPRに対するFactory自身の未解決の指摘一覧がClaudeへの入力に含まれる。実質的に同じ内容の指摘は新規指摘として再度投稿されず、新規・変化があった指摘のみ報告される(diffで既に解消済みと判断できるものは何も報告されない。スレッドのresolveは別処理が行う)。
- スレッドの自動解決(resolve)は、Factory自身のインラインコメントスレッドのうち、そのスレッドの最後のコメントもFactoryが書いたものである場合に限られる。スレッド内に人が返信している場合は自動解決の対象にならず、開いたままになる。このPRへのFactoryレビューが過去にある(=再レビューである)たびに、pr_fixがcommit sha付きで「対応: `<sha>`」と返信済みのスレッドをresolveする(「対応: 見送り」「対応: 変更なし」は人の判断が必要なためresolveしない)。加えて指摘0件の再レビュー(上記パターン2・4のいずれでも)では、Factory自身の指摘のまま何も返信されていないスレッド(人が手で直した等)もresolveする。初回レビュー(過去のFactoryレビューがない)では何もresolveしない。resolve処理後もなお開いたままの`[MUST]`スレッドが1件以上あると、パターン4になる。
- レビュー形式は`.claude/skills/factory-review/SKILL.md`の「投稿形式」節を参照。
- 運用通知(失敗・要人手・ブロック)はPRに投稿せずDiscordに送る。
- `flow.yaml`の各ステップには、アプリ側のtimeoutが効かなかったときの最後の打ち切りとして、Windmillのtimeoutを付けている。値は、準備が1800秒、レビューの生成が7200秒(`f/factory/steps/pr_workflow_support.ts`の`PR_REVIEW_GENERATE_STEP_TIMEOUT_SEC`)、投稿が5400秒である。準備は、factory cloneとリポジトリのロックの待ち(最大3回、1回300秒)だけで900秒かかりうる。投稿のステップでrate limitの解除を待てないときは、レビューを投稿する前なら投稿せずに失敗する。投稿した後のGitHub APIの呼び出し(スレッドの解決)は、失敗しても警告を残して続けるので、投稿済みなのに記録と状態の遷移が無い状態は残らない。総評には、レビューしたcommitのshaを表す見えない目印(`<!-- factory-review-sha:<sha> -->`)が`<!-- factory:pr_review:<work_item_id> -->`の目印の前の行に入る。投稿の前に、同じ作業項目が同じshaに対して投稿済みのレビュー(投稿者がFactoryのアカウントで、両方の目印を持つもの)をPRのレビューの一覧から探し、あれば投稿せずにそのレビューのidで記録する。投稿の後、記録する前に投稿のステップが落ちて(DBのエラー、workerの停止、step timeout)再実行しても、レビューは二重に投稿されない。投稿済みのレビューを再利用するときは、スレッドを1つも解決しない。再実行ではClaudeがレビューを作り直し、新しい指摘が0件になりやすいが、それを根拠に投稿済みのレビューの指摘を閉じないためである。代わりに、未解決の`[MUST]`のスレッド(再利用したレビュー自身の指摘を含む)をすべて数え、1件以上あればDiscordの通知を`changes_requested`にする。前の実行がスレッドの解決の前に落ちていた場合、そのラウンドで解決するはずだったスレッドは開いたまま残るので、人が確かめて解決する。再利用するときにスレッドの一覧を取得できなければ、記録する前に失敗する(投稿は起きない)ので、ConsoleのFailuresタブで再実行する。この確認に要るviewerとレビューの一覧を取得できないときは、投稿せずに失敗する。再利用には既知の制約が2つある。1つ目は、再利用したレビューの`[MUST]`のうち行に紐づけられず総評に並べたものはスレッドにならないので、残っている`[MUST]`の数に入らないこと。2つ目は、`factory.reviews`には再実行で作り直した`verdict`と`findings`が、再利用したレビューのidと組で記録されるので、実際に投稿された内容と食い違いうること。監査の証跡(`audit_evidence`)のレビュー数や指摘の集計は、この記録をそのまま数える。総評の「行に紐づけられなかった指摘」に並べる`path`と`message`は、`<!--`を`&lt;!--`に置き換え、`path`の改行は空白にまとめる。生成ステップは、Claude 2回分(不正な出力への再試行1回を含む)の(`claude_timeout_sec`+15秒)に600秒を足した値(既定値で4230秒)がこのtimeoutを超える設定では、Claudeを起動せずに`needs_human`にする(`claude_timeout_sec`は3285秒まで)。上限を上げるには、`flow.yaml`と`PR_REVIEW_GENERATE_STEP_TIMEOUT_SEC`を同じ変更で上げる。準備でrate limitの解除を待てないと、準備が`GitHubRateLimitError`で失敗して作業項目が`failed`になる。その場合は解除を待ってからConsoleのFailuresタブで再実行する。生成ステップにはWindmillの再試行(`attempts: 2`)があるので、timeoutで打ち切られた後に再試行され、読み取り専用のClaudeが2回目も起動して費用がかかることがある。生成が早く抜けて投稿しなかった場合も、投稿ステップがreviewのworktreeを消す。

### PR修正(`pr_fix`)

- PRに`factory:fix`ラベルを付けると実行される。すでにFactoryがレビュー済み(`reviewed`)のPRでも有効。修正への指示は、ラベルを付ける前にPRへ通常のコメントとして書いておく(`pr_fix_collect`が他の人間のコメントと同様にフィードバックとして収集する)。
- 運用通知(失敗・要人手・ブロック)はPRに投稿せずDiscordに送る。
- `flow.yaml`の各ステップには、pr_reviewと同じくWindmillのtimeoutを付けている。値は、準備が1800秒(factory cloneとリポジトリのロックの待ちが最大3回)、指摘の収集が600秒、修正が7200秒(`f/factory/steps/pr_workflow_support.ts`の`PR_FIX_APPLY_STEP_TIMEOUT_SEC`)、検証が21600秒(同じく`PR_FIX_VERIFY_STEP_TIMEOUT_SEC`)、pushと再レビュー依頼が5400秒である。pushと再レビュー依頼のステップでは、pushより前にrate limitの解除を待てなければpushせずに失敗する。pushの後のGitHub APIの呼び出しのうち、Issue化提案のスレッドの取得、返信の投稿、再レビューの依頼は、失敗しても警告やnoteを残して続ける。返信の投稿に1件以上失敗したときは、件数・`review_comment_id`・最初のエラーを載せた`fix_reply_post_failed`のnoticeをConsoleのNoticesタブに1件残す(Discordには通知しない)。その場合は、PRで人が返信する。再レビュー依頼の前のPRの取得(`getPr`)だけは失敗するとステップが失敗し、push・返信・記録は済んだまま作業項目が`failed`になる。準備と指摘の収集でrate limitの解除を待てないと、そのステップが`GitHubRateLimitError`で失敗して作業項目が`failed`になる。その場合は解除を待ってからConsoleのFailuresタブで再実行する。修正ステップにはWindmillの再試行(`attempts: 2`)があるので、timeoutで打ち切られた後に再試行されうるが、打ち切られたClaudeがworktreeのロックを持ったままなら、再試行はロックを取れずにすぐ失敗する。検証ステップは、検査コマンド(`allowed_check_commands`)をClaudeと同じ`claude_timeout_sec`で1件ずつ打ち切り、検査に失敗すればClaudeの修正1回の後に全件をもう一度実行する。準備ステップは、修正ステップの2×(`claude_timeout_sec`+15秒)+600秒か、検査コマンドがあるときの検証ステップの(2+2×検査コマンド数)×(`claude_timeout_sec`+15秒)+600秒が、それぞれのtimeoutを超える設定では、worktreeに触れずに`blocked`にする(既定値なら検査コマンド4件まで)。上限を上げるには、`flow.yaml`と上の定数を同じ変更で上げる。確かめるのは準備ステップだけなので、pr_fixの実行中は時間設定を変えない。打ち切られたステップが起動したClaudeや検査コマンドは残り、作業項目は`failed`になる。残ったプロセスがworktreeを使っている間は、再実行しても準備ステップが`blocked`にする。
- レビュー指摘・未解決コメントの修正を行い、各コメントへ返信してから再レビューを依頼(`rereview_requested`)。
- 返信は運用者自身のアカウントで投稿するため、1行目のロールタグ・本文・末尾の対応行(コミットshaまたは「見送り」)という固定構造でflow側がレンダリングする。形式は`.claude/skills/factory-fix/SKILL.md`の「返信形式」節を参照。
- コミットメッセージはClaudeが提案する件名(`commit_subject`、50文字以内を目安・72文字を超えると拒否・Conventional Commits形式)と任意の本文(`commit_body`、箇条書き)をflowが結合して作る。トレーラー(`Co-Authored-By` / `Generated-By`)はflow側が自動で付与する。コミットメッセージにも英数字と日本語の間のスペース除去が適用される(コードスパン内は除く)。
- 要件変更が必要な場合は修正を中断し、元のIssueをrequirements_generatingにattempt+1で再起動(`requirements_gap` → 親Issue)。差し戻すのは親Issueの作業項目が`approved`か`pr_open`のときだけで、それ以外の状態(実装中、要件定義の生成中や承認待ちなど)、親の試行回数が`max_attempts`に達しているとき、親の状態が読み取った後に変わったときは差し戻さず、pr_fixの作業項目を`needs_human`にしてDiscordで知らせる。通知の次の操作に従い、実装フローの完了や要件定義の承認を待ってから`factory:fix`を付け直す(要件の不足の報告は通知の理由に載る)。
- Factory自身の投稿は「viewer(FactoryのGitHubアカウント)と同じログイン**かつ**Factoryマーカー付き」の両方で判定する。同一アカウントで運用しているため、人が投稿したコメントはログインが一致してもマーカーが無いのでhuman feedbackとして扱われる。同様にFactory自身の一次レビュー(`pr_review`)とその未解決のインラインコメントもマーカー無し(または`pr_review`マーカー)であればfeedbackとして扱われ、pr_fixはその指摘を修正対象にする。除外されるのはFactory自身の`pr_fix`返信(`pr_fix`マーカー付き)のみ。

#### 各コメントへの返信の3値(`decision`)

各レビューコメント・未解決コメントへの返信は、`fixed` / `skipped` / `propose_issue`のいずれかになる(ユーザー決定、2026-09-26)。

| `decision` | 意味 | 返信末尾 |
| --- | --- | --- |
| `fixed` | このPRの範囲内で修正した | `対応: <commit sha7>` |
| `skipped` | 対応しないと判断した(理由は`body`に書く) | `対応: 見送り` |
| `propose_issue` | 指摘は妥当だがこのPRの範囲外。Issue化を提案する | `対応: Issue化を提案(承認待ち)` |

`propose_issue`の提案は`factory.issue_proposals`に記録され、その回のpr_fixは`needs_human`で終わる。1件でも提案が残っている間はこの状態が続く。

#### Issue化提案の承認 / 却下(ConsoleのInbox)

- ConsoleのInboxタブに、要件定義の承認待ちと並んで「Issue化提案」の種別バッジ付きで一覧表示され、そこから承認 / 却下する。左の一覧でPR番号・PRタイトル・提案タイトル・作成日時・担当者を確認して提案を選ぶと、右に提案本文(Markdown)と操作欄が表示される。「起票と同時にfactoryラベルを付けて要件定義に進める」のチェックボックス(Issue化提案は既定オフ、改善提案は既定オン)で`with_factory_label`を切り替え、却下時のみ理由欄が必須になる。Appを使わない代替手順として、Windmill UIで`f/factory/approval_decide`を直接開き、`approval_request_id`(ConsoleのInboxに記載)/ `decision`(approve / reject) / `reason`(却下時は必須) / `options`(承認時のみ`{"with_factory_label": true}`のように指定)を入力してRunすることもできる。
- **承認**すると、提案の`title` / `body`でIssueを対象リポジトリに作成し(`body`中の`{{pr_url}}`は元PRのURLに置換され、末尾に起票元を示す一文が付く)、レビュースレッドに`Issue #Nを起票しました。`と返信してスレッドを解決(resolve)する。`with_factory_label`を`true`にすると、作成したIssueに`factory_config.trigger_label`(既定`factory`)が付き、そのまま要件定義工程に乗る。ラベルを付けない場合は起票のみで、必要になったら人が後から`factory`ラベルを付ける。
- **却下**すると、レビュースレッドに`見送りとします。`+ 入力した理由を返信するが、スレッドは開いたままになる(人が改めて判断する)。
- 対象の作業項目に未決定の提案が残っていなければ、作業項目の状態を`needs_human`から`rereview_requested`(その回でコミットをpushしていた場合)または`reviewed`(pushしていなかった場合)へ自動で切り替える。未決定の提案が他に残っている間は`needs_human`のまま。
- **同じ`decision`での再実行は安全**(冪等)。承認は`status = 'pending'`条件付きのUPDATEで一度だけ決定を記録し、作成したIssueの本文へ`<!-- factory:issue_proposal:<id> -->`というマーカーを埋め込む。途中(決定の記録後、Issue作成前後)でjobが失敗して同じ`proposal_id` / `decision`で再実行しても、このマーカーで既存のIssueを検索して再利用するため、Issueが二重に作られることはない。すでに承認 / 却下が完了している提案に対して異なる`decision`を投げた場合は、上書きせずエラーで拒否する。
- **起票に失敗した提案はInboxに残る**。Issueの作成自体が失敗した場合は決定前の`pending`に戻り、Issue作成後の返信・スレッド解決・状態遷移が失敗した場合は`承認済み・起票未完了`として(「起票未完了」バッジ付きで)Inboxに表示され続ける。いずれの場合も改めて承認を実行すれば、続きから起票する。

### ラベルと終端状態(2026-09-27方針変更)

- PRに付くラベルはトリガーのみ(Issueの`factory`と同じ方針): `factory:review`(レビュー起動) / `factory:fix`(修正起動)。人か、実装フローがPRを作ったときに付与し、claim時に消費されて外れる。以後はどの状態遷移でもPRのラベルは付け外しされない。状態は`work_items.status`のみが正であり、ConsoleのPipelineタブで確認する。このリポジトリ自身の基盤整備PR(foundation PR)には`factory:review` / `factory:fix`のいずれも付けない。
- 終端状態: `reviewed`(pr_review完了、修正不要・人のApprove待ち) / `rereview_requested`(修正をpushして再レビュー依頼中) / `blocked` / `needs_human`(人の対応が必要。pr_fixが`needs_human` / `blocked` / `failed`で終了したとき、pr_review自体が失敗したとき、またはIssue化提案(`propose_issue`)が1件以上あるとき)。
- トリガーラベルが外れた後も、`tracked_pr_days`(既定30日、`factory_config`)以内に更新のあったPRは`poll_prs`がDB(`work_items`、`listTrackedPrs`)から再発見し続ける。人が新しいcommitをpushするたびに自動で再レビューが起動する(1 pushにつきClaude実行1回)。これ以上追跡させたくないPRはcloseするか、`tracked_pr_days`を過ぎるまで待つ。
- `review_post_mode: "gated"`ではレビューを投稿しない。gatedは検証用の予約モードで、PRはレビュー依頼かassignee経由でのみ再発見される。
- 対象は`factory_config`の`repo_allowlist`(未指定なら`owners`に含まれるリポジトリ全体)に含まれるリポジトリのみ。`factory_repo`は`repo_allowlist`に関わらず常に対象。試験的に対象を絞りたい場合は`repo_allowlist`に対象リポジトリを明示する。

### pr_fixの再実行

- `retry_work_item`で`failed` / `needs_human` / `blocked`のpr_fix行を再実行できる。処理済みwatermark(`last_review_id` / `last_comment_id` / `last_review_comment_id`)はpush成功時(または要件定義への差し戻し、`requirements_gap`)にしか進まないため、それ以外の終端(`failed` / `needs_human` / `blocked`)から再実行すると前回と同じフィードバックが再収集される。
- pr_fixは`factory:fix`ラベルからしか起動しない(コメントやcommitのpushだけでは自動起動しない、2026-09-26のユーザー決定)。次のroundを明示的に始めたいときは、PRに`factory:fix`ラベルを付け直す。

### 人が作ったPRと要件の紐づけ

- PR本文に`Closes #123`(`Fixes` / `Resolves`も可)と書くと、そのIssueに対応する承認済み要件と照合され、pr_review / pr_fixのClaude入力に要件が渡る。

## 更新の反映

- `mise run push` / `mise run deploy`は`wmill sync push`の前にConsole raw appの`npm ci`を実行する(raw appのバンドルに依存が必要なため)。
- `f/`・`migrations/`・`.claude/skills/`の変更は`self_update`が自動で反映する。`infra/`と`mise.toml`の`[tools]`・`[env]`の変更は、ホスト側checkoutを`git pull`したうえで次に`mise run up`で起動したときに反映される(ビルドはホスト側checkoutから行うため、先にmainを取り込む)。通知はしない。
- 一括で反映したいときは`mise run deploy`を手動で実行する(ホスト側checkoutで`git pull --ff-only` → workerイメージのビルド → `docker compose up -d` → `wmill sync push` → migrationを一括実行する)。必須の手順ではない。
- workerの並列数(`NUM_WORKERS`)のような`infra/docker-compose.yml`の変更は、通常の`git pull`だけでは反映されず、次の`mise run up`でworkerイメージの再ビルドとコンテナの再作成まで行われる。すぐ反映したいときは`mise run up`か`mise run deploy`を実行する。
- worker imageに入れるツール(`claude` / `gh` / `gitleaks` / `gtr` / `wmill`)のバージョンは`mise.toml`の`[env]`(`CLAUDE_VERSION` / `GH_VERSION` / `GITLEAKS_VERSION` / `GTR_REF` / `WMILL_VERSION`)で固定し、`infra/worker/Dockerfile`のbuild argとして渡す。ツールの追加やバージョン変更はworker imageのrebuildが必要な変更で、`git pull`だけでは反映されない。`self_update`は`infra/`と`mise.toml`の`[env]`の変更として検知してログと`deployments`に記録するが通知はしないので、次の`mise run up`で反映される。`gitleaks`は工程3(実装フロー)が毎ラウンドの固定検査として`--redact`付きで実行するためにworker imageに入れている(ホスト側のpre-commit hookと同じバージョン)。
- workerコンテナは`init: true`(docker-init)をPID 1にしてゾンビプロセスを回収する。jobが起こすgit / gh / esbuildの子プロセスは親より長生きすることがあり、initが無いとwindmill本体に付け替えられたまま回収されず、`pids: 512`の上限を食い潰して全jobが`errno=11`(EAGAIN、スレッドや子プロセスを作れない)で失敗する(2026-09-28に430個のゾンビで再現)。同じ症状が出たら`docker compose -f infra/docker-compose.yml exec windmill_worker cat /sys/fs/cgroup/pids.current`で使用量を見て、`docker compose -f infra/docker-compose.yml restart windmill_worker`で復旧する。
- `wmill sync push`に **`--include-secrets`を付けてはいけない**。付けるとリポジトリ内の`f/factory/*.variable.yaml`(値は空のままコミットされている)で4つのsecret変数(`claude_oauth_token` / `github_token` / `wmill_token` / `discord_webhook_url`)が空に上書きされる。`mise run push`(`wmill sync push --yes --keep-deleted`)は`--include-secrets`を付けない設定になっている。
- secret変数(`f/factory/*.variable.yaml`)とinstance固有の`factory_config` resourceは同期対象外のため、これらの**説明文(description)を変えても`mise run push`では既存instanceに反映されない**。既存instanceではWindmill UI(Variables / Resourcesの編集画面)で説明文だけを更新する。新規instanceはbootstrapがリポジトリの説明文で作成する。
- `f/factory/deployed_sha`変数も同期対象外(理由は他の2つと異なり、instance固有の設定ではなく`self_update`が書き込む実行時状態のため)。`mise run push`を実行しても値は変わらない。`bootstrap`は初回のみ空値で作成し、既に存在する場合は値を変更しない。値をリセットしたい場合はWindmill UIから直接編集する。
- `self_update`スケジュール(10分毎)が`infra/`の変更、または`mise.toml`の`[tools]`・`[env]`セクション(ツールのバージョンとcomposeが読む環境変数)の変更を検知すると、ログと`deployments.needs_host_action`に記録する。通知はせず、次にホスト側で`mise run up`して起動したときに反映される。`mise.toml`の`[tasks.*]`だけの変更、`scripts/`(ホスト側のbootstrap / doctor / lint)、`mise.local.toml.example`の変更はworkerの動作に影響しないため記録しない。`f/`・`migrations/`・`.claude/skills/`の変更は`self_update`が自動で反映するので、ホスト側の操作は不要である。
- `mise run up`で反映されない変更が2つある。(a) `infra/Caddyfile`はbind mountされたファイルのため、これだけを変えても`up -d`はコンテナを再作成しない。`docker compose -f infra/docker-compose.yml restart caddy`でCaddyを再起動して反映する。(b) `mise.toml`の`[tools]`のうちホスト側のCLIは`mise install`(または`mise run setup`)で反映され、`up`では反映されない。`up`が反映するのは`[env]`のworker imageのツールのバージョンである。

### Windmillの`admins`ワークスペースにある組み込み項目

- Windmillは起動時に`admins`ワークスペースへ「Synchronize Hub Resource types with instance」などの組み込みscript / scheduleを自動作成する。これらはWindmill本体の一部であり、本リポジトリの管理対象ではない(`mise run push`や`self_update`の同期対象にも含まれない)。summaryが英語のままなのはそのためで、日本語化や削除はしない。
- Factoryの資産はすべて`factory`ワークスペースの`f/factory/**`にある。
- ダッシュボードApp(Factory Console、`f/factory/factory_console__raw_app/`)はraw appとしてコードでリポジトリ管理する。編集はWindmill UIではなくリポジトリのソース(`App.tsx` / `tabs/*.tsx` / `backend/*.yaml`等)を直接編集し、`mise run push`でデプロイする。ロック情報はコミット時にpre-commit hookが自動更新する。

## 秘密のローテーション

1. GitHub PAT / Claude Code OAuthトークンを再発行する(手順は[docs/security.md](security.md)を参照)。
2. 新しい値を`mise set -E local KEY=value`(`read -rs`経由を推奨)で投入する。
3. `mise run bootstrap`を再実行する。`bootstrap.sh`は冪等なので、既存のWindmill変数は新しい値で上書き更新される。

## バックアップ

- Windmillのデータ(ワークスペース設定、Data Table、ジョブ履歴など)はすべて`db_data`というDocker volume(Postgres)に入っている。バックアップの対象はこのvolume。
- `docker compose -f infra/docker-compose.yml down -v`は`db_data`を含むすべてのvolumeを削除する破壊的操作である([docs/setup.md](setup.md)のトラブルシュートも参照)。

## 保持期間

- `cleanup_db`スケジュール(毎日03:30)が、保持期限を過ぎたDBのレコードを削除する。
  - 終端状態(承認済み・要対応・タイムアウト・失敗・レビュー済み・再レビュー依頼・ブロック・キャンセル・PR作成済み(`pr_open`)・監査完了(`audited`))になった作業項目は、既定90日(`factory_config`の`retention_work_items_days`)を過ぎると削除される。`pr_open`の作業項目もPRがopenのままでも90日で削除される。要件定義ドラフト・承認履歴・承認依頼・状態遷移の履歴(`work_item_events`)・Claude実行の記録(`agent_runs`。コスト分析`v_agent_cost_daily`の元データ)も、外部キーの`ON DELETE CASCADE`によりあわせて削除される。コスト分析を保持期間より長く見たい場合は`retention_work_items_days`を延ばす。
  - 作業項目の削除にあわせて、その要件定義ディレクトリ(`requirement_drafts.doc_dir`、workerの`/var/lib/factory/requirements/<owner>/<repo>/issue-<N>/wi-<id>/`以下)もベストエフォートで削除される(DB行の削除とは独立した処理で、削除に失敗しても他の掃除やDB削除自体は止まらない)。
  - 失敗記録・デプロイ記録・解決済みのお知らせは、作業項目とは独立に既定30日(`retention_logs_days`)を過ぎると削除される(未解決のお知らせは対象外)。
  - 監査の作業項目とレポート・提案は終端(`audited`)後90日で削除される(`retention_work_items_days`)。
  - どちらの日数も`f/factory/factory_config`から変更できる。
  - 既知の制約: 同じIssueの作業項目がすべて削除された後にそのIssueを再度拾うと、cycle番号は1から採番し直される(`nextCycleForIssue`は残っている行の最大値から決めるため)。過去の通知やDiscordの履歴に残るcycle番号とは意味が衝突しうる。
  - 削除件数は`cleanup_runs`テーブルに記録され、翌朝09:00の日次サマリ通知(Discord)の「DB 掃除」欄に反映される。

## 未実装の機能

次はまだ実装されていない。実装され次第このドキュメントを更新する。

- 工程4のマージ後CI監視
- Discord双方向化(ボタン操作による承認)
