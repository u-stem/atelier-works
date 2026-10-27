// 分析の3区画が、それぞれの区画の形の骨組みを持つことを確かめる。
// 区画ごとに塊の数と高さが違うので、区画の形を取り違えると、取得後に下の要素が動く。

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import {
  useAgentCostDaily,
  useApprovalStats,
  useLeadTime,
} from "../../api/analyticsQueries.ts";
import { AnalyticsReports } from "./AnalyticsReports.tsx";

function Harness() {
  const cost = useAgentCostDaily(7);
  const approvals = useApprovalStats(7);
  const leadTime = useLeadTime(7);
  return (
    <AnalyticsReports
      days={7}
      onDaysChange={() => undefined}
      cost={cost}
      approvals={approvals}
      leadTime={leadTime}
    />
  );
}

/** 区画の見出しから次の区画の見出しまでの、骨組みの部分。 */
function sectionsOf(): { cost: string; approvals: string; leadTime: string } {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  const approvalAt = html.indexOf('id="analytics-approval-heading"');
  const leadAt = html.indexOf('id="analytics-lead-time-heading"');
  return {
    cost: html.slice(0, approvalAt),
    approvals: html.slice(approvalAt, leadAt),
    leadTime: html.slice(leadAt),
  };
}

describe("the skeletons of the analytics sections", () => {
  const sections = sectionsOf();

  test("the cost section keeps two charts and a table", () => {
    expect(sections.cost.split("h-[13.86rem]").length - 1).toBe(2);
  });

  test("the cost section keeps the table of 256px", () => {
    expect(sections.cost).toContain("h-64");
  });

  test("the approvals section keeps the totals and a table", () => {
    expect(sections.approvals).toContain("h-[5.74rem]");
  });

  test("the approvals section keeps no chart", () => {
    expect(sections.approvals).not.toContain("h-[13.86rem]");
  });

  test("the lead time section keeps one chart", () => {
    expect(sections.leadTime.split("h-[13.86rem]").length - 1).toBe(1);
  });

  test("the lead time section keeps the table of 67px", () => {
    expect(sections.leadTime).toContain("h-[4.2rem]");
  });
});
