import React, { useEffect, useState } from "react";
import "./index.css";
import { AnalyticsTab } from "./tabs/AnalyticsTab";
import { FailuresTab } from "./tabs/FailuresTab";
import { InboxTab } from "./tabs/InboxTab";
import { NoticesTab } from "./tabs/NoticesTab";
import { PipelineTab } from "./tabs/PipelineTab";

const TABS = [
  { id: "inbox", label: "承認" },
  { id: "pipeline", label: "パイプライン" },
  { id: "analytics", label: "分析" },
  { id: "failures", label: "失敗" },
  { id: "notices", label: "通知" },
] as const;

type TabId = (typeof TABS)[number]["id"];
type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "factory-console.theme";

// index.tsx applies the initial theme to <html> synchronously before the
// first paint (to avoid a flash of the wrong theme). This reads that same
// attribute back as the source of truth; "light" is only a defensive
// fallback for the unlikely case the attribute is missing.
function getInitialTheme(): Theme {
  const current = document.documentElement.getAttribute("data-theme");
  return current === "dark" ? "dark" : "light";
}

const App = (): React.ReactElement => {
  const [activeTab, setActiveTab] = useState<TabId>("inbox");
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // localStorage が使えない環境でも表示上のテーマ切替自体は継続する。
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
        {activeTab === "inbox" && <InboxTab key={`inbox-${refreshKey}`} />}
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
