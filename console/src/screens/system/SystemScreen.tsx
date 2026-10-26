import { type ReactNode, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useHolds } from "../../api/holdsQueries.ts";
import { useDeployments, useSummary } from "../../api/queries.ts";
import {
  SYSTEM_STATUS_LIMIT,
  useSystemStatus,
} from "../../api/systemQueries.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { refreshStatusOf } from "../../app/refreshStatus.ts";
import { useNow } from "../../app/useNow.ts";
import { TabPanel } from "../../components/TabPanel.tsx";
import { Tabs } from "../../components/Tabs.tsx";
import { FLOW_GRAPH } from "../../lib/flowGraphData.ts";
import { SCROLL_BODY_CLASS } from "../../lib/layoutClasses.ts";
import { jumpToSection } from "../../lib/sectionJump.ts";
import { summaryBandRows } from "../../lib/summaryBand.ts";
import {
  parseSystemTab,
  SYSTEM_TABS,
  type SystemTabId,
  systemPanelAttrs,
  systemTabSpecs,
  withSystemTab,
} from "../../lib/systemTabs.ts";
import {
  auditFailureLimitNote,
  auditFailuresOf,
  listLimitNote,
  SYSTEM_WINDOW_DAYS,
} from "../../lib/systemView.ts";
import { useTabScroll } from "../../lib/useTabScroll.ts";
import { useVisitedTabs } from "../../lib/useVisitedTabs.ts";
import { AuditFailureList, OrphanFailureGroups } from "./FailureLists.tsx";
import { FlowGraphSection } from "./FlowGraphSection.tsx";
import { HoldsSection } from "./HoldsSection.tsx";
import { InfoNoticeList, ResolvedNoticeDisclosure } from "./NoticeLists.tsx";
import { ReleaseStatus } from "./ReleaseStatus.tsx";
import { SummaryBand } from "./SummaryBand.tsx";
import { SystemSection } from "./SystemSection.tsx";
import { refreshStatusOfSystem } from "./systemRefresh.ts";
import { UpdateHistory } from "./UpdateHistory.tsx";
import { WorkerLoadCard } from "./WorkerLoadCard.tsx";

function Note({ text }: { text: string | null }) {
  return text === null ? null : (
    <p className="text-small text-muted-foreground">{text}</p>
  );
}

function LimitNote({ count }: { count: number }) {
  return <Note text={listLimitNote(count, SYSTEM_STATUS_LIMIT)} />;
}

type StatusQuery = ReturnType<typeof useSystemStatus>;

function ReleaseSection({ status }: { status: StatusQuery }) {
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

function WorkerLoadSection({ status }: { status: StatusQuery }) {
  return (
    <SystemSection
      id="worker-load-heading"
      title="workerの負荷"
      description="defaultのworkerの枠の使用、queueの待ち、メモリの直近24時間です。2分ごとの記録の最大と、最新の値を出します。"
      query={status}
      loginHint="上のバナーからログインすると、workerの負荷を表示します。"
    >
      {(data) => <WorkerLoadCard load={data.worker_load} />}
    </SystemSection>
  );
}

function UpdateHistorySection({
  deployments,
}: {
  deployments: ReturnType<typeof useDeployments>;
}) {
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

function InfoNoticeSection({ status }: { status: StatusQuery }) {
  return (
    <SystemSection
      id="info-notices-heading"
      title="情報の通知"
      description={`人の行動が要らない通知です。要対応の一覧には出ません。直近${String(SYSTEM_WINDOW_DAYS)}日の未解決のものを表示します。`}
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

function ResolvedNoticeSection({ status }: { status: StatusQuery }) {
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
          <ResolvedNoticeDisclosure notices={data.resolved_notices} now={now} />
          <LimitNote count={data.resolved_notices.length} />
        </>
      )}
    </SystemSection>
  );
}

function AuditFailureSection({
  summary,
}: {
  summary: ReturnType<typeof useSummary>;
}) {
  return (
    <SystemSection
      id="audit-failures-heading"
      title="監査の失敗"
      description="失敗した監査です。再実行できません。次の監査が、失敗した期間を扱います。後の監査で報告済みのものには「後の監査で報告済み」を付けます。"
      query={summary}
      loginHint="上のバナーからログインすると、監査の失敗を表示します。"
    >
      {(data, now) => (
        <>
          <AuditFailureList
            failures={auditFailuresOf(data.failures)}
            now={now}
          />
          <Note
            text={auditFailureLimitNote({
              counts: data.counts.failures,
              listed: data.failures.length,
            })}
          />
        </>
      )}
    </SystemSection>
  );
}

function OrphanFailureSection({ status }: { status: StatusQuery }) {
  return (
    <SystemSection
      id="orphan-failures-heading"
      title="作業項目に紐づかない失敗"
      description={`定期のジョブなど、作業項目を持たないジョブの失敗です。要対応の画面には出ません。直近${String(SYSTEM_WINDOW_DAYS)}日のものを、flowごとにまとめて表示します。`}
      query={status}
      loginHint="上のバナーからログインすると、作業項目に紐づかない失敗を表示します。"
    >
      {(data, now) => (
        <>
          <OrphanFailureGroups failures={data.orphan_failures} now={now} />
          <LimitNote count={data.orphan_failures.length} />
        </>
      )}
    </SystemSection>
  );
}

/** タブの中の節を縦に並べる。 */
function Sections({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-10">{children}</div>;
}

/**
 * システムの画面。Software Factoryの自分自身の状態を、要約の帯と3つのタブに分けて出す。
 * 帯は枠の先頭に置き、タブを替えても見える。各行は結論、段、最終取得時刻を出し、押すと関係するタブの節へ移る。
 * タブは状態、失敗と通知、履歴と構成である。開くタブはURLの`?tab=`に持ち、選び直しても履歴を積まない。
 * 4つの取得は画面が持ち、帯とタブが読む。タブの切り替えでは取得しない。節を分けても取得の数は増えない。
 * 選んでいないタブは、初めて開くまで描かない。開いた後は隠して残し、スクロール位置を保つ。
 * 失敗が隠れないよう、帯に件数を出し、失敗と通知のタブに件数と印を付ける。
 * 見出しの更新ボタンが4つを取り直し、節は失敗したときの「もう一度取得する」だけを持つ。
 * 起動の関係の節だけは、取得を持たない静的なデータを図にする。
 * 書き込みは「保留と凍結」の節の解除だけで、ほかの節は読むだけである。通知の解決は、要対応の画面の詳細で行う。
 */
export function SystemScreen() {
  const status = useSystemStatus();
  const deployments = useDeployments();
  const summary = useSummary();
  const holds = useHolds();
  const refresh = refreshStatusOfSystem({
    status,
    deployments,
    summary,
    holds,
  });
  const now = useNow();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseSystemTab(searchParams.get("tab"));
  const visited = useVisitedTabs(tab);
  const tabsRef = useRef<HTMLDivElement>(null);
  const scroll = useTabScroll(tab, () => tabsRef.current?.offsetTop ?? 0);

  const rows = summaryBandRows(
    {
      holds: {
        data: holds.data,
        isError: holds.isError,
        updatedAt: holds.dataUpdatedAt,
      },
      status: {
        data: status.data,
        isError: status.isError,
        updatedAt: status.dataUpdatedAt,
      },
      summary: {
        data: summary.data,
        isError: summary.isError,
        updatedAt: summary.dataUpdatedAt,
      },
    },
    now,
  );
  // 401は上部のバナーが知らせるので、失敗の印には数えない。
  const failedOf = (...queries: Parameters<typeof refreshStatusOf>[0][]) =>
    queries.some((query) => refreshStatusOf(query).isError);
  const tabs = systemTabSpecs(tab, {
    rows,
    failed: {
      status: failedOf(status, holds),
      failures: failedOf(status, summary),
      history: failedOf(status, deployments),
    },
  });

  // 帯のリンクで移る節。タブを替えて描いた後に移るので、移り先のタブを持つ。
  const [jump, setJump] = useState<{ tab: SystemTabId; id: string } | null>(
    null,
  );
  useEffect(() => {
    if (jump !== null && jump.tab === tab) {
      jumpToSection(jump.id);
      setJump(null);
    }
  }, [jump, tab]);
  const onJump = (target: SystemTabId, id: string): void => {
    if (target !== tab) {
      setSearchParams((current) => withSystemTab(current, target), {
        replace: true,
      });
    }
    setJump({ tab: target, id });
  };

  const selectTab = (id: SystemTabId): void => {
    setSearchParams((current) => withSystemTab(current, id), {
      replace: true,
    });
  };

  return (
    <>
      <PageHeader title="システム" refresh={refresh} />
      <div
        ref={scroll.frameRef}
        onScroll={scroll.onScroll}
        className={SCROLL_BODY_CLASS}
      >
        <SummaryBand rows={rows} now={now} onJump={onJump} />
        <div ref={tabsRef} className="-mx-4 md:-mx-8">
          <Tabs
            tabs={tabs}
            selected={tab}
            onSelect={selectTab}
            label="システムの節"
            idPrefix={SYSTEM_TABS.idPrefix}
          />
        </div>
        <TabPanel
          attrs={systemPanelAttrs("status", tab)}
          mounted={visited.has("status")}
        >
          <Sections>
            <HoldsSection holds={holds} />
            <ReleaseSection status={status} />
            <WorkerLoadSection status={status} />
          </Sections>
        </TabPanel>
        <TabPanel
          attrs={systemPanelAttrs("failures", tab)}
          mounted={visited.has("failures")}
        >
          <Sections>
            <AuditFailureSection summary={summary} />
            <OrphanFailureSection status={status} />
            <InfoNoticeSection status={status} />
          </Sections>
        </TabPanel>
        <TabPanel
          attrs={systemPanelAttrs("history", tab)}
          mounted={visited.has("history")}
        >
          <Sections>
            <UpdateHistorySection deployments={deployments} />
            <ResolvedNoticeSection status={status} />
            <FlowGraphSection graph={FLOW_GRAPH} />
          </Sections>
        </TabPanel>
      </div>
    </>
  );
}
