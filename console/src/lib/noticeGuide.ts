// 通知の種類ごとの、起きたことと次の操作の説明。
// 内容は`docs/operations.md`の通知の表に合わせる。
// 種類を足したときは、ここと表の両方に足す。
// 足し忘れは、`tests/scripts/console_notices_contract.test.ts`が落として知らせる。

export type NoticeGuide = {
  /** 何が起きたか。 */
  readonly meaning: string;
  /** 人がすること。 */
  readonly action: string;
  /** 人が順に入力するコマンド。要らない種類は空。 */
  readonly commands: readonly string[];
  /** 解決の扱いなど、操作の補足。無ければ`null`。 */
  readonly note: string | null;
};

/** 表に無い種類(backendが先に足した新しい種類)に出す説明。 */
export const GENERIC_NOTICE_GUIDE: NoticeGuide = {
  meaning: "この種類の説明はまだありません。",
  action: "本文を確かめ、対応を終えたら解決してください。",
  commands: [],
  note: null,
};

function guide(
  meaning: string,
  action: string,
  extra: { commands?: readonly string[]; note?: string } = {},
): NoticeGuide {
  return {
    meaning,
    action,
    commands: extra.commands ?? [],
    note: extra.note ?? null,
  };
}

const NOTICE_GUIDES: ReadonlyMap<string, NoticeGuide> = new Map([
  [
    "approval_notify_failed",
    guide(
      "承認待ちの通知がDiscordに届きませんでした。",
      "承認依頼は記録済みです。要対応の一覧で承認を判断してください。",
    ),
  ],
  [
    "claim_race_lost",
    guide(
      "ほかのインスタンスか人が先にIssue・PRのトリガーラベルを外したか、別の取得が同じIssueを先に取得しました。",
      "理由がラベルを先に外されたことなら、人が意図して外したのか確かめてください。意図していなければ、何もしなくてかまいません。",
      {
        note: "Issueでは、同じ本文の未解決の通知がある間は追加しません。PRでは、確認できずにトリガーラベルを付け直したときだけ、同じ本文の未解決の通知がある間は追加しません。",
      },
    ),
  ],
  [
    "supersede_failed",
    guide(
      "新しいサイクルを始めましたが、古い承認済みの作業項目を取り消せませんでした。",
      "操作は要りません。古い承認は再開できず、次の新しいサイクルで取り消されます。",
    ),
  ],
  [
    "cleanup_worktrees_skipped",
    guide(
      "動いているPRの修正のブランチを確かめられず、そのリポジトリの作業領域の掃除を見送りました。",
      "次の日の掃除を待ってください。",
    ),
  ],
  [
    "workspace_disk_usage",
    guide(
      "作業領域の掃除が記録したディスク使用量です。",
      "増え続けていないか見てください。",
    ),
  ],
  [
    "fix_feedback_association_excluded",
    guide(
      "許可されていない関係の人のコメントを、修正の材料から除きました。",
      "必要なら、許可された人が指示を書き直してください。",
    ),
  ],
  [
    "labeler_denied",
    guide(
      "許可されていない人が、または付与者を特定できないまま、トリガーラベルを付けました。allowed_labeler_idsにIDを入れたアカウントは、名前が同じでもIDが違う人(改名の後に名前を取得された場合を含む)のラベルを拒否します。IDを入れていないアカウントは、名前だけで照合します。",
      "拾わせるなら、ラベルを外して、許可された人が付け直してください。付ける人を増やすなら、allowed_labeler_loginsに足します。許可した本人のアカウントなのに拒否されたときは、allowed_labeler_idsのIDが合っているか確かめてください。IDは次のコマンドで調べます。",
      {
        commands: ["gh api users/<ログイン名> --jq .id"],
      },
    ),
  ],
  [
    "fork_head_denied",
    guide(
      "PRのheadのリポジトリが、このリポジトリと同一でない(forkか、取得できない)ため、レビューを始めませんでした。同じ組織の別のリポジトリのforkや、許可されたアカウントのforkも対象です。",
      "レビューさせたいときは、同じリポジトリにブランチを作って、PRを出し直してください。止めるなら、factory:reviewラベルを外し、FactoryのGitHubアカウントをassigneeとレビュー依頼から外すか、PRを閉じます。",
      {
        note: "本文は「owner/repo#PR番号:」で始まり、PRごとに残ります。ラベルとassigneeが残る間は、解決しても次のポーリングで同じ通知が出直します。PRを閉じるかマージすると、新しい通知は出ません。",
      },
    ),
  ],
  [
    "unsandboxed_check_commands",
    guide(
      "検査コマンドをサンドボックスなしで実行しました。",
      "設定が意図どおりか確かめてください。",
    ),
  ],
  [
    "implement_needs_human",
    guide(
      "実装フローが人の対応待ちで止まりました。",
      "作業項目の状態を確かめ、原因を取り除いてから、Windmillでf/factory/retry_work_itemを作業項目のIDで実行して、再実行してください。",
    ),
  ],
  [
    "approval_comment_failed",
    guide(
      "承認のコメントをIssueに投稿できませんでした。",
      "承認と実装の起動は進んでいます。必要なら、本文のリンクを載せたコメントを、人がIssueに投稿してください。",
    ),
  ],
  [
    "intake_refreshed",
    guide(
      "却下や再実行による作り直しで、Issueが取り込み後に書き換えられていたので、取り込み内容を現在のIssueで更新しました。",
      "承認を選んで、更新後の取り込み内容を確かめてから承認してください。確かめたら、この通知を解決します。",
    ),
  ],
  [
    "implement_launch_failed",
    guide(
      "承認の後、実装フローへ進める処理がDBの失敗で例外になりました。",
      "Windmillでf/factory/retry_work_itemを作業項目のIDで実行して、再開してください。",
    ),
  ],
  [
    "fix_reply_post_failed",
    guide("修正の返信の投稿に失敗しました。", "PRで人が返信してください。"),
  ],
  [
    "pr_fix_reviewer_request_failed",
    guide(
      "再レビューの依頼のAPIが失敗しました。PRの取得の失敗と、Botや削除済みの作成者の名前で依頼を組み立てられない場合を含みます。",
      "GitHubのPRで、人がレビュアーを依頼してください。",
    ),
  ],
  [
    "issue_proposal_record_failed",
    guide(
      "Issue化の提案を記録できませんでした。",
      "PRのスレッドを確かめ、必要なら人がIssueを起票してください。",
    ),
  ],
  [
    "claim_assignee_missing",
    guide(
      "Issueを取得しましたが、FactoryのGitHubユーザーをassigneeにできませんでした。作業は続いています。",
      "そのユーザーが、リポジトリのpush権限を持つcollaboratorか確かめてください。",
    ),
  ],
  [
    "labeler_check_limit",
    guide(
      "トリガーラベルの付与者を判定できません。直近100件のラベルのイベントにトリガーラベルのイベントが無く、古いイベントが残っています。",
      "ラベルを外して、許可された人が付け直してください。",
      { note: "対応した後に、この通知を解決します。" },
    ),
  ],
  [
    "pr_trigger_label_left_removed",
    guide(
      "PRのトリガーラベルを外した後に取得を確認できず、ラベルが外れたままで作業項目もありません。",
      "ラベルが付いていないか、サイクルが始まっていないかを確かめてから、ラベルを付け直してください。",
      {
        note: "そのPRとラベルで次に作業を始めると、自動で解決されます。取得が不要なら、人が解決します。",
      },
    ),
  ],
  [
    "owner_id_mismatch",
    guide(
      "設定したオーナーの数値IDが、GitHubの現在のIDと食い違うか、その名前のアカウントやリポジトリが見つかりません。オーナーが改名または削除された可能性があります。保存済みの作業項目のオーナーが、ownersに無くなっていることもあります。このオーナーの検索は飛ばし、そのオーナーのリポジトリの作業項目は、リポジトリを取得せずに止めています。",
      "GitHubで、そのアカウントが意図した持ち主か確かめ、factory_configのownersの名前とIDを見直してください。止めた作業項目は、見直した後に再実行します。",
      {
        note: "名前とIDが合うと、次の回から検索が再開します。見直した後に、この通知を解決してください。",
      },
    ),
  ],
  [
    "factory_repo_id_mismatch",
    guide(
      "設定したfactory_repo_idが、factory_repoのGitHubの現在のIDと食い違うか、そのリポジトリが見つかりません。リポジトリが削除されたか、オーナーが改名して別の人がその名前を取得したか、PATがそのリポジトリを読めなくなった可能性があります。privateリポジトリでは、PATがアクセスを失うと404になることがあります。自己更新は取得も反映もせず、Factory自身のリポジトリを使うほかの処理は、取得の前に失敗します。",
      "GitHubで、そのリポジトリが意図した持ち主のものか、PATがそのリポジトリを読めるかを確かめ、factory_configのfactory_repoとfactory_repo_idを見直してください。",
      {
        note: "名前とIDが合うと、次の回から自己更新が再開し、ほかの処理も取得できます。見直した後に、この通知を解決してください。",
      },
    ),
  ],
  [
    "deployed_sha_mismatch",
    guide(
      "自己更新が反映した版が、self cloneのHEADに30分を超えて追いついていません。反映が遅れただけでも出ることがあります。",
      "自己更新のジョブのログを確かめてください。",
      {
        note: "自己更新が反映に成功すると、自動で解決されます。本文が名指しする版が今の反映済みの版と違い、自己更新が成功しているときは、人が解決してかまいません。反映が止まっている間は、解決しても出直します。",
      },
    ),
  ],
  [
    "host_action_required",
    guide(
      "自己更新が反映した版に、worker自身では反映できない変更(infra/、mise.tomlの[tools]・[env])が含まれています。ホストで作業するまで、新しい構成は動きません。実装、PR修正、作業領域の掃除が、workerのイメージが古くて検査コマンドを実行できないと分かったときにも出ます。そのときは、検査コマンドのある作業項目は進みません。",
      "ホストのcheckoutで、次のコマンドを順に実行してください。mise run upは、Caddyを再起動したうえで、終わりにそのcheckoutのHEADをworkerへ渡します。イメージが古くて止まった作業項目は、mise run upの後に通知が自動で解決されると、自動で再開します。自動の再開が3回の上限に達したときと、版が載らない通知のときだけ、Windmillでf/factory/retry_work_itemを作業項目のIDで実行して再開してください。",
      {
        commands: ["git pull", "mise install", "mise run up"],
        note: "通知の版がホストのHEADと同じか祖先なら、自己更新(2分ごと)が自動で解決します。HEADを書けなかったときと、版が載らない通知(イメージが古いと分かったときに、反映した版を読めなかったもの)は自動では解決されないので、mise run upが済んでいれば人が解決してかまいません。",
      },
    ),
  ],
  [
    "cleanup_db_failed",
    guide(
      "保持期間を過ぎたレコードの削除に失敗しました。",
      "内容を確かめてください。次の日の掃除でやり直します。",
    ),
  ],
  [
    "cleanup_worktree_busy",
    guide(
      "終端の作業項目のworktreeを、使用中として消しませんでした。残ったプロセスが使っているか、検査用のユーザーからrootに戻せないためです。",
      "本文の理由がプロセスなら、載ったプロセスを止めてください。rootに戻せないなら、運用の文書の「検査の枠の記録を片付ける」の手順で片付けてください。対処しない限り、同じ通知が1件残り続けます。",
    ),
  ],
  [
    "check_slot_skipped",
    guide(
      "検査の枠を、前の実行の残りを片付けられないため飛ばし、別の枠で検査しました。本文に枠のユーザーと理由が載ります。",
      "理由が止まらないプロセスなら、workerを再起動してください。残ったファイルなら、本文のパスを確かめて消してください。worktreeの取り戻しに失敗し続けるなら、枠の記録が指すworktreeをrootに戻してから記録を消してください。手順は運用の文書の「検査の枠の記録を片付ける」にあります。",
      {
        note: "飛ばした枠は、次にその枠を取る検査が片付け直します。片付くまでは、同じ理由のnoticeが未解決のまま1件残ります。",
      },
    ),
  ],
  [
    "check_runtime_unsafe",
    guide(
      "稼働中のworkerに、誰でも書き込めるパスができたか、それを確かめられなかったため、検査コマンドを非特権のユーザーで実行できません。本文にパスか確かめられなかった理由が載ります。直すまで、検査コマンドのある実装とPR修正は止まります。",
      "本文のパスを、ホストのcheckoutから次の1つ目のコマンドで閉じるか、2つ目のコマンドでworkerを作り直してください。作り直すと、そのとき動いているジョブも止まります。/workspacesと/var/lib/factoryは、ボリュームのマウントポイントで、作り直しでは閉じないので、1つ目のコマンドで閉じてください。直したら、止まった作業項目をWindmillでf/factory/retry_work_itemを作業項目のIDで実行して再開し、この通知を解決してください。",
      {
        commands: [
          "mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker chmod o-w <パス>",
          "mise exec -- docker compose -f infra/docker-compose.yml up -d --force-recreate windmill_worker",
        ],
        note: "イメージの問題ではないので、mise run upは要りません。自動では解決されません。パスが何度もできるときは、作ったジョブを確かめてください。",
      },
    ),
  ],
  [
    "check_slot_record_unreadable",
    guide(
      "検査の枠の記録が読めないため、記録を退避して、その枠の片付けを続けました。本文に枠のユーザーと退避した先のパスが載ります。",
      "退避した記録の中身を確かめ、記録が指すworktreeが枠のユーザーの所有のまま残っていればrootに戻し、HOMEが残っていれば消してから、退避した記録を消してください。手順は運用の文書の「検査の枠の記録を片付ける」にあります。",
    ),
  ],
  [
    "console_fetch_failed",
    guide(
      "Consoleの取り込みが失敗しました。",
      "本文の「次の操作」に従ってください。",
    ),
  ],
  [
    "console_fetch_stale",
    guide(
      "Consoleの取り込みの結果が30分以上更新されていません。",
      "取り込みのコンテナ(console_fetcher)が動いているか確かめてください。",
    ),
  ],
  [
    "console_worker_missing",
    guide(
      "tag consoleのジョブが、予定時刻から5分以上実行されずに待っています。Console用のworkerが居ないか、塞がっているか、tagの設定がずれています。",
      "本文の「次の操作」に従い、コンテナの状態、再起動、Windmillの画面での実行中のジョブとワーカーグループのtagの順に確かめてください。",
      {
        note: "mise run upでConsole用のworkerを作り直している間にも出ます。作り直しが終われば、人が解決します。",
      },
    ),
  ],
  [
    "console_worker_check_failed",
    guide(
      "Console用のworkerがジョブを受けているかを、1時間続けて確かめられませんでした。workerが止まっていても気づけない状態です。",
      "自己更新のジョブログの警告を確かめて、原因を直してください。console_fetch_watchのスケジュールが有効かも確かめます。",
    ),
  ],
  [
    "worker_sample_failed",
    guide(
      "defaultのworkerの負荷を、10分以上続けて完全には記録できませんでした。枠の占有かメモリのどちらかが欠けた行ができています。",
      "sample_worker_loadの直近のジョブログの警告を確かめてください。queueの取得、cgroupの読み取り、DBへの記録のどれが失敗しているかが出ます。",
    ),
  ],
  [
    "schedule_failing",
    guide(
      "同じスケジュールの直近3回の実行が、続けて失敗しました。",
      "ジョブのログで失敗の内容を確かめて、原因を直してください。GitHubのPATの失効が原因なら、PATを再発行します。",
    ),
  ],
  [
    "schedule_failing_check_failed",
    guide(
      "スケジュールが続けて失敗しているかを、ジョブ履歴から判定できませんでした。失敗が続いても気づけない状態です。",
      "on_error_scheduleのジョブのログで、failed to read the schedule historyのエラーを確かめ、ジョブ履歴を読む権限があるかを確かめてください。",
    ),
  ],
  [
    "drawio_viewer_bump_held",
    guide(
      "draw.ioのビューアの固定を、自動では上げませんでした。ビューアの大きさが大きく変わったか、取得したファイルがGitHubの記録と一致しないか、PRの無い既存のブランチの中身が作るはずの内容と違いました。上げる版に選んだ最新の版を保留している間は、それより古い版も上げません。",
      "本文の「次の操作」に従ってください。既存のブランチが原因なら、ブランチを確かめ、不要なら削除します。大きさの変化が正当なら、Windmillでf/factory/drawio_viewer_bumpをapproved_versionにその版を指定して実行します。",
      {
        note: "解決しても、原因が続けば次の週に同じ通知が出直します。新しい版が出れば、その版を自動で試します。",
      },
    ),
  ],
  [
    "main_ci_failed",
    guide(
      "対象リポジトリの既定のブランチで、コミットのCI(GitHub Actionsのpushの実行)が失敗しました。本文に、リポジトリ、コミットの先頭7文字、失敗した実行のリンクが載ります。",
      "リンク先の実行のログで原因を確かめ、直す修正を入れるか、原因のコミットを取り消してください。",
      {
        note: "同じリポジトリで、より新しいコミットのCIが通ると自動で解決されます。同じコミットの実行をやり直して通っても失敗は取り消されず、次のコミットが通ったときに解決されます。",
      },
    ),
  ],
  [
    "main_ci_check_denied",
    guide(
      "対象リポジトリの既定のブランチのCIの実行を、GitHubから読めませんでした(403か404)。GITHUB_TOKENの権限が足りないか、リポジトリにアクセスできません。読めない間は、そのリポジトリのmainのCIの失敗に気づけません。",
      "GitHubのfine-grained PATの設定で、Repository accessに対象リポジトリが入っているか、Actions: Read-onlyが付いているかを確かめてください。権限を足してもPATの値は変わらないので、Windmillの変数を更新する必要はありません。組織のリポジトリでは、組織の承認が再び要ることがあります。",
      {
        note: "権限を足して読めるようになると、次の回に自動で解決されます。",
      },
    ),
  ],
  [
    "pr_ci_failed",
    guide(
      "Factoryが作ったPRのheadのコミットで、CI(GitHub Actionsのpull_requestかpushの実行)が失敗しました。本文に、PR、コミットの先頭7文字、理由、次の操作、リンクが載ります。自動修正が有効なときは、直せるかが決まってから出る通知で、本文に自動修正の保留の理由も載ります。",
      "本文の「次の操作」に従ってください。保留の理由が載っていなければ、リンク先の実行のログで原因を確かめ、PRに修正を入れます。metadataジョブの失敗なら、「mise run metadata」を実行して差分をコミットします。取り消しやフレークなら、実行をやり直します。",
      {
        note: "同じheadの実行をやり直して通ると、自動で解決されます。PRにpushして新しいheadが通ったときと、PRを閉じたときも自動で解決されます。自動修正が有効なときは、直せた失敗は通知されません。",
      },
    ),
  ],
  [
    "pr_conflict",
    guide(
      "Factoryが作ったPRが、ベースブランチとマージできない競合の状態です。本文に、PR、次の操作、PRのリンクが載ります。競合したままだと、PRをマージできません。",
      "PRのブランチにベースブランチをmergeして競合を解消し、pushしてください。解消後のCIとレビューは、通常どおり動きます。",
      {
        note: "競合が解けると、次の回に自動で解決されます。PRを閉じたときも自動で解決されます。競合が続く間は、PRのコミットが進んでも通知は重なりません。PATがリポジトリを読めなくなっただけでは解決されないので、PRが残っているかを確かめてください。手で解決すると、その競合が解けるかPRが閉じるまで、同じ競合は再通知されません。",
      },
    ),
  ],
  [
    "worker_load_high",
    guide(
      "defaultのworkerのメモリが上限に近づいたか、OOMでプロセスが止められました。本文に原因とシステムの画面のリンクが載ります。",
      "システムの画面の「workerの負荷」で、直近24時間のメモリの最大値と、最新の値を確かめてください。実行中のジョブを見て、メモリを使うジョブが並列で動いていないかを確かめます。続くようなら、並列数かメモリの上限を変えるかを判断します。",
      {
        note: "閾値を下回っても自動では解決されません。確かめたあとに、人が解決してください。解決するまでは、同じ原因は重ねて通知されません。メモリの割合は、解決した後も条件が続けば2分後に出直します。多いときは設定のworker_alert_memory_ratioで割合を調整してください。",
      },
    ),
  ],
  [
    "review_gated_prolonged",
    guide(
      "review_post_modeがgatedのまま、レビューがPRに投稿されない状態が続いています。PRには指摘が見えず、レビューの結果はConsoleの作業項目にだけ残ります。",
      "投稿を続けるなら、factory_configのreview_post_modeをcomment_onlyに戻してください。戻すと、次の日次のまとめの実行でこの通知は自動で解決されます。意図してgatedを続けるなら、作業項目で結果を確かめてから、この通知を解決してください。",
      {
        note: "日数と投稿しなかったレビューの件数は、日次のまとめの「レビューの投稿」欄に出ます。gatedを続ける間は、解決しても翌日の日次のまとめで出直します。",
      },
    ),
  ],
  [
    "pr_ci_check_denied",
    guide(
      "対象リポジトリのPRとCIの実行を、GitHubから読めませんでした(403か404)。GITHUB_TOKENの権限が足りないか、リポジトリにアクセスできません。読めない間は、そのリポジトリのPRのCIの失敗に気づけません。",
      "GitHubのfine-grained PATの設定で、Repository accessに対象リポジトリが入っているか、Actions: Read-onlyが付いているかを確かめてください。権限を足してもPATの値は変わらないので、Windmillの変数を更新する必要はありません。組織のリポジトリでは、組織の承認が再び要ることがあります。",
      {
        note: "権限を足して読めるようになると、次の回に自動で解決されます。",
      },
    ),
  ],
]);

/** `kind`の説明。表に無い種類は`GENERIC_NOTICE_GUIDE`を返す。 */
export function noticeGuide(kind: string): NoticeGuide {
  return NOTICE_GUIDES.get(kind) ?? GENERIC_NOTICE_GUIDE;
}
