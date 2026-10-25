import { useLayoutEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router";
import {
  usePipeline,
  useRequirementsIndex,
  useSummary,
} from "../../api/queries.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import {
  refreshStatusOf,
  refreshStatusOfAll,
} from "../../app/refreshStatus.ts";
import { Tabs } from "../../components/Tabs.tsx";
import { Button } from "../../components/ui/button.tsx";
import { actionableTotal } from "../../lib/inboxView.ts";
import {
  ITEMS_ID_PREFIX,
  type ItemsTabId,
  itemsPanelAttrs,
  itemsTabSpecs,
  parseItemsTab,
  withItemsTab,
} from "../../lib/itemsTabs.ts";
import { SCROLL_BODY_CLASS } from "../../lib/layoutClasses.ts";
import {
  type PipelineScope,
  parsePipelineScope,
  withPipelineScope,
} from "../../lib/pipelineView.ts";
import { recalledScroll, rememberScroll } from "../../lib/tabs.ts";
import { PipelineSection } from "./PipelineSection.tsx";
import { RequirementsSection } from "./RequirementsSection.tsx";

/**
 * 2つのタブの本体が共有するスクロール枠で、タブごとのスクロール位置を覚えて戻す。
 * 枠は1つなので、何もしないと、片方で下までスクロールした位置がもう片方に残る。
 * 位置はスクロールのたびに今のタブへ記録し、タブが変わった直後(描画の前)に、移った先の位置へ戻す。
 */
function useTabScroll(tab: ItemsTabId) {
  const frameRef = useRef<HTMLDivElement>(null);
  const memory = useRef<ReadonlyMap<ItemsTabId, number>>(new Map());
  const current = useRef(tab);

  useLayoutEffect(() => {
    current.current = tab;
    const frame = frameRef.current;
    if (frame !== null) {
      frame.scrollTop = recalledScroll(memory.current, tab);
    }
  }, [tab]);

  return {
    frameRef,
    /** スクロールのたびに、今のタブの位置を覚える。 */
    onScroll: () => {
      const frame = frameRef.current;
      if (frame !== null) {
        memory.current = rememberScroll(
          memory.current,
          current.current,
          frame.scrollTop,
        );
      }
    },
  };
}

/**
 * 作業項目の画面。進捗と要件定義の2つのタブを持つ。
 * 開くタブはURLの`?tab=`に、進捗の範囲は`?scope=`に持ち、選び直しても履歴を積まない。
 * 戻る操作で戻ったときに、タブと範囲が保たれる。
 * 選んでいないタブの本体も描いたまま隠し、絞り込み、並び、ページ、検索の入力を保つ。
 * 2つの取得は画面が持ち、見出しの更新ボタンが両方を取り直す。タブの切り替えでは取得しない。
 * 隠れたタブの取得が失敗したときは、タブの名前に失敗の印を付ける。
 * 節は取得の結果を表示するだけで、失敗したときの「もう一度取得する」だけを自分の節に限って持つ。
 */
export function ItemsScreen() {
  const pipeline = usePipeline();
  const requirements = useRequirementsIndex();
  const summary = useSummary();
  const refresh = refreshStatusOfAll([pipeline, requirements]);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseItemsTab(searchParams.get("tab"));
  const scope = parsePipelineScope(searchParams.get("scope"));
  const scroll = useTabScroll(tab);

  // 401は上部のバナーが知らせるので、失敗の印には数えない。
  const failed = {
    progress: refreshStatusOf(pipeline).isError,
    requirements: refreshStatusOf(requirements).isError,
  };
  const tabs = itemsTabSpecs(tab, failed, requirements.data?.length);
  const progressPanel = itemsPanelAttrs("progress", tab);
  const requirementsPanel = itemsPanelAttrs("requirements", tab);

  const selectTab = (id: ItemsTabId): void => {
    setSearchParams((current) => withItemsTab(current, id), { replace: true });
  };
  const selectScope = (next: PipelineScope): void => {
    setSearchParams((current) => withPipelineScope(current, next), {
      replace: true,
    });
  };

  return (
    <>
      <PageHeader
        title="作業項目"
        refresh={refresh}
        actions={
          <Button asChild>
            <Link to="/items/new">新規投入</Link>
          </Button>
        }
      />
      <Tabs
        tabs={tabs}
        selected={tab}
        onSelect={selectTab}
        label="作業項目"
        idPrefix={ITEMS_ID_PREFIX}
      />
      <div
        ref={scroll.frameRef}
        onScroll={scroll.onScroll}
        className={SCROLL_BODY_CLASS}
      >
        <div
          id={progressPanel.id}
          role="tabpanel"
          aria-labelledby={progressPanel.labelledBy}
          hidden={progressPanel.hidden}
        >
          <PipelineSection
            pipeline={pipeline}
            scope={scope}
            onScopeChange={selectScope}
            actionableCount={
              summary.data === undefined ? null : actionableTotal(summary.data)
            }
          />
        </div>
        <div
          id={requirementsPanel.id}
          role="tabpanel"
          aria-labelledby={requirementsPanel.labelledBy}
          hidden={requirementsPanel.hidden}
        >
          <RequirementsSection index={requirements} />
        </div>
      </div>
    </>
  );
}
