import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router";
import { useDesignDoc } from "../../api/queries.ts";
import { loadPhaseOf } from "../../api/sectionQuery.ts";
import { PageHeader, subtitlePendingOf } from "../../app/PageHeader.tsx";
import { refreshStatusOf } from "../../app/refreshStatus.ts";
import { Breadcrumb } from "../../components/Breadcrumb.tsx";
import {
  LoadingBody,
  useLoadingDisplay,
} from "../../components/LoadingState.tsx";
import { MissingMessage } from "../../components/MissingMessage.tsx";
import { itemDesignCrumbs } from "../../lib/breadcrumbs.ts";
import {
  designName,
  parseDraftParam,
  prepareDesignDoc,
} from "../../lib/itemDetailView.ts";
import { workItemRef } from "../../lib/labels.ts";
import { REQUIREMENTS_SCROLL_CLASS } from "../../lib/layoutClasses.ts";
import { parseIdParam } from "../../lib/routeParams.ts";
import { SCROLL_ROOT_PROPS } from "../../lib/scrollRoot.ts";
import { DesignDocumentView } from "./DesignDocumentView.tsx";
import { REQUIREMENTS_DOC_LOADING_SHAPE } from "./ItemRequirementsScreen.tsx";
import { QueryFailure } from "./QueryFailure.tsx";

/** 設計書が無いときと、設計書の番号が正しくないときの文。 */
const NOT_FOUND = "この設計書は見つかりません。";

function ItemDesign({
  workItemId,
  draftId,
}: {
  workItemId: number;
  draftId: number | null;
}) {
  const query = useDesignDoc(workItemId, draftId);
  const loadingDisplay = useLoadingDisplay(loadPhaseOf(query));
  const refresh = refreshStatusOf(query);
  const doc = query.data;
  const prepared = useMemo(
    () => (doc === undefined || doc === null ? null : prepareDesignDoc(doc)),
    [doc],
  );
  const requested = `${workItemRef(workItemId)}の設計書`;

  // 値が揃った後も、スケルトンを残す時間の間は、読み込み中の表示を続ける。
  if (doc === undefined || loadingDisplay !== "content") {
    return (
      <>
        {/* 副題は取得後に出る。待つ間も副題の行を空け、取得後の見出しと同じ高さにして、下の本文が動かないようにする。 */}
        <PageHeader
          title={requested}
          subtitlePending={subtitlePendingOf(loadingDisplay)}
          refresh={refresh}
        >
          <Breadcrumb items={itemDesignCrumbs(workItemId)} />
        </PageHeader>
        {loadingDisplay !== "content" ? (
          <LoadingBody
            display={loadingDisplay}
            shape={REQUIREMENTS_DOC_LOADING_SHAPE}
          />
        ) : (
          <QueryFailure
            title="設計書を取得できませんでした"
            loginHint="上のバナーからログインすると、設計書を表示します。"
            error={query.error}
            onRetry={refresh.onRefresh}
          />
        )}
      </>
    );
  }
  if (doc === null || prepared === null) {
    return (
      <>
        <PageHeader title={requested} refresh={refresh}>
          <Breadcrumb items={itemDesignCrumbs(workItemId)} />
        </PageHeader>
        <MissingMessage>{NOT_FOUND}</MissingMessage>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={prepared.title}
        subtitle={`${workItemRef(doc.work_item_id)}・${designName(doc.requirement_attempt, doc.design_attempt)}`}
        refresh={refresh}
      >
        <Breadcrumb items={itemDesignCrumbs(workItemId)} />
      </PageHeader>
      <div {...SCROLL_ROOT_PROPS} className={REQUIREMENTS_SCROLL_CLASS}>
        <DesignDocumentView doc={doc} prepared={prepared} />
      </div>
    </>
  );
}

/**
 * 作業項目の設計書の画面。`?draft=<id>`で設計書の番号を指し、無ければ最新の設計書を出す。
 * 作業項目の番号か設計書の番号が正しくないときは、取得せずにその旨を出す。
 */
export function ItemDesignScreen() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const workItemId = parseIdParam(params.id);
  const draft = parseDraftParam(searchParams.get("draft"));
  if (workItemId === null) {
    return (
      <>
        <PageHeader title="設計書">
          <Breadcrumb items={itemDesignCrumbs(null)} />
        </PageHeader>
        <MissingMessage>作業項目の番号が正しくありません。</MissingMessage>
      </>
    );
  }
  if (draft.kind === "invalid") {
    return (
      <>
        <PageHeader title="設計書">
          <Breadcrumb items={itemDesignCrumbs(workItemId)} />
        </PageHeader>
        <MissingMessage>{NOT_FOUND}</MissingMessage>
      </>
    );
  }
  const draftId = draft.kind === "draft" ? draft.id : null;
  return (
    <ItemDesign
      key={`${workItemId}-${draftId ?? "latest"}`}
      workItemId={workItemId}
      draftId={draftId}
    />
  );
}
