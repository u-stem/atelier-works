import { useDeployments, useSummary } from "../../api/queries.ts";
import {
  SYSTEM_STATUS_LIMIT,
  useSystemStatus,
} from "../../api/systemQueries.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import {
  auditFailuresOf,
  listLimitNote,
  SYSTEM_WINDOW_DAYS,
} from "../../lib/systemView.ts";
import { AuditFailureList, OrphanFailureList } from "./FailureLists.tsx";
import { InfoNoticeList, ResolvedNoticeList } from "./NoticeLists.tsx";
import { ReleaseStatus } from "./ReleaseStatus.tsx";
import { SystemSection } from "./SystemSection.tsx";
import { UpdateHistory } from "./UpdateHistory.tsx";

function LimitNote({ count }: { count: number }) {
  const note = listLimitNote(count, SYSTEM_STATUS_LIMIT);
  return note === null ? null : (
    <p className="text-small text-muted-foreground">{note}</p>
  );
}

function ReleaseSection() {
  const status = useSystemStatus();
  return (
    <SystemSection
      id="release-heading"
      title="反映の状態"
      description="反映した版、直近の反映、Consoleの取り込みの状態です。"
      query={status}
      loginHint="上のバナーからログインすると、反映の状態を表示します。"
    >
      {(data, now) => <ReleaseStatus status={data} now={now} />}
    </SystemSection>
  );
}

function UpdateHistorySection() {
  const deployments = useDeployments();
  return (
    <SystemSection
      id="update-history-heading"
      title="更新履歴"
      description={
        <>
          Software Factoryが自分を更新した記録です。
          PRの作り手は、マージしたブランチの名前から判断しています。
        </>
      }
      query={deployments}
      loginHint="上のバナーからログインすると、更新履歴を表示します。"
    >
      {(data, now) => <UpdateHistory entries={data} now={now} />}
    </SystemSection>
  );
}

function InfoNoticeSection() {
  const status = useSystemStatus();
  return (
    <SystemSection
      id="info-notices-heading"
      title="情報の通知"
      description={
        <>
          人の行動が要らない通知です。要対応の一覧には出ません。 直近
          {SYSTEM_WINDOW_DAYS}日の未解決のものを表示します。
        </>
      }
      query={status}
      loginHint="上のバナーからログインすると、情報の通知を表示します。"
    >
      {(data, now) => (
        <>
          <InfoNoticeList notices={data.info_notices} now={now} />
          <LimitNote count={data.info_notices.length} />
        </>
      )}
    </SystemSection>
  );
}

function ResolvedNoticeSection() {
  const status = useSystemStatus();
  return (
    <SystemSection
      id="resolved-notices-heading"
      title="解決済みの通知"
      description="解決した通知の履歴です。人が解決したものを先に、DBの掃除が解決したものを後に、解決の新しい順で並べます。"
      query={status}
      loginHint="上のバナーからログインすると、解決済みの通知を表示します。"
    >
      {(data, now) => (
        <>
          <ResolvedNoticeList notices={data.resolved_notices} now={now} />
          <LimitNote count={data.resolved_notices.length} />
        </>
      )}
    </SystemSection>
  );
}

function AuditFailureSection() {
  const summary = useSummary();
  return (
    <SystemSection
      id="audit-failures-heading"
      title="監査の失敗"
      description="失敗した監査です。再実行できません。次の定期の監査が、失敗した期間を扱います。"
      query={summary}
      loginHint="上のバナーからログインすると、監査の失敗を表示します。"
    >
      {(data, now) => (
        <AuditFailureList failures={auditFailuresOf(data.failures)} now={now} />
      )}
    </SystemSection>
  );
}

function OrphanFailureSection() {
  const status = useSystemStatus();
  return (
    <SystemSection
      id="orphan-failures-heading"
      title="作業項目に紐づかない失敗"
      description={
        <>
          定期のジョブなど、作業項目を持たないジョブの失敗です。
          要対応の画面には出ません。 直近{SYSTEM_WINDOW_DAYS}
          日のものを新しい順に表示します。
        </>
      }
      query={status}
      loginHint="上のバナーからログインすると、作業項目に紐づかない失敗を表示します。"
    >
      {(data, now) => (
        <>
          <OrphanFailureList failures={data.orphan_failures} now={now} />
          <LimitNote count={data.orphan_failures.length} />
        </>
      )}
    </SystemSection>
  );
}

/**
 * システムの画面。Software Factoryの自分自身の状態を、節に分けて出す。
 * 節ごとに自分の取得と再読み込みを持つので、見出しには最終更新を出さない。
 * 読み取り専用で、操作は起こさない。通知の解決は、要対応の画面の詳細で行う。
 */
export function SystemScreen() {
  return (
    <>
      <PageHeader title="システム" />
      <div className="flex min-h-0 flex-1 flex-col gap-10 overflow-y-auto px-8 py-6">
        <ReleaseSection />
        <UpdateHistorySection />
        <InfoNoticeSection />
        <ResolvedNoticeSection />
        <AuditFailureSection />
        <OrphanFailureSection />
      </div>
    </>
  );
}
