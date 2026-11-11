// 分析の3区画が、それぞれの区画の形の骨組みを持つことを確かめる。
// 区画ごとに塊の数と高さが違うので、区画の形を取り違えると、取得後に下の要素が動く。

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import {
  analyticsQueryKey,
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

/** 日別コストの行を取得済みにして描いた、費用の区画の文字列。 */
function costSectionWithRows(): string {
  const client = new QueryClient();
  client.setQueryData(analyticsQueryKey("agent_cost_daily", 7), [
    {
      day: "2026-10-07T15:00:00.000Z",
      stage: "requirements",
      model: "sonnet",
      run_count: 1,
      total_cost_usd: 1,
      total_input_tokens: null,
      total_output_tokens: null,
      total_cache_read_tokens: null,
      total_turns: null,
      avg_duration_ms: null,
    },
  ]);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return html.slice(0, html.indexOf('id="analytics-approval-heading"'));
}

describe("the headings of the daily cost charts", () => {
  const cost = costSectionWithRows();

  test("do not name a time zone", () => {
    expect(cost).not.toContain("UTC");
  });

  test("name the daily cost chart", () => {
    expect(cost).toContain("日別コスト(USD)");
  });

  test("name the daily run count chart", () => {
    expect(cost).toContain("日別実行件数");
  });

  test("name the day column of the table", () => {
    expect(cost).toMatch(/<th[^>]*>日<\/th>/);
  });

  test("show the day key of the table as it is", () => {
    expect(cost).toMatch(/<td[^>]*>2026-10-08<\/td>/);
  });
});

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
