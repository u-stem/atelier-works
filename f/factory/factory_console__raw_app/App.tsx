import React, { useState } from "react";
import "./index.css";
import { AnalyticsTab } from "./tabs/AnalyticsTab";
import { FailuresTab } from "./tabs/FailuresTab";
import { InboxTab } from "./tabs/InboxTab";
import { NoticesTab } from "./tabs/NoticesTab";
import { PipelineTab } from "./tabs/PipelineTab";

const TABS = [
  { id: "inbox", label: "承認 Inbox" },
  { id: "pipeline", label: "パイプライン" },
  { id: "analytics", label: "分析" },
  { id: "failures", label: "失敗" },
  { id: "notices", label: "通知" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const App = (): React.ReactElement => {
  const [activeTab, setActiveTab] = useState<TabId>("inbox");

  return (
    <div className="factory-console">
      <header className="factory-console-header">
        <h1>Factory Console</h1>
      </header>
      <nav className="factory-console-nav">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={tab.id === activeTab ? "active" : ""}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <main className="factory-console-main">
        {activeTab === "inbox" && <InboxTab />}
        {activeTab === "pipeline" && <PipelineTab />}
        {activeTab === "analytics" && <AnalyticsTab />}
        {activeTab === "failures" && <FailuresTab />}
        {activeTab === "notices" && <NoticesTab />}
      </main>
    </div>
  );
};

export default App;
