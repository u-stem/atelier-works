import React, { useEffect, useState } from "react";
import "./index.css";
import {
  collectDeepLinkCandidates,
  initialTabFromDeepLink,
} from "./lib/deepLink";
import { AnalyticsTab } from "./tabs/AnalyticsTab";
import { AuditTab } from "./tabs/AuditTab";
import { FailuresTab } from "./tabs/FailuresTab";
import { InboxTab } from "./tabs/InboxTab";
import { NoticesTab } from "./tabs/NoticesTab";
import { PipelineTab } from "./tabs/PipelineTab";
import { RequirementsTab } from "./tabs/RequirementsTab";

const TABS = [
  { id: "inbox", label: "承認" },
  { id: "requirements", label: "要件定義" },
  { id: "audit", label: "監査" },
  { id: "pipeline", label: "パイプライン" },
  { id: "analytics", label: "分析" },
  { id: "failures", label: "失敗" },
  { id: "notices", label: "通知" },
] as const;

type TabId = (typeof TABS)[number]["id"];
type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "factory-console.theme";

/**
 * `<html>`の`data-theme`から初期テーマを返す。
 * `index.tsx`が最初の描画の前に同期的にテーマを適用している(違うテーマが
 * 一瞬見えるのを防ぐため)ので、その属性を正とする。属性が無いという
 * まれな場合に備え、`"light"`を返す。
 */
function getInitialTheme(): Theme {
  const current = document.documentElement.getAttribute("data-theme");
  return current === "dark" ? "dark" : "light";
}

const App = (): React.ReactElement => {
  // ディープリンク(`#requirements/<id>`・`#audit/<id>`)付きで開かれたときは、
  // 承認タブを経由せず該当のタブから始める。作業項目の選択は各タブが
  // マウント時に自分でフラグメントを読んで行うので、`auditTarget`は使わない。
  const [activeTab, setActiveTab] = useState<TabId>(
    () => initialTabFromDeepLink(collectDeepLinkCandidates()) ?? "inbox",
  );
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  const [refreshKey, setRefreshKey] = useState(0);
  // 承認タブの「レポートを開く」ボタン(監査由来のissue_proposal)から
  // 監査タブへ渡す`work_item_id`(`AuditTab.tsx`の`initialWorkItemId`を参照)。
  const [auditTarget, setAuditTarget] = useState<number | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // `localStorage`が使えない環境でも、表示上のテーマの切り替えは続ける。
    }
  }, [theme]);

  function toggleTheme(): void {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  function handleRefresh(): void {
    setRefreshKey((key) => key + 1);
  }

  return (
    <div className="factory-console">
      <header className="factory-console-header">
        <h1>Factory Console</h1>
        <div className="factory-console-header-actions">
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            onClick={toggleTheme}
            aria-label={
              theme === "dark"
                ? "ライトモードに切り替え"
                : "ダークモードに切り替え"
            }
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleRefresh}
            aria-label="表示中のタブを更新"
          >
            更新
          </button>
        </div>
      </header>
      <div
        className="factory-console-nav"
        role="tablist"
        aria-label="Factory Console のタブ"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTab}
            className={tab.id === activeTab ? "active" : ""}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <main className="factory-console-main">
        {activeTab === "inbox" && (
          <InboxTab
            key={`inbox-${refreshKey}`}
            onOpenAudit={(id) => {
              setAuditTarget(id);
              setActiveTab("audit");
            }}
          />
        )}
        {activeTab === "requirements" && (
          <RequirementsTab key={`requirements-${refreshKey}`} />
        )}
        {activeTab === "audit" && (
          <AuditTab
            key={`audit-${refreshKey}`}
            initialWorkItemId={auditTarget}
            onInitialWorkItemConsumed={() => setAuditTarget(null)}
          />
        )}
        {activeTab === "pipeline" && (
          <PipelineTab key={`pipeline-${refreshKey}`} />
        )}
        {activeTab === "analytics" && (
          <AnalyticsTab key={`analytics-${refreshKey}`} />
        )}
        {activeTab === "failures" && (
          <FailuresTab key={`failures-${refreshKey}`} />
        )}
        {activeTab === "notices" && (
          <NoticesTab key={`notices-${refreshKey}`} />
        )}
      </main>
    </div>
  );
};

export default App;
