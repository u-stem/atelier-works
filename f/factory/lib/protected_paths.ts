// 保護パスの判定を、pr_fixとimplementフローで共有する。
// pr_fix(`steps/pr_workflow_support.ts`)では一致するとpushを止め
// (docs/security.md「PR修正の安全策」)、implementフロー(`lib/implement_support.ts`)では
// PR本文とDiscord通知に記録するだけにする。
// `implement_support`が`steps`からimportしないで済むよう`lib`に置き、
// `pr_workflow_support.ts`が判定関数とpr_fixの一覧を再exportする。

export type ChangedPathStatus =
  | "added"
  | "modified"
  | "deleted"
  | "typechange"
  | "unknown";

export type ChangedPath = {
  readonly path: string;
  readonly status: ChangedPathStatus;
};

/**
 * pr_fixが保護するディレクトリ。
 * どのコマンドが実行されるか、パッケージマネージャーやgitが何を信頼するかを変える設定を
 * すべて含める(エージェントの設定、CIのワークフローとcomposite action、
 * miseのXDG・ドットファイルの設定場所、
 * ディレクトリ形式のlefthook設定)。
 * composite actionは、PATのWorkflowsの権限の拒否が及ばないので、パスで止める。
 * `console/public/`も含める。Consoleでバンドルを通らずにそのまま配信され、ページの中で動くファイルを置く。
 * `infra/console_fetcher/`も含める。Consoleの配信物を検証して配信するコードで、書き換えられると、
 * 検証をすり抜けた内容が運用者のブラウザに配信される。
 * `f/factory/dependabot__flow/`も含める。dependabotの更新を自動でマージするフローで、
 * `flow.yaml`に加えて、フローに埋め込むモジュールも書き換えられると、許可していない更新をマージできる。
 * ホストの実行役が実行する道具のディレクトリも含める。
 * `scripts/host_apply/`は実行役の実装、`infra/worker/`は実行役がビルドするworkerのイメージ、
 * `mise/`はmiseの設定ディレクトリで、どれもホストのユーザーの権限で動くか、動く道具の入力になる。
 * これらの変更をホストへ通す関門は、保護パスではなく実行役の承認である(`docs/security.md`のホストの実行役の節)。
 * 保護パスは、pr_fixの自動修正がこれらを書き換えるのを止め、implementのPRに明記させる補助である。
 */
export const FORBIDDEN_PATH_PREFIXES: readonly string[] = [
  ".claude/",
  ".agents/",
  ".github/workflows/",
  ".github/actions/",
  ".mise/",
  ".config/mise/",
  ".lefthook/",
  "console/public/",
  "infra/console_fetcher/",
  "f/factory/dependabot__flow/",
  "scripts/host_apply/",
  "infra/worker/",
  "mise/",
];

/**
 * pr_fixが保護する個別のファイル(リポジトリのルートからの相対パス)。
 * `console/index.html`は、Consoleのすべてのscriptの読み込み元で、バンドルを通らずに配信される。
 * ファイル名だけでは他の`index.html`と区別できないので、パスで判定する。
 * `console/drawio-viewer.json`は、CIが取得して配信するdraw.ioのビューアの取得元とsha256を固定する。
 * 書き換えられると、別のスクリプトを固定の値として配信される。
 * 固定を書き換えるPRを作る`f/factory/drawio_viewer_bump.ts`、その判断の`lib/drawio_viewer_bump.ts`、
 * 更新だけが使うGitHubの読み取りの`lib/drawio_viewer_bump_github.ts`、14日の待ちの根拠になる
 * 観測の記録の`lib/drawio_viewer_observations.ts`、スケジュールとscriptの定義(`*.schedule.yaml`、
 * `*.script.yaml`)も同じ理由で守る。書き換えられると、人の確認なしに別の取得元や版を固定のPRにできる。
 * 部品のscript定義(`lib/drawio_viewer_bump*.script.yaml`、`lib/drawio_viewer_observations.script.yaml`)も守る。
 * `.script.yaml`は、`lock`の参照先を決める。参照先を書き換えられると、反映のときにworkerやホストの
 * 任意のファイルがlockとして読まれうるので、libのものも守る。
 * 一方、`drawio_viewer_bump.script.lock`と`lib/drawio_viewer_observations.script.lock`は守らない。
 * `windmill-client`の版を上げる変更で、全scriptのlockと一緒に書き換わり、その変更を止めてしまうためである。
 * 依存の無い`lib/`のlockも守らない(後述の「libのlockは入れない」)。
 * 固定を強制する側も同じ理由で守る。ビューアの照合と取得、配信物の一覧(manifest.json)の作成、
 * lockfileの検査のスクリプトは、書き換えられると検査をすり抜けて配信物に混ざる。
 * `asset-name.ts`は照合したビューアの書き込み先の名前を決め、`vite.config.ts`は
 * 組み立ての途中で任意のコードを動かして配信物に書ける。
 * `scripts/ci-scope.ts`は、CIがどのジョブを動かすかを決める。書き換えられると、検査のジョブを
 * 黙って飛ばせるので、固定を強制する側と同じ理由で守る。
 * `infra/Caddyfile`には、Consoleのscriptの許可と、draw.ioの図を隔離するCSPがある。
 * `infra/`全体は、pr_fixでは止めない。
 * 図を隔離して描くiframeの検査(`tests/lib/drawio_frame_isolation.test.ts`)も守る。
 * このテストは、`DrawioFrame.tsx`のsandboxとiframeの受け口のメッセージを固定値と照合する。
 * 書き換えられると、図を描くiframeにsandboxを外したり別のページを読ませたりしても、検査を通る。
 * sandboxは、HTTPのCSP(`infra/Caddyfile`)も後ろ盾になる。
 * scriptの定義の`lock`の契約テスト(`tests/lib/script_yaml_lock_contract.test.ts`)も守る。
 * `wmill sync push`は`lock: '!inline <パス>'`のパスを制限なしに読んでlockとして保存する。
 * このテストが、すべての定義の参照先を自分の`.script.lock`に固定している。
 * 書き換えられると、保護の外の定義から、workerやホストの任意のファイルをlockに載せられる。
 * `wmill.yaml`も守る。`codebases`の`customBundler`は、`wmill sync push`が反映時にシェルで実行する。
 * `assets`の`from`は、`wmill sync push`が任意のパスのファイルを読んでワークスペースに載せる。
 * 書き換えられると、反映するworkerやホストで任意のコマンドが走り、任意のファイルがワークスペースに載る。
 * `wmill-lock.yaml`は、依存の変更のたびに書き換わるので守らない。
 * dependabotのセキュリティ更新PRを自動でマージするフローも守る。マージの判定(`lib/dependabot_support.ts`)、
 * 影響調査のプロンプト(`lib/dependabot_prompt.ts`)、npm registryの取得(`lib/dependabot_registry.ts`)、
 * ゲート入力の組み立て(`lib/dependabot_collect.ts`)、フローの支援関数(`lib/dependabot_flow_support.ts`)、
 * 取得(`poll_dependabot.ts`)とそのスケジュール、
 * 3つのステップ(`steps/dependabot_prepare.ts`、`dependabot_assess.ts`、`dependabot_finish.ts`)と、
 * それぞれのscript定義(`*.script.yaml`)である。フロー(`dependabot__flow/`)は、前方一致で守る。
 * 書き換えられると、人の確認なしに、許可していない更新をマージできる。
 * まだ存在しないファイルも先に守る。名前を先に押さえ、後から置かれたファイルが保護の外に出ないようにするためである。
 * 一方、窓口の`poll_dependabot.script.lock`と`steps/dependabot_*.script.lock`は守らない。
 * `windmill-client`を含み、その版を上げる変更で全scriptのlockと一緒に書き換わり、その変更を止めてしまうためである。
 * CIが出すメタデータのパッチを取得して検査する部品(`lib/metadata_patch_*.ts`の6つ)と、それぞれの`.script.yaml`も守る。
 * 6つのうち、`metadata_patch_manifest.script.lock`だけは守る。新しいscriptのlockを照合するときの空のlockの参照
 * (`metadata_patch_verify.ts`の`EMPTY_LOCK_REFERENCE`)で、壊されると新しいscriptの自動適用が断られ続けるためである。
 * 6つは、manifest、zip、yaml、verify、imports、downloadである。
 * パスの許可リスト、manifestの形、zipの読み方、yamlの許可するキー、importの読み方、適用の条件、
 * トークンの渡し先と取得先を決める。書き換えられると、パッチの受け取り側の検査が緩む。
 * `wmill-lock.yaml`のhashを自前で再計算する部品(`lib/metadata_hash.ts`、`lib/metadata_precheck.ts`、`lib/metadata_signature.ts`、
 * `lib/metadata_git_ports.ts`)と、それぞれの`.script.yaml`も守る。
 * hashの算法、再計算してよい条件、`main`の引数の比べ方、検査が読むgitのオブジェクトの取り方を決める。
 * 書き換えられると、依存が変わるPRや、入力のスキーマが変わるPRのlockを、人の確認なしに書き換えさせられる。
 * 再計算の出力を配線する`lib/ci_metadata_rehash.ts`と、その`.script.yaml`も守る。
 * `wmill-lock.yaml`だけの変更を許す条件(`confirmRehash`、`rehashPushStopReason`、`readStagedRootLock`)と、書き込み先を決める。
 * libのlockは入れない。上のlibは`main`を持たず、単独のjobとして動かない。importする側のscriptは
 * 自分の`.ts`と`.script.lock`で動くので、libのlockは実行の入力にならず、中身が変わっても動きは変わらない。
 * libの`.ts`と、`lock`の参照先を固定する`.script.yaml`は、守られている。
 * この前提(libが`main`、`preprocessor`、行頭の`export default`、再exportを持たない)は、
 * `tests/lib/protected_paths.test.ts`が固定する。
 * 一方、次のものは、このリストに入れない。
 * 例外を開くコールバックの本体(`steps/pr_fix_verify.ts`と`steps/pr_fix_finish.ts`)と、
 * 変更の形を判定する`isLockOnlyChange`と、それを呼ぶ`isRehashCandidate`、`inspectCiFixChanges`の`rehashCheck`の分岐、
 * 回の分類を読む`readCiFailure`(いずれも`lib/ci_fix_round.ts`)、失敗したジョブを分類する`classifyCiFailure`(`lib/ci_fix_classify.ts`)である。
 * `classifyCiFailure`の結果が、`metadata`だけが落ちた回(`metadata_only`)を決め、起動の判断の免除(予算とマーカーの確認)を決める。
 * 再計算が読むgitの動き方を決める、`lib/workspace.ts`のgitの固定設定(`FIXED_GIT_CONFIG`、`GIT_NO_REPLACE_OBJECTS`、`GIT_ALLOW_PROTOCOL`)も入れない。
 * ほかのCI回の部品と同じく、日常的に直すファイルで、守るとその正当な変更をすべて止めるためである。
 * これらを書き換えて例外の条件を緩める変更は、マージ前の人のレビューで差分を確かめて止める。
 * ホストの実行役が実行するファイルも守る。実行役の入口(`scripts/host-apply.ts`、まだ存在しない`scripts/host-apply.sh`)、
 * 導入と診断と初期化のスクリプト(`host-install.sh`、`check-docker-version.sh`、`doctor.sh`、`bootstrap.sh`、
 * `custom-tags.ts`、`record-host-applied.sh`)は、ホストのユーザーの権限で、秘密値を渡して動く。
 * `check-idle.ts`(`mise run up`と`mise run deploy`が呼ぶ、実行中の仕事の確認)とそのテストも、同じく守る。
 * `infra/docker-compose.yml`は実行役が静的に検査して反映する定義で、`tests/infra/docker_compose.test.ts`は
 * その定義の境界を固定する。実行役のテスト(`tests/scripts/host_apply_*.test.ts`)と、それが使う
 * 一時リポジトリの補助(`tests/fixtures/host_apply_repo.ts`)も、実行役の判定を固定するので守る。
 * 実行役のテストは、グロブではなくファイル名で列挙する。名前を先に押さえ、足したテストを列挙し忘れると、
 * 保護パスの契約テスト(`tests/lib/protected_paths.test.ts`)が失敗する。
 * CI回のClaudeには、`ci_`と`pr_fix_`で始まるファイルを、CI回の拒否(`ci_fix_paths.ts`)が別に止める。
 * 共有の`lib/github.ts`は、ほかのフローも使うので守らない。
 * dependabotのフローが使うほかの共有モジュール(`lib/`の`dependabot_*`以外と`steps/pr_workflow_support.ts`)も守らない。
 * どれもほかのフローが日常的に直すファイルで、守るとその正当な変更をすべて止めるためである。
 * これらを書き換えてdependabotのフローの判断を変える変更は、PRのレビューで差分を確かめて止める。
 */
export const FORBIDDEN_EXACT_PATHS: readonly string[] = [
  "wmill.yaml",
  "console/index.html",
  "console/drawio-viewer.json",
  "f/factory/drawio_viewer_bump.ts",
  "f/factory/lib/drawio_viewer_bump.ts",
  "f/factory/lib/drawio_viewer_bump_github.ts",
  "f/factory/lib/drawio_viewer_observations.ts",
  "f/factory/lib/drawio_viewer_bump.script.yaml",
  "f/factory/lib/drawio_viewer_bump_github.script.yaml",
  "f/factory/lib/drawio_viewer_observations.script.yaml",
  "f/factory/drawio_viewer_bump.script.yaml",
  "f/factory/drawio_viewer_bump.schedule.yaml",
  "console/scripts/drawio-viewer.ts",
  "console/scripts/fetch-drawio-viewer.ts",
  "console/scripts/manifest.ts",
  "console/scripts/write-manifest.ts",
  "scripts/check-console-lockfile.ts",
  "scripts/ci-scope.ts",
  "console/scripts/asset-name.ts",
  "console/vite.config.ts",
  "infra/Caddyfile",
  "tests/lib/drawio_frame_isolation.test.ts",
  "tests/lib/script_yaml_lock_contract.test.ts",
  "f/factory/lib/dependabot_support.ts",
  "f/factory/lib/dependabot_support.script.yaml",
  "f/factory/lib/dependabot_prompt.ts",
  "f/factory/lib/dependabot_prompt.script.yaml",
  "f/factory/lib/dependabot_registry.ts",
  "f/factory/lib/dependabot_registry.script.yaml",
  "f/factory/lib/dependabot_collect.ts",
  "f/factory/lib/dependabot_collect.script.yaml",
  "f/factory/lib/dependabot_flow_support.ts",
  "f/factory/lib/dependabot_flow_support.script.yaml",
  "f/factory/poll_dependabot.ts",
  "f/factory/poll_dependabot.script.yaml",
  "f/factory/poll_dependabot.schedule.yaml",
  "f/factory/steps/dependabot_prepare.ts",
  "f/factory/steps/dependabot_prepare.script.yaml",
  "f/factory/steps/dependabot_assess.ts",
  "f/factory/steps/dependabot_assess.script.yaml",
  "f/factory/steps/dependabot_finish.ts",
  "f/factory/steps/dependabot_finish.script.yaml",
  "f/factory/lib/metadata_patch_manifest.ts",
  "f/factory/lib/metadata_patch_manifest.script.yaml",
  "f/factory/lib/metadata_patch_manifest.script.lock",
  "f/factory/lib/metadata_patch_zip.ts",
  "f/factory/lib/metadata_patch_zip.script.yaml",
  "f/factory/lib/metadata_patch_yaml.ts",
  "f/factory/lib/metadata_patch_yaml.script.yaml",
  "f/factory/lib/metadata_patch_verify.ts",
  "f/factory/lib/metadata_patch_verify.script.yaml",
  "f/factory/lib/metadata_patch_imports.ts",
  "f/factory/lib/metadata_patch_imports.script.yaml",
  "f/factory/lib/metadata_patch_download.ts",
  "f/factory/lib/metadata_patch_download.script.yaml",
  "f/factory/lib/metadata_hash.ts",
  "f/factory/lib/metadata_hash.script.yaml",
  "f/factory/lib/metadata_precheck.ts",
  "f/factory/lib/metadata_precheck.script.yaml",
  "f/factory/lib/metadata_signature.ts",
  "f/factory/lib/metadata_signature.script.yaml",
  "f/factory/lib/metadata_git_ports.ts",
  "f/factory/lib/metadata_git_ports.script.yaml",
  "f/factory/lib/ci_metadata_rehash.ts",
  "f/factory/lib/ci_metadata_rehash.script.yaml",
  "scripts/host-apply.ts",
  "scripts/host-apply.sh",
  "scripts/host-install.sh",
  "scripts/check-docker-version.sh",
  "scripts/doctor.sh",
  "scripts/bootstrap.sh",
  "scripts/custom-tags.ts",
  "scripts/record-host-applied.sh",
  "scripts/check-idle.ts",
  "tests/scripts/check-idle.test.ts",
  "infra/docker-compose.yml",
  "tests/infra/docker_compose.test.ts",
  "tests/fixtures/host_apply_repo.ts",
  "tests/scripts/host_apply_target.test.ts",
  "tests/scripts/host_apply_imports.test.ts",
  "tests/scripts/host_apply_ci.test.ts",
  "tests/scripts/host_apply_approval.test.ts",
  "tests/scripts/host_apply_mise_policy.test.ts",
  "tests/scripts/host_apply_env.test.ts",
  "tests/scripts/host_apply_compose_policy.test.ts",
  "tests/scripts/host_apply_dryrun.test.ts",
  "tests/scripts/host_apply_git.test.ts",
  "tests/scripts/host_apply_state.test.ts",
  "tests/scripts/host_apply_notify_text.test.ts",
  "tests/scripts/host_apply_mask.test.ts",
  "tests/scripts/host_apply_timeouts.test.ts",
  "tests/scripts/host_apply_plan.test.ts",
  "tests/scripts/host_apply_package_policy.test.ts",
  "tests/scripts/host_apply_staging.test.ts",
  "tests/scripts/host_apply_drain.test.ts",
  "tests/scripts/host_apply_converge.test.ts",
  "tests/scripts/host_apply_restore.test.ts",
  "tests/scripts/host_apply_marker.test.ts",
  "tests/scripts/host_apply_lock.test.ts",
  "tests/scripts/host_apply_heartbeat.test.ts",
  "tests/scripts/host_apply_manifest.test.ts",
  "tests/scripts/host_apply_notify.test.ts",
  "tests/scripts/host_apply_approved_store.test.ts",
  "tests/scripts/host_apply_approve.test.ts",
  "tests/scripts/host_apply_approved_io.test.ts",
  "tests/scripts/host_apply_code_origin.test.ts",
  "tests/scripts/host_apply_approve_cli.test.ts",
  "tests/scripts/host_apply_secure_file.test.ts",
  "tests/scripts/host_apply_drain_store.test.ts",
  "tests/scripts/host_apply_state_io.test.ts",
  "tests/scripts/host_apply_command.test.ts",
  "tests/scripts/host_apply_git_grammar.test.ts",
  "tests/scripts/host_apply_spawn_runner.test.ts",
  "tests/scripts/host_apply_run_git.test.ts",
  "tests/scripts/host_apply_run_fetch.test.ts",
  "tests/scripts/host_apply_host_probe.test.ts",
  "tests/scripts/host_apply_compose_tables.test.ts",
];

/**
 * pr_fixが保護するファイル名(ディレクトリを問わない)。
 * markdownlint-cli2とtextlintの設定も含める。どちらも設定から任意のモジュールを読み込めて、
 * pre-commitと`mise run check`が読むので、書き換えられるとコードを実行されるため。
 * ホストの実行役が動かすmise、bun、nodeの設定も含める(`.tool-versions`、`.node-version`、`.bun-version`、
 * `.env`系)。ツールの版と環境変数を変えると、実行役が動かす道具の中身が変わる。
 * implementの一覧は、この一覧を引き継ぐ。
 */
export const FORBIDDEN_BASENAME_PATTERNS: readonly RegExp[] = [
  /^mise\.toml$/,
  /^mise\..*\.toml$/,
  /^\.mise\.toml$/,
  /^lefthook\.yml$/,
  /^lefthook-local\.yml$/,
  /^lefthook\.toml$/,
  /^lefthook\.json$/,
  /^bunfig\.toml$/,
  /^\.npmrc$/,
  /^\.gitattributes$/,
  /^\.gitmodules$/,
  /^\.markdownlint(-cli2)?\.(jsonc?|ya?ml|[cm]?js)$/,
  /^\.textlintrc(\..*)?$/,
  /^\.tool-versions$/,
  /^\.env(\..*)?$/,
  /^\.(node|bun)-version$/,
];

/**
 * implementフローが保護するディレクトリで、pr_fixの一覧に次を加えたもの。
 * - pr_fixの一覧の`.github/workflows/`を、`.github/`全体(actions、dependabot、CODEOWNERS)に広げる。
 * - `infra/**`: workerのイメージとcomposeの定義。変更は次にホスト側で
 *   `mise run up`するまで反映されないため、レビューする人が知る必要がある。
 * - gitフックのディレクトリ(`.husky/`、`.githooks/`)
 * - `.yarn/`: パッケージマネージャーが実行するプラグインとリリース
 * - `.devcontainer/`
 *
 * implementフローはClaudeの変更に対して検査コマンドを実行するため、
 * 検査コマンドが何を実行するかを決めるディレクトリを保護する。pr_fixの一覧は変えない。
 */
export const IMPLEMENT_PROTECTED_PATH_PREFIXES: readonly string[] = [
  ...FORBIDDEN_PATH_PREFIXES.filter(
    (prefix) => prefix !== ".github/actions/",
  ).map((prefix) => (prefix === ".github/workflows/" ? ".github/" : prefix)),
  "infra/",
  ".husky/",
  ".githooks/",
  ".yarn/",
  ".devcontainer/",
];

/** implementフローが保護する個別のファイル。pr_fixの一覧と同じ。 */
export const IMPLEMENT_PROTECTED_EXACT_PATHS: readonly string[] = [
  ...FORBIDDEN_EXACT_PATHS,
];

/**
 * implementフローが保護するファイル名。
 * pr_fixのリスト(envファイルと`.tool-versions`などのバージョン指定を含む)に、
 * 検査コマンドが何を実行し何を信頼するかを決めるファイルをすべて加える
 * (gitleaksの設定、ほかのランタイム・ツールチェーンのバージョン指定、
 * パッケージマネージャーの設定とロックファイル、ツールの設定モジュールとrcファイル、
 * タスクランナー、`scripts`に限らず`package.json`全体)。
 */
export const IMPLEMENT_PROTECTED_BASENAME_PATTERNS: readonly RegExp[] = [
  ...FORBIDDEN_BASENAME_PATTERNS,
  /^\.gitleaks(ignore|\.toml)$/,
  /^\.python-version$/,
  /^\.nvmrc$/,
  /^rust-toolchain(\.toml)?$/,
  /^\.yarnrc(\.yml)?$/,
  /^\.pnpmfile\.cjs$/,
  /^(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /^[\w.-]+\.config\.[cm]?[jt]s$/,
  /^\.(eslintrc|babelrc|prettierrc)(\..*)?$/,
  /^(Makefile|[Jj]ustfile|Taskfile\.ya?ml|turbo\.json|nx\.json|deno\.jsonc?|CODEOWNERS|\.pre-commit-config\.yaml)$/,
  /^package\.json$/,
  // JS以外のロックファイルとマニフェスト。インストール時に、記載された
  // ビルドスクリプトや`setup.py`が実行され、固定したものが取得される。
  /^(uv|poetry)\.lock$/,
  /^Pipfile(\.lock)?$/,
  /^pyproject\.toml$/,
  /^setup\.(py|cfg)$/,
  /^requirements.*\.txt$/,
  /^Cargo\.(lock|toml)$/,
  /^go\.(sum|mod)$/,
  /^Gemfile(\.lock)?$/,
  /^composer\.(lock|json)$/,
];

// 無視される文字(ゼロ幅文字、異体字セレクタなど)。見た目では区別できない別名を、安全側に倒して潰す。
const IGNORABLE_CHARACTERS = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * パスを、大文字小文字とUnicodeの別名を区別しない形にそろえる。
 * ホストのファイルシステム(macOSのAPFSの既定)は、大文字小文字を区別せず、
 * 長いsやケルビン記号のような、大文字小文字の畳み込みで同じになる文字も同じ名前に潰す。
 * 全角文字や無視される文字の除去は、APFSが潰すとは限らないが、紛らわしい別名を安全側で止めるために行う。
 * 小文字、大文字、小文字の順に変換するのは、大文字のエスツェット(ẞ)のような、
 * 1回の往復では`ss`に畳まれない文字も畳み込んで、結果を冪等にするためである。
 * 最後にNFKCを掛け直して、変換で生じた分解形をそろえる。
 */
export function foldPath(path: string): string {
  return path
    .replace(IGNORABLE_CHARACTERS, "")
    .normalize("NFKC")
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKC");
}

const foldedListCache = new WeakMap<readonly string[], readonly string[]>();

function foldedList(list: readonly string[]): readonly string[] {
  const cached = foldedListCache.get(list);
  if (cached !== undefined) return cached;
  const folded = list.map(foldPath);
  foldedListCache.set(list, folded);
  return folded;
}

const insensitivePatternCache = new WeakMap<RegExp, RegExp>();

// 畳み込んだ名前に当てるので、大文字を含む正規表現も大文字小文字を区別しない形にする。
function insensitivePattern(pattern: RegExp): RegExp {
  const cached = insensitivePatternCache.get(pattern);
  if (cached !== undefined) return cached;
  const flags = pattern.flags.includes("i")
    ? pattern.flags
    : `${pattern.flags}i`;
  const insensitive = new RegExp(pattern.source, flags);
  insensitivePatternCache.set(pattern, insensitive);
  return insensitive;
}

function matchesPathLists(
  path: string,
  prefixes: readonly string[],
  exactPaths: readonly string[],
  basenamePatterns: readonly RegExp[],
): boolean {
  const normalized = foldPath(path).replace(/^\.\//, "");
  if (foldedList(exactPaths).includes(normalized)) return true;
  for (const prefix of foldedList(prefixes)) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
      return true;
    }
  }
  // 正規化は`/`を作ったり文字を合成したりして、ファイル名の切り出しを変えうる。
  // 畳み込み後のパスから切ったもの、元のパスから切ったもの、それを畳み込んだものの
  // どれかが当たれば一致とし、畳み込む前の判定より狭くならないようにする。
  const rawBasename = path.split("/").pop() ?? path;
  const candidates = [
    normalized.split("/").pop() ?? normalized,
    foldPath(rawBasename),
    rawBasename,
  ];
  return basenamePatterns.some((pattern) => {
    const insensitive = insensitivePattern(pattern);
    return candidates.some((candidate) => insensitive.test(candidate));
  });
}

/**
 * `path`がdocs/security.md「PR修正の安全策」の禁止パスに当たるかを返す。
 * 照合は、大文字小文字とUnicodeの別名を区別しない(`foldPath`)。
 * `prefixes`のディレクトリは、リポジトリのルートからの相対パスの前方一致で判定する
 * (ディレクトリ名そのものも一致とみなす)。
 * `FORBIDDEN_EXACT_PATHS`とは完全一致で、`FORBIDDEN_BASENAME_PATTERNS`は
 * ディレクトリを問わずファイル名で判定する。
 * `prefixes`の既定はpr_fixのリスト。
 */
export function matchesForbiddenPath(
  path: string,
  prefixes: readonly string[] = FORBIDDEN_PATH_PREFIXES,
): boolean {
  return matchesPathLists(
    path,
    prefixes,
    FORBIDDEN_EXACT_PATHS,
    FORBIDDEN_BASENAME_PATTERNS,
  );
}

/**
 * `path`がimplementフローの保護パスに当たるかを返す。
 * 判定の規則は`matchesForbiddenPath`と同じで、リストに
 * `IMPLEMENT_PROTECTED_PATH_PREFIXES`と`IMPLEMENT_PROTECTED_BASENAME_PATTERNS`を使う。
 * `IMPLEMENT_PROTECTED_EXACT_PATHS`とは完全一致で判定する。
 */
export function matchesImplementProtectedPath(path: string): boolean {
  return matchesPathLists(
    path,
    IMPLEMENT_PROTECTED_PATH_PREFIXES,
    IMPLEMENT_PROTECTED_EXACT_PATHS,
    IMPLEMENT_PROTECTED_BASENAME_PATTERNS,
  );
}

export function isNewShellScript(entry: ChangedPath): boolean {
  return entry.status === "added" && /\.sh$/i.test(entry.path);
}
