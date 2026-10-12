// `poll_issues.ts`と`poll_prs.ts`の判定ロジックを、I/Oを持たない純粋関数としてまとめる。
// 各`main()`はこれらを呼び、その結果に従ってI/Oだけを行う。

import { isRepoAllowed } from "./config.ts";
import { ACTIONABLE_WORK_ITEM_STATUSES } from "./console_support.ts";
import { isViewerBumpBranch } from "./drawio_viewer_bump.ts";
import { type GhClient, GitHubHttpError, getLabelerLogin } from "./github.ts";
import { isFlowJobId } from "./implement_launch_support.ts";
import { type Logger, maskSecrets } from "./log.ts";
import {
  type FactoryConfig,
  type FactoryOwner,
  hasLabel,
  isBoolean,
  isNumber,
  isOneOf,
  isRecord,
  type LabelerAssociation,
  type LatestDeployment,
  type NoticeRecord,
  type WorkItem,
  type WorkItemStatus,
} from "./types.ts";

// ---------------------------------------------------------------------------
// リポジトリの許可リストによる絞り込み
// ---------------------------------------------------------------------------

/**
 * `items`のうち、`isRepoAllowed`(`lib/config.ts`)が許すリポジトリのものを返す。
 * `owner`が`config.owners`に無い候補は落とす。大文字と小文字は区別しない。
 * `config.repo_allowlist`が空でなければ、HTTPSのclone URL
 * (`https://github.com/<owner>/<repo>`)がそこに含まれる候補だけを残す。
 * `config.factory_repo`は、`owners`と`repo_allowlist`によらず常に通す。
 * 監査から起票したIssueなどFactory自身のリポジトリの候補を、`owners`や`repo_allowlist`に
 * 載っていなくても`poll_issues`と`poll_prs`の候補に残すため。
 * 呼び出し側は、照合を通ったオーナーだけを`config.owners`に渡す。
 * 検索を飛ばしたオーナーや、`owners`から消えた旧名の追跡中のPRを、候補から外すため。
 */
export function filterByRepoAllowlist<
  T extends { readonly owner: string; readonly repo: string },
>(
  items: readonly T[],
  config: Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">,
): T[] {
  return items.filter((item) => isRepoAllowed(config, item.owner, item.repo));
}

// ---------------------------------------------------------------------------
// オーナーの数値IDの照合
// ---------------------------------------------------------------------------

/** オーナーの数値IDが食い違ったことを知らせるnoticeの種類。 */
export const OWNER_ID_MISMATCH_KIND = "owner_id_mismatch";

/**
 * 数値IDが食い違ったオーナーのnoticeの本文。
 * オーナーと2つのIDだけで決まるので、同じ食い違いが続くあいだは
 * 同じ本文の未解決のnoticeが重ならない。
 */
export function ownerIdMismatchMessage(
  name: string,
  expectedId: number,
  actualId: number,
): string {
  return `${name}: GitHubの現在のIDが${String(actualId)}で、設定のID${String(expectedId)}と食い違うため、このオーナーの検索を飛ばしました。オーナーが改名して別の人がその名前を取得した可能性があります。factory_configのownersを見直してください`;
}

/**
 * 名前のアカウントが見つからないオーナーのnoticeの本文。
 * 改名か削除でほぼ恒久なので、人が`owners`を見直すまで同じ状況が続く。
 */
export function ownerNotFoundMessage(name: string, expectedId: number): string {
  return `${name}: GitHubにこの名前のアカウントが見つかりません(設定のID${String(expectedId)})。オーナーが改名または削除された可能性があるため、このオーナーの検索を飛ばしました。factory_configのownersの名前とidを見直してください`;
}

export type OwnerIdGateDeps = {
  readonly getAccountId: (name: string) => Promise<number>;
  readonly recordFailure: (step: string, err: unknown) => Promise<void>;
  readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
};

/**
 * `id`を持つオーナーだけ、GitHubの現在のIDと照合し、検索してよいかを返す。
 * `id`の無いオーナーは名前だけで動かすので、取得せずに`true`を返す。
 * 食い違いと取得の失敗は、検索を飛ばす(`false`)うえで、失敗として記録する。
 * noticeは、食い違いと、名前のアカウントが無い(404)ときに残す。
 * どちらも改名か削除でほぼ恒久で、人が`owners`を見直す操作がある。
 * 5xxやレート制限は一時的な障害でありうるので、失敗の記録だけにする。
 * noticeの記録が失敗してもポーリング全体を止めない。
 */
export async function gateOwnerId(
  owner: { readonly name: string; readonly id?: number },
  deps: OwnerIdGateDeps,
): Promise<boolean> {
  const expectedId = owner.id;
  if (expectedId === undefined) {
    return true;
  }
  const step = `verify_owner_id:${owner.name}`;
  let actualId: number;
  try {
    actualId = await deps.getAccountId(owner.name);
  } catch (err) {
    if (err instanceof GitHubHttpError && err.status === 404) {
      await recordOwnerNotice(
        step,
        ownerNotFoundMessage(owner.name, expectedId),
        deps,
      );
    } else {
      await deps.recordFailure(step, err);
    }
    return false;
  }
  if (actualId === expectedId) {
    return true;
  }
  await recordOwnerNotice(
    step,
    ownerIdMismatchMessage(owner.name, expectedId, actualId),
    deps,
  );
  return false;
}

async function recordOwnerNotice(
  step: string,
  message: string,
  deps: OwnerIdGateDeps,
): Promise<void> {
  await deps.recordFailure(step, new Error(message));
  try {
    await deps.addNotice({ kind: OWNER_ID_MISMATCH_KIND, message });
  } catch (err) {
    await deps.recordFailure(`${step}:notice`, err);
  }
}

/**
 * `owners`のうち、照合を通ったオーナーだけを返す。
 * 飛ばしたオーナーの数を`failed`に数え、呼び出し側のジョブの失敗件数に足させる。
 */
export async function filterVerifiedOwners(
  owners: readonly FactoryOwner[],
  deps: OwnerIdGateDeps,
): Promise<{
  readonly owners: FactoryOwner[];
  readonly failed: number;
}> {
  const verified: FactoryOwner[] = [];
  let failed = 0;
  for (const owner of owners) {
    if (await gateOwnerId(owner, deps)) {
      verified.push(owner);
    } else {
      failed += 1;
    }
  }
  return { owners: verified, failed };
}

// ---------------------------------------------------------------------------
// デプロイ版の不一致
// ---------------------------------------------------------------------------

/**
 * 食い違いを見てから、反映の停止とみなして知らせるまでの猶予(ミリ秒)。
 * mergeの直後から`self_update`が反映するまでの間は、必ず食い違う。
 * 30分は、通常の反映の見込みに、余裕を持たせた値である。
 * 見込みは、`self_update`の周期の2分、
 * 反映の外部コマンド(`wmill sync push`と`wmill datatable migrate up`)2回の10分(1回の上限が5分)、
 * `poll_issues`の周期の5分を足した17分である。
 * `poll_issues`の5分は、食い違いを最初に見た時刻から数えるための、保守側の見積もりである。
 * 17分は実測の上限ではない。1回の実行は最悪で約47分(ジョブの上限は2800秒)かかる。
 * ロックの待ち(最大5分)、ネットワークを使うgit、defaultの枠の待ちが加わるためである。
 * このため、正常な反映でも30分を超えうる。
 * 超えたときは通知が出るが、反映の成功で自動で解決される。
 */
export const DEPLOYED_SHA_GRACE_MS = 30 * 60 * 1000;

/** Windmillのstateのうち、この判定が使うキー。ほかのキーは触らない。 */
export const DEPLOYED_SHA_STATE_KEY = "deployed_sha_check";

/**
 * 反映済みの版(`deployed_sha`)が今の値になってから、食い違いを最初に見た時刻(epochミリ秒)。
 * 数え直すのは`deployed_sha`が変わったとき(反映が進んだとき)だけで、
 * self cloneのHEADが変わっても引き継ぐ。
 * 反映が止まったままmergeが続いても、猶予を超えれば知らせるためである。
 */
export type DeployedShaState = {
  readonly deployed_sha: string;
  readonly first_seen_ms: number;
};

/**
 * 保存済みのstate全体から、この判定のキーの値を読む。信頼できない入力として扱い、
 * 形が合わなければ`null`を返す(最初に見た時刻を失うだけで、次の実行が作り直す)。
 */
export function parseDeployedShaState(value: unknown): DeployedShaState | null {
  if (!isRecord(value)) {
    return null;
  }
  const entry = value[DEPLOYED_SHA_STATE_KEY];
  if (!isRecord(entry)) {
    return null;
  }
  const { deployed_sha, first_seen_ms } = entry;
  if (
    typeof deployed_sha !== "string" ||
    !isNumber(first_seen_ms) ||
    !Number.isFinite(first_seen_ms)
  ) {
    return null;
  }
  return { deployed_sha, first_seen_ms };
}

export type DeployedShaDecision =
  /** 一致した。stateのこのキーを消し、未解決のnoticeを解決する。 */
  | { readonly action: "resolve" }
  /** 食い違いを新しく見た、または反映が進んだ。stateを書くだけで、知らせない。 */
  | { readonly action: "record"; readonly next_state: DeployedShaState }
  /** 猶予の内にある。何もしない。 */
  | { readonly action: "wait" }
  /** 猶予を超えて食い違っている。noticeを出す。 */
  | { readonly action: "notify" };

/**
 * self cloneのHEAD(`selfSha`)とデプロイ済みの版(`deployedSha`)から、取る行動を決める。
 * `deployedSha`は空でないこと(空のときは呼び出し側が判定しない)。
 * 食い違いは、最初に見た時刻から猶予(`graceMs`)を超えたときだけ知らせる。
 * 数え直すのは、前回の`deployed_sha`と違うとき、前回が無いときと、
 * 最初に見た時刻が現在より後のとき(時計が戻ったとき、または壊れたstate)である。
 * 最後の場合は、経過時間が負になって通知を止め続けるのを防ぐ。
 */
export function decideDeployedSha(input: {
  readonly selfSha: string;
  readonly deployedSha: string;
  readonly prev: DeployedShaState | null;
  readonly nowMs: number;
  readonly graceMs: number;
}): DeployedShaDecision {
  const { selfSha, deployedSha, prev, nowMs, graceMs } = input;
  if (deployedSha === selfSha) {
    return { action: "resolve" };
  }
  if (
    prev === null ||
    prev.deployed_sha !== deployedSha ||
    prev.first_seen_ms > nowMs
  ) {
    return {
      action: "record",
      next_state: { deployed_sha: deployedSha, first_seen_ms: nowMs },
    };
  }
  return nowMs - prev.first_seen_ms > graceMs
    ? { action: "notify" }
    : { action: "wait" };
}

/**
 * 反映が止まっているときのnoticeの本文。
 * 反映済みの版(`deployedSha`)を中心にし、今のself cloneのHEADは含めない。
 * 重複して登録しない判定(`addNoticeUnlessUnresolved`)は本文の一致で行う。
 * HEADを含めると、反映が止まっている間にmergeが続くたびに別のnoticeが増える。
 * 時刻のような実行ごとに変わる値も入れない。
 * 今のHEADは、ログ(`deployed_sha_mismatch notice recorded`と`deployed_sha_mismatch notice already open`)と、self cloneのgitで分かる。
 * `hint`は、反映が止まっている原因の候補で、あれば末尾に添える。
 */
export function deployedShaMismatchMessage(
  deployedSha: string,
  hint: string | null = null,
): string {
  const base = `f/factory/deployed_sha(${deployedSha})から、self cloneのHEADへの反映が進んでいません`;
  return hint === null ? base : `${base}。${hint}`;
}

/**
 * 直近の反映の記録から、反映が止まっている原因の候補を言葉にする。
 * 断定せず候補だけを示す。続けて失敗しているスケジュールの通知
 * (`schedule_failing`)と役割が重ならないようにするため。
 * 反映の失敗の候補にするのは、その記録が今のself cloneのHEAD(`selfSha`)への反映で、
 * 失敗しているときだけである。古い版への失敗は、今のHEADを試した結果ではない。
 * 記録を読めなかったとき(`null`)は、候補を添えない。
 */
export function deployedShaHint(
  latest: LatestDeployment | null,
  selfSha: string,
): string | null {
  if (latest === null) {
    return null;
  }
  return latest.result === "failed" && latest.sha_to === selfSha
    ? "原因の候補: self_updateの反映が、今のself cloneのHEADで失敗しています"
    : "原因の候補: self_updateのスケジュールが止まっているか、今のself cloneのHEADをまだ試していません";
}

export type DeployedShaCheckDeps = {
  /** 変数`f/factory/deployed_sha`の値。変数がまだ無いときは`null`。 */
  readonly deployedSha: string | null;
  readonly selfSha: string;
  readonly getState: () => Promise<unknown>;
  /** Windmillのstateを書く。stateの全体を置き換えるので、ほかのキーを保った全体を渡す。 */
  readonly setState: (state: Record<string, unknown>) => Promise<void>;
  readonly getLatestDeployment: () => Promise<LatestDeployment | null>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  /**
   * `deployedSha`への反映の成功の記録(`factory.deployments`)のうち最も新しい時刻より前に作られた、
   * 未解決の`deployed_sha_mismatch`を解決済みにし、解決した件数を返す。
   * 時刻はどちらもDBの`now()`で決まる。成功の記録が無ければ何も解決しない。
   */
  readonly resolveNotices: (deployedSha: string) => Promise<number>;
  readonly nowMs: () => number;
  readonly log: Logger;
};

export type DeployedShaCheckOutcome =
  | "skipped"
  | "resolved"
  | "recorded"
  | "waiting"
  | "notified";

function errorText(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/** `stored`からこの判定のキーだけを除いたオブジェクトを返す。 */
function withoutDeployedShaState(
  stored: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(stored).filter(([key]) => key !== DEPLOYED_SHA_STATE_KEY),
  );
}

/**
 * 今の`deployedSha`への反映の成功の記録より前に作られた、未解決の`deployed_sha_mismatch`を解決する。
 * 失敗は警告のログだけにする。
 */
async function resolveNoticesBeforeDeployment(
  deps: DeployedShaCheckDeps,
  deployedSha: string,
): Promise<void> {
  try {
    const resolved = await deps.resolveNotices(deployedSha);
    if (resolved > 0) {
      deps.log.info("deployed_sha_mismatch notices resolved", {
        count: resolved,
      });
    }
  } catch (err) {
    deps.log.warn("deployed_sha_mismatch resolve failed", {
      error: errorText(err),
    });
  }
}

/**
 * 版の食い違いを判定し、stateとnoticeに反映する。
 * 変数が無い、または空のときは、まだ比べる対象が無いので、stateにもnoticeにも触れない。
 * 毎回、判定の結果によらず、先にnoticeの解決を行う。解決するのは、今の`deployed_sha`への
 * 反映の成功の記録より前に作られたnoticeだけである。
 * 値が書き換えられても、新しい成功の記録が無い限り、停止のnoticeは消えない。
 * 新しいnoticeは成功の記録より後に作られるので、解決の後に通知しても消されない。
 * stateを読めない、または書けないときは、猶予を数えられない。
 * その場合は、本当の反映の停止を見逃さないよう、猶予を待たずに知らせる
 * (同じ本文のnoticeは重複して登録されない)。
 * stateの失敗とnoticeの解決の失敗は警告のログだけにし、判定は続ける。
 */
export async function runDeployedShaCheck(
  deps: DeployedShaCheckDeps,
): Promise<DeployedShaCheckOutcome> {
  const { selfSha, deployedSha, log } = deps;
  if (deployedSha === null || deployedSha.length === 0) {
    return "skipped";
  }

  await resolveNoticesBeforeDeployment(deps, deployedSha);

  let stored: Record<string, unknown> = {};
  let stateUsable = true;
  try {
    const raw = await deps.getState();
    if (isRecord(raw)) {
      stored = raw;
    }
  } catch (err) {
    stateUsable = false;
    log.warn("deployed_sha state read failed", { error: errorText(err) });
  }
  const prev = parseDeployedShaState(stored);

  const decision = decideDeployedSha({
    selfSha,
    deployedSha,
    prev,
    nowMs: deps.nowMs(),
    graceMs: DEPLOYED_SHA_GRACE_MS,
  });

  if (decision.action === "resolve") {
    if (stateUsable && DEPLOYED_SHA_STATE_KEY in stored) {
      try {
        await deps.setState(withoutDeployedShaState(stored));
      } catch (err) {
        log.warn("deployed_sha state clear failed", { error: errorText(err) });
      }
    }
    return "resolved";
  }

  if (decision.action === "wait") {
    return "waiting";
  }

  if (decision.action === "record" && stateUsable) {
    try {
      await deps.setState({
        ...stored,
        [DEPLOYED_SHA_STATE_KEY]: decision.next_state,
      });
      return "recorded";
    } catch (err) {
      log.warn("deployed_sha state write failed", { error: errorText(err) });
    }
  }

  let latest: LatestDeployment | null = null;
  try {
    latest = await deps.getLatestDeployment();
  } catch (err) {
    log.warn("latest deployment lookup failed", { error: errorText(err) });
  }
  const noticeId = await deps.addNotice({
    kind: "deployed_sha_mismatch",
    message: deployedShaMismatchMessage(
      deployedSha,
      deployedShaHint(latest, selfSha),
    ),
  });
  // 本文は今のHEADを含まないので、ログに残す。
  if (noticeId === null) {
    log.info("deployed_sha_mismatch notice already open", {
      self_sha: selfSha,
      deployed_sha: deployedSha,
    });
  } else {
    log.warn("deployed_sha_mismatch notice recorded", {
      notice_id: noticeId,
      self_sha: selfSha,
      deployed_sha: deployedSha,
    });
  }
  return "notified";
}

// ---------------------------------------------------------------------------
// トリガーラベルの付与者の確認
// ---------------------------------------------------------------------------

/**
 * トリガーラベルを付けてよい人の決まり。
 * `viewerLogin`はFactoryのPATのアカウントで、取得できなかったときは`null`にする。
 * `allowedLogins`は`config.allowed_labeler_logins`である。
 */
export type LabelerPolicy = {
  readonly viewerLogin: string | null;
  readonly allowedLogins: readonly string[];
};

/**
 * `viewerLogin`と設定の`allowed_labeler_logins`から、付与者の決まりを作る。
 * `poll_issues`と`poll_prs`が同じ決まりを使うための組み立てである。
 */
export function labelerPolicyFor(
  viewerLogin: string | null,
  config: Pick<FactoryConfig, "allowed_labeler_logins">,
): LabelerPolicy {
  return { viewerLogin, allowedLogins: config.allowed_labeler_logins };
}

/**
 * トリガーラベルを付けたのが許可された人かを返す。
 * PRの作成者が許可されたアカウントかの判定にも使う。
 * 許可するのは、`viewerLogin`のアカウントと、`allowedLogins`に含まれるログイン名である。
 * 大文字小文字は区別しない。
 * 付与者を特定できないとき(`actorLogin`が`null`)と、`viewerLogin`が`null`のときは、
 * 判定できないものとして拒否する。
 * ラベルを付けられる人はGitHub上で書き込み権限を持つ人に限られず、公開リポジトリでは
 * 起票者が自分のIssueにラベルを付けられることもあるため、付与者の確認が要る。
 */
export function isAllowedLabeler(
  actorLogin: string | null,
  policy: LabelerPolicy,
): boolean {
  if (actorLogin === null || policy.viewerLogin === null) return false;
  const actor = actorLogin.toLowerCase();
  if (actor === policy.viewerLogin.toLowerCase()) return true;
  return policy.allowedLogins.some((login) => login.toLowerCase() === actor);
}

/**
 * 取得の直前に、`label`の付与者が許可された人かを取り直して確かめる。
 * 判定の後にラベルが付け直されていることがあるためである。
 * 取得に失敗したとき、判定できないとき(`LabelerCheckLimitError`)は例外を投げる。
 * 呼び出し側は、取得に進まない。
 */
export async function confirmLabeler(
  client: GhClient,
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  },
  label: string,
  policy: LabelerPolicy,
): Promise<boolean> {
  const login = await getLabelerLogin(
    client,
    target.owner,
    target.repo,
    target.number,
    label,
  );
  return isAllowedLabeler(login, policy);
}

/**
 * ラベルの付与者が許可されていないときに、noticeへ残す本文を返す。
 * 対象とラベルだけで決まり、時刻や付与者を含めない。
 * ラベルが残る間はポーリングのたびに同じ状況になるので、
 * 同じ本文の未解決のnoticeを重ねて登録しないためである。
 */
export function labelerDeniedMessage(
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  },
  label: string,
): string {
  return `${target.owner}/${target.repo}#${String(target.number)}: ${label}ラベルを付けたのは許可されていないユーザーです`;
}

/** ラベルの付与者が許可されていないときのnoticeの`kind`。IssueとPRで共通する。 */
export const LABELER_DENIED_KIND = "labeler_denied";

/**
 * レビューを始めるはずのPRのheadが、baseと同じリポジトリにないときのnoticeの`kind`。
 * ラベルを外さないので、ポーリングのたびに同じ状況になる。
 */
export const FORK_HEAD_DENIED_KIND = "fork_head_denied";

/**
 * `fork_head_denied`のnoticeの本文。対象だけで決まり、時刻やheadのshaを含めない。
 * 同じ状況が続く間、同じ本文の未解決のnoticeを重ねて登録しないためである。
 */
export function forkHeadDeniedMessage(target: {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}): string {
  return `${target.owner}/${target.repo}#${String(target.number)}: headのリポジトリが対象のリポジトリと異なるため、レビューを始めません`;
}

/** ラベルの付与者を判定できないときのnoticeの`kind`。 */
export const LABELER_CHECK_LIMIT_KIND = "labeler_check_limit";

/**
 * 付与者を判定できないときに、noticeへ残す本文を返す。
 * 対象とラベルだけで決まり、時刻などの揺れる値を含まない。
 * 超えた対象はポーリングのたびに同じ状況になるので、
 * 同じ本文の未解決のnoticeを重ねて登録しないためである。
 */
export function labelerCheckLimitMessage(
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  },
  label: string,
): string {
  return `${target.owner}/${target.repo}#${String(target.number)}: ${label}ラベルの付与者を判定できないため、着手できません。ラベルを外し、許可された人が付け直してください`;
}

/**
 * 付与者を判定できないことを、noticeに残す。
 * `addNoticeUnlessUnresolved`は、同じ本文の未解決のnoticeがあれば登録しない関数を渡す。
 */
export async function recordLabelerCheckLimit(
  addNoticeUnlessUnresolved: (record: {
    readonly kind: string;
    readonly message: string;
  }) => Promise<unknown>,
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  },
  label: string,
): Promise<void> {
  await addNoticeUnlessUnresolved({
    kind: LABELER_CHECK_LIMIT_KIND,
    message: labelerCheckLimitMessage(target, label),
  });
}

// ---------------------------------------------------------------------------
// Issueに着手するかの判定
// ---------------------------------------------------------------------------

export type IssueCandidate = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly htmlUrl: string;
  /**
   * トリガーラベルを付けた最後のイベントの付与者のログイン名。
   * そのイベントが無いとき、付与者を特定できないときは`null`で、着手しない。
   */
  readonly labelerLogin: string | null;
  /**
   * この(owner, repo, number)に、終了していない`work_items`の行がすでにあるか。
   * トリガーラベルは着手時に外すが、同じIssueに重ねて着手しないよう念のため確かめる。
   * 判断の根拠は`listActive`だけである(作業中ラベルで検索から除く仕組みは無い)。
   */
  readonly hasActiveWorkItem: boolean;
};

export type IssueDecision =
  | { readonly action: "claim"; readonly candidate: IssueCandidate }
  | { readonly action: "skip_labeler"; readonly candidate: IssueCandidate }
  | { readonly action: "skip_active"; readonly candidate: IssueCandidate };

export function decideIssueActions(
  candidates: readonly IssueCandidate[],
  policy: LabelerPolicy,
): IssueDecision[] {
  return candidates.map((candidate): IssueDecision => {
    if (candidate.hasActiveWorkItem) {
      return { action: "skip_active", candidate };
    }
    if (!isAllowedLabeler(candidate.labelerLogin, policy)) {
      return { action: "skip_labeler", candidate };
    }
    return { action: "claim", candidate };
  });
}

// ---------------------------------------------------------------------------
// PRのレビューと修正を始めるかの判定
// ---------------------------------------------------------------------------

export type PrCandidate = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly headSha: string;
  /**
   * PRに今付いているラベル。PRの番号はIssueのAPIのラベルのエンドポイントを共有するため、
   * `getIssue`で取得する。
   */
  readonly labels: readonly string[];
  /**
   * PRの作成者のログイン名。取得できなかったときは`null`。
   * ラベルを介さない検出(レビュー依頼やassigneeによるレビューと、追跡中のPRの
   * 新しいcommitによる再レビュー)は、作成者が許可されたアカウントのときに限る。
   * forkのPRや第三者のPRを、作成者の操作だけで始めさせないためである。
   */
  readonly authorLogin: string | null;
  /**
   * PRのheadが、baseと同じリポジトリにあるか。
   * forkのPRと、headのリポジトリを取得できないPRは`false`。
   * レビューは、`false`のPRでは始めない。forkの内容は第三者が書いたもので、
   * 許可されたアカウントがラベルを付けても、信頼してレビューに渡せないためである。
   */
  readonly headInBaseRepo: boolean;
  /**
   * PRのheadのブランチ名。
   * draw.ioのビューアの固定を上げるPR(`factory/drawio-viewer-`で始まる)には、修正を始めない。
   * 修正は固定のファイル以外も書き換えて、人が気づかずにマージするおそれがあるためである。
   */
  readonly headRef: string;
  /**
   * `review_label`を付けた最後のイベントの付与者のログイン名。
   * ラベルが付いていないとき、イベントが無いとき、付与者を特定できないときは`null`。
   * ラベルが付いているのに`null`なら、拒否する。
   */
  readonly reviewLabelerLogin: string | null;
  /** `fix_label`の付与者。意味は`reviewLabelerLogin`と同じ。 */
  readonly fixLabelerLogin: string | null;
  /** このPRに、終了していない`pr_review`の作業項目がすでにあるか。 */
  readonly hasActiveReviewingItem: boolean;
  /**
   * このPRの最新の`work_items`の行(種類と状態は問わない)の`head_sha`。
   * 作業項目が一度も無ければ`null`。
   * アサインやレビュー依頼から自動で検出する経路で、
   * 今の`head_sha`が未処理かを判断するのに使う。
   */
  readonly lastKnownHeadSha: string | null;
  /**
   * このPRの最新の`work_items`の行の`fix_round`。無ければ0。
   * 新しい`pr_fix`の行の`fix_round`は、これに1を足した値になる。
   */
  readonly previousFixRound: number;
  /**
   * 今回のポーリングでこのPRに見つかったレビューIDの最大値。
   * トリガーが発火したかによらず、ウォーターマークを進めるのに使う。
   */
  readonly maxReviewId: number;
};

export type PrReviewAction =
  | { readonly kind: "none" }
  | {
      readonly kind: "trigger_review";
      readonly reason: "label" | "assignment";
      readonly removeLabel: boolean;
    }
  /** `review_label`を付けたのが許可された人ではないので、始めない。 */
  | { readonly kind: "deny_labeler" }
  /** headがbaseと同じリポジトリにないので、始めない。 */
  | { readonly kind: "deny_fork_head" };

export type PrFixAction =
  | { readonly kind: "none" }
  | { readonly kind: "trigger_fix"; readonly removeLabel: boolean }
  /** `fix_label`を付けたのが許可された人ではないので、始めない。 */
  | { readonly kind: "deny_labeler" };

export type PrDecision = {
  readonly candidate: PrCandidate;
  readonly review: PrReviewAction;
  readonly fix: PrFixAction;
};

/**
 * 各PRについて、レビューと修正を始めるかを判定して返す。
 * ラベルによるレビューと修正は、ラベルを付けたのが許可された人のときに始める
 * (ラベルを外すことで冪等になる)。許可されない人が付けたラベルは拒否する。
 * ラベルを介さないレビューの検出は、未処理の`head_sha`があるときに始めるが、
 * 次のどちらかを満たさないときは始めない。
 * - PRの作成者が許可されたアカウントである。
 * - レビューと修正のどちらのトリガーラベルも、拒否された状態で付いていない。
 * 未処理の`head_sha`から自動で検出するレビューは、
 * このPRに実行中の`pr_review`があれば見送る。
 * ラベルの経路も検出の経路も、PRのheadがbaseと同じリポジトリにないとき
 * (forkのPRと、headのリポジトリを取得できないPR)は始めず、`deny_fork_head`を返す。
 * `pr_fix`に自動検出の経路は無く、`fix_label`からだけ始め、コメントからは始めない。
 * draw.ioのビューアの固定を上げるPRのブランチ(`isViewerBumpBranch`)には、`fix_label`が付いていても始めない。
 */
export function decidePrActions(
  candidates: readonly PrCandidate[],
  reviewLabel: string,
  fixLabel: string,
  policy: LabelerPolicy,
): PrDecision[] {
  return candidates.map((candidate): PrDecision => {
    const hasReviewLabel = hasLabel(candidate.labels, reviewLabel);
    const hasFixLabel = hasLabel(candidate.labels, fixLabel);
    const reviewLabelAllowed =
      hasReviewLabel && isAllowedLabeler(candidate.reviewLabelerLogin, policy);
    const fixLabelAllowed =
      hasFixLabel && isAllowedLabeler(candidate.fixLabelerLogin, policy);
    const mayDetect =
      isAllowedLabeler(candidate.authorLogin, policy) &&
      (!hasReviewLabel || reviewLabelAllowed) &&
      (!hasFixLabel || fixLabelAllowed);

    const wouldReview: PrReviewAction = hasReviewLabel
      ? reviewLabelAllowed
        ? { kind: "trigger_review", reason: "label", removeLabel: true }
        : { kind: "deny_labeler" }
      : mayDetect &&
          !candidate.hasActiveReviewingItem &&
          candidate.lastKnownHeadSha !== candidate.headSha
        ? { kind: "trigger_review", reason: "assignment", removeLabel: false }
        : { kind: "none" };
    // 始めるはずだったレビューだけを止める。見送りの記録がポーリングのたびに
    // 増えないよう、始める条件を満たさないPRは`none`のままにする。
    const review: PrReviewAction =
      wouldReview.kind === "trigger_review" && !candidate.headInBaseRepo
        ? { kind: "deny_fork_head" }
        : wouldReview;

    // 人だけが直すブランチのPRでは、修正を始めない。ラベルは消費せずに残す。
    // 判定はブランチ名だけで行うので、`factory_repo`に限らず、担当するすべてのリポジトリのPRに効く。
    // `pr_fix_prepare`の`evaluateHumanOnlyBranchGuard`も同じ述語を使う。
    const fix: PrFixAction = hasFixLabel
      ? fixLabelAllowed
        ? isViewerBumpBranch(candidate.headRef)
          ? { kind: "none" }
          : { kind: "trigger_fix", removeLabel: true }
        : { kind: "deny_labeler" }
      : { kind: "none" };

    return { candidate, review, fix };
  });
}

// ---------------------------------------------------------------------------
// 作業項目の状態を実態に合わせる(reconcile)判定
// ---------------------------------------------------------------------------

export type ReconcileGithubState =
  | {
      readonly kind: "issue";
      readonly open: boolean;
    }
  | { readonly kind: "pr"; readonly open: boolean }
  /**
   * 監査の作業項目にはGitHubのオブジェクトが無く、ジョブの状態と孤立の検査だけを行う。
   */
  | { readonly kind: "audit" };

export type JobState =
  | { readonly state: "running" }
  /**
   * `success`と`canceled`は推測ではなく、ジョブの行(`CompletedJob`)そのものの値。
   * 取り消されたか失敗したジョブは自分で終了状態を書くことが無いため、
   * `decideReconcileAction`は猶予を待たない。
   * 成功したジョブは、フローの最後のステップがまもなく追いつくはずなので猶予を待つ。
   */
  | {
      readonly state: "completed";
      readonly success: boolean;
      readonly canceled: boolean;
    }
  /**
   * `flow_job_id`が記録されていないか、ジョブの取得が404だった。
   * 孤立の猶予については成功と同じに扱い、猶予を待つ(すぐに`fail_orphan`にしない)。
   * 「見つからない」は、「見つかって、取り消しか失敗だった」ほど確かな根拠ではないため。
   */
  | { readonly state: "absent" }
  /** 404以外の理由でジョブを取得できなかった。一時的な失敗で動いているジョブを止めないよう、何もしない。 */
  | { readonly state: "unknown" };

/**
 * 取得できた`JobService.getJob`の応答を`JobState`に読み替える。
 * `CompletedJob`は`success` / `canceled`をそのまま使い、真偽値でなければ成功・未取り消しとみなして猶予を守る経路に倒す。
 * `QueuedJob`や未知の`type`の記録は`running`とみなし、完了を確かめられないジョブを止めない。記録でない応答は`unknown`。
 * `getResultMaybe`は実行中のジョブにも`completed`を返したことがあるので、ジョブの行を直接読む`getJob`の応答を前提にする。
 */
export function jobStateFromJob(job: unknown): JobState {
  if (!isRecord(job)) return { state: "unknown" };
  if (job.type === "CompletedJob") {
    return {
      state: "completed",
      success: isBoolean(job.success) ? job.success : true,
      canceled: isBoolean(job.canceled) ? job.canceled : false,
    };
  }
  return { state: "running" };
}

/**
 * `JobService.getJob`の例外を`JobState`に読み替える。
 * windmill-clientの`ApiError`の`status`が404なら`absent`(古い完了ジョブはWindmillが消す)、
 * それ以外(他のHTTPエラー、ネットワークエラー)は`unknown`。
 */
export function jobStateFromFetchError(err: unknown): JobState {
  if (isRecord(err) && err.status === 404) return { state: "absent" };
  return { state: "unknown" };
}

/** ジョブの取得の失敗を`unknown`と読み替えたときに`readJobState`が知らせる内容。 */
export type JobFetchFailure = {
  /** 例外の`status`(HTTPのステータス)。無ければ`null`。 */
  readonly status: number | null;
  /** 秘密をマスクした例外のメッセージ。 */
  readonly error: string;
};

/**
 * `flowJobId`のジョブの状態を返す。未記録か、ジョブIDの形でない(起動の応答本文がそのまま記録された)なら
 * `getJob`を呼ばずに`absent`。
 * ジョブIDでない値を取得すると404以外のエラーになり`unknown`が続くので、作業項目がreconcileされず
 * 再開も拒否されたまま残る。それを避けるため、記録が無いときと同じに扱う。
 * 取得は`getJob`(`JobService.getJob`を包んだもの)で行い、例外は`jobStateFromFetchError`で
 * 読み替えるので、この関数は例外を投げない。
 * 例外を`unknown`と読み替えたときは、`onUnknown`にステータスとマスクしたメッセージを渡す。
 * `unknown`は何もしない・再開を拒否する判断になるので、続くときに原因をログで追えるようにするため。
 */
export async function readJobState(
  getJob: (id: string) => Promise<unknown>,
  flowJobId: string | null,
  onUnknown: (failure: JobFetchFailure) => void = () => {},
): Promise<JobState> {
  if (flowJobId === null || !isFlowJobId(flowJobId)) return { state: "absent" };
  try {
    return jobStateFromJob(await getJob(flowJobId));
  } catch (err) {
    const state = jobStateFromFetchError(err);
    if (state.state === "unknown") {
      onUnknown({
        status: isRecord(err) && isNumber(err.status) ? err.status : null,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
    return state;
  }
}

export type ReconcileDecision =
  | { readonly action: "none" }
  | {
      readonly action: "cancel";
      readonly reason: "closed" | "pr_closed";
    }
  | { readonly action: "fail_orphan"; readonly reason: string };

const DEFAULT_ORPHAN_GRACE_MS = 10 * 60_000;

/**
 * 作業項目1件について、状態を実態に合わせるための判定を返す。
 * IssueまたはPRが閉じていれば取り消す。ジョブが実行中なら何もしない。
 * 取り消されたか失敗したと確かめられたジョブは、孤立の猶予を待たずに`fail_orphan`にする。
 * 自分で終了状態を書くことは無く、待つ意味が無いため。
 * 猶予を待つと、手動で取り消したフローの作業項目が猶予いっぱい
 * (呼び出し側の`poll_issues.ts`では10分と`claude_timeout_sec`の2倍の大きい方で、
 * 既定の設定なら1時間)途中の状態のまま残る。
 * 成功したときと、ジョブが見つからないとき(`absent`)は猶予を待つ。
 * ジョブの状態を読めない(`unknown`)ときは、close検知を除き何もしない。
 * テストできるよう、`now`と`orphanGraceMs`は`Date.now()`から読まず引数で受け取る。
 */
export function decideReconcileAction(
  item: Pick<WorkItem, "updated_at">,
  github: ReconcileGithubState,
  job: JobState,
  now: Date,
  orphanGraceMs: number = DEFAULT_ORPHAN_GRACE_MS,
): ReconcileDecision {
  if (github.kind === "issue" && !github.open) {
    return { action: "cancel", reason: "closed" };
  }
  if (github.kind === "pr" && !github.open) {
    return { action: "cancel", reason: "pr_closed" };
  }

  if (job.state === "running" || job.state === "unknown") {
    return { action: "none" };
  }

  if (job.state === "completed" && (job.canceled || !job.success)) {
    return {
      action: "fail_orphan",
      reason: job.canceled
        ? "flow job was canceled without a terminal status update"
        : "flow job failed without a terminal status update",
    };
  }

  const elapsedMs = now.getTime() - item.updated_at.getTime();
  if (elapsedMs < orphanGraceMs) {
    return { action: "none" };
  }
  return {
    action: "fail_orphan",
    reason: "flow job finished or absent without a terminal status update",
  };
}

/**
 * フローが正常に終わり、作業項目が人の判断(Consoleの要対応の承認)を待っている状態。
 * 実行中のジョブが無いので、孤立の猶予による検査を当ててはいけない。
 */
const HUMAN_WAIT_STATUSES: readonly WorkItemStatus[] = ["awaiting_approval"];

export function isWaitingForHuman(status: WorkItemStatus): boolean {
  return HUMAN_WAIT_STATUSES.includes(status);
}

/**
 * 人の判断を待っている作業項目の判定を返す。
 * IssueまたはPRが閉じているときだけ取り消し、ジョブの状態は見ない。
 */
export function decideClosureOnly(
  github: ReconcileGithubState,
): ReconcileDecision {
  if (github.kind === "audit") {
    return { action: "none" };
  }
  if (github.kind === "issue") {
    return github.open
      ? { action: "none" }
      : { action: "cancel", reason: "closed" };
  }
  return github.open
    ? { action: "none" }
    : { action: "cancel", reason: "pr_closed" };
}

// ---------------------------------------------------------------------------
// 要対応の終端の作業項目の照合
// ---------------------------------------------------------------------------

/** GitHubの1つのIssueまたはPRと、それに紐づく要対応の作業項目。 */
export type ActionableTarget<T> = {
  /** `<owner>/<repo>#<番号>`。IssueとPRは同じ番号の空間にある。 */
  readonly key: string;
  /** 束ねた作業項目のIDのうち最小のもの。回す順番とカーソルの基準になる。 */
  readonly id: number;
  readonly owner: string;
  readonly repo: string;
  /** IssueまたはPRの番号。 */
  readonly number: number;
  readonly items: readonly [T, ...T[]];
};

/**
 * 要対応の作業項目を、GitHubのIssueまたはPRごとに束ねて、`id`の昇順で返す。
 * 同じPRのレビューと修正の行は、1回の問い合わせで足りるので1つにする。
 * GitHubのオブジェクトが無い`audit`と、番号の無い行は含めない。
 */
export function groupActionableTargets<
  T extends Pick<
    WorkItem,
    "id" | "kind" | "owner" | "repo" | "issue_number" | "pr_number"
  >,
>(items: readonly T[]): ActionableTarget<T>[] {
  const byKey = new Map<
    string,
    {
      id: number;
      owner: string;
      repo: string;
      number: number;
      items: [T, ...T[]];
    }
  >();
  for (const item of items) {
    if (item.kind === "audit") continue;
    const number = item.kind === "issue" ? item.issue_number : item.pr_number;
    if (number === null) continue;
    const key = `${item.owner}/${item.repo}#${String(number)}`;
    const group = byKey.get(key);
    if (group === undefined) {
      byKey.set(key, {
        id: item.id,
        owner: item.owner,
        repo: item.repo,
        number,
        items: [item],
      });
    } else {
      group.id = Math.min(group.id, item.id);
      group.items.push(item);
    }
  }
  return [...byKey.entries()]
    .map(([key, group]) => ({ key, ...group }))
    .sort((a, b) => a.id - b.id);
}

/**
 * `targets`(`id`の昇順)を、`cursor`の次を先頭にした順に並べ直す。
 * 末尾の後は先頭に戻る。前回の実行が最後に調べた対象の`id`を`cursor`に渡せば、
 * 打ち切られた対象から続きを調べられる。`cursor`が`null`なら並べ直さない。
 */
export function rotateTargets<T extends { readonly id: number }>(
  targets: readonly T[],
  cursor: number | null,
): T[] {
  if (cursor === null) return [...targets];
  const after = targets.filter((target) => target.id > cursor);
  const before = targets.filter((target) => target.id <= cursor);
  return [...after, ...before];
}

/**
 * Windmillのstateに保存した、要対応の照合のカーソルを読む。
 * 形が違うもの(初回の`null`を含む)は、先頭からやり直すので`null`を返す。
 */
export function parseActionableCursor(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const cursor = value.cursor;
  return isNumber(cursor) && Number.isInteger(cursor) && cursor >= 0
    ? cursor
    : null;
}

/** 閉じた対象について、閉じた人の確認に使うIssue(PR)の応答の部分。 */
export type ClosedTargetInfo = {
  /** PRがマージされた時刻。マージされていないとき、PRでないときは`null`。 */
  readonly mergedAt: string | null;
  /** 閉じた人のログイン名。GitHubが返さなければ`null`。 */
  readonly closedByLogin: string | null;
  /** 閉じた人の種別(`User`、`Bot`など)。分からなければ`null`。 */
  readonly closedByType: string | null;
  /** 作者のログイン名。分からなければ`null`か空文字列。 */
  readonly authorLogin: string | null;
  /** 作者の`author_association`。分からなければ`null`。 */
  readonly authorAssociation: string | null;
};

export type CloserDecision =
  | {
      readonly allowed: true;
      readonly basis: "merged" | "other_than_author" | "author";
    }
  | {
      readonly allowed: false;
      readonly reason:
        | "no_closer"
        | "bot_closer"
        | "author_unknown"
        | "author_not_allowed";
    };

function isBotCloser(info: ClosedTargetInfo): boolean {
  return (
    info.closedByType === "Bot" ||
    (info.closedByLogin?.toLowerCase().endsWith("[bot]") ?? false)
  );
}

/**
 * 対象を閉じた人が、要対応の取り消しを許せる人かを、Issue(PR)の1回の応答から次の順に判定する。
 * 1. PRがマージされていれば許す。マージにもmerge queueへの投入にも、write権限が要るため。
 * 2. 閉じた人が分からなければ許さない。
 * 3. Botが閉じたなら許さない。BotやActionsは、第三者のイベントを受けて閉じることがあるため。
 * 4. 作者が分からなければ許さない。
 * 5. 作者以外の人が閉じたなら許す。他人のIssueやPRを閉じるには、triage以上の権限が要るため。
 * 6. 作者が閉じたなら、作者の`author_association`が許可する関係に含まれるときだけ許す。
 * ログイン名は大文字と小文字を区別せずに比べる。
 * 第三者が自分のIssueやPRを閉じて、安全策で止まった作業項目を要対応の一覧から消せないようにするため。
 */
export function decideCloser(
  info: ClosedTargetInfo,
  allowed: readonly LabelerAssociation[],
): CloserDecision {
  if (info.mergedAt !== null) return { allowed: true, basis: "merged" };
  if (info.closedByLogin === null) {
    return { allowed: false, reason: "no_closer" };
  }
  if (isBotCloser(info)) return { allowed: false, reason: "bot_closer" };
  if (info.authorLogin === null || info.authorLogin === "") {
    return { allowed: false, reason: "author_unknown" };
  }
  if (info.closedByLogin.toLowerCase() !== info.authorLogin.toLowerCase()) {
    return { allowed: true, basis: "other_than_author" };
  }
  return info.authorAssociation !== null &&
    isOneOf(info.authorAssociation, allowed)
    ? { allowed: true, basis: "author" }
    : { allowed: false, reason: "author_not_allowed" };
}

/**
 * 要対応の終端の作業項目を取り消すときの状態の注記。
 * `retry_work_item`が、この照合で取り消した作業項目だけを再開できるよう、注記で見分ける。
 */
export function actionableCancelNote(reason: "closed" | "pr_closed"): string {
  return `reconcile: ${reason} (actionable)`;
}

const ACTIONABLE_CANCEL_NOTES: readonly string[] = [
  actionableCancelNote("closed"),
  actionableCancelNote("pr_closed"),
];

/**
 * `cancelled`への最新の遷移の記録から、取り消す前の状態を返す。
 * 要対応の照合(`actionableCancelNote`の注記)が、要対応の状態から取り消した遷移でなければ`null`を返す。
 * ほかの理由の取り消し(Issueが閉じられた直後のreconcile、新しいサイクルによる置き換えなど)は、再開の対象にしない。
 */
export function statusBeforeActionableCancel(
  event: {
    readonly from_status: WorkItemStatus | null;
    readonly note: string | null;
  } | null,
): WorkItemStatus | null {
  if (event === null || event.from_status === null || event.note === null) {
    return null;
  }
  if (!ACTIONABLE_CANCEL_NOTES.includes(event.note)) return null;
  return isOneOf(event.from_status, ACTIONABLE_WORK_ITEM_STATUSES)
    ? event.from_status
    : null;
}
