// 読み込み中の骨組みが、実機で測った実物の寸法に合っていることを確かめる。
// 実物の高さは、応答を差し替えて実物を描き、`getBoundingClientRect`で測った値である(測り方は内部仕様の文書にある)。
// 骨組みと実物が同じ高さなら、内容と入れ替わる瞬間に、下の要素が動かない。
// 値はデータの量で変わるので、よくある件数の行を測り、行の高さを合わせている。

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type LoadingShape,
  LoadingStateView,
} from "../components/LoadingState.tsx";
import {
  DETAIL_PANEL_CLASS,
  OVERVIEW_BODY_CLASS,
  REQUIREMENTS_FRAME_CLASS,
  REQUIREMENTS_SCROLL_CLASS,
  SCROLL_BODY_CLASS,
} from "../lib/layoutClasses.ts";
import { ITEM_DETAIL_LOADING_SHAPE } from "./items/ItemDetailScreen.tsx";
import { REQUIREMENTS_DOC_LOADING_SHAPE } from "./items/ItemRequirementsScreen.tsx";
import { PIPELINE_LOADING_SHAPE } from "./items/PipelineSection.tsx";
import { REQUIREMENTS_LOADING_SHAPE } from "./items/RequirementsSection.tsx";
import { JOB_DETAIL_LOADING_SHAPE } from "./jobs/JobDetailScreen.tsx";
import {
  JOB_LIST_LOADING_SHAPE,
  SCHEDULE_LOADING_SHAPE,
} from "./jobs/JobRows.tsx";
import {
  ANALYTICS_APPROVALS_LOADING_SHAPE,
  ANALYTICS_COST_LOADING_SHAPE,
  ANALYTICS_LEAD_TIME_LOADING_SHAPE,
} from "./reports/AnalyticsSection.tsx";
import { AUDIT_REPORT_LOADING_SHAPE } from "./reports/AuditReportScreen.tsx";
import { AUDIT_LIST_LOADING_SHAPE } from "./reports/AuditReports.tsx";
import { SYSTEM_SKELETONS } from "./system/SystemSection.tsx";

function markup(shape: LoadingShape | undefined): string {
  return shape === undefined
    ? ""
    : renderToStaticMarkup(<LoadingStateView visible shape={shape} />);
}

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe("the pipeline skeleton", () => {
  const html = markup(PIPELINE_LOADING_SHAPE);

  test("draws the filter bar, tall on a narrow screen and one row on a wide one", () => {
    expect(html).toContain("h-[11.6rem] lg:h-[3.8rem]");
  });

  test("draws the count line under the filter bar", () => {
    expect(html).toContain("h-5 w-24");
  });

  test("swaps the cards for the table at the same container width as the screen", () => {
    expect(html).toContain("@4xl:hidden");
  });

  test("draws the table on a wide container", () => {
    expect(html).toContain("@4xl:block");
  });

  test("draws a table row as tall as a measured row of 54px", () => {
    expect(html).toContain("h-[3.375rem]");
  });

  test("draws the table header as tall as the measured 37px", () => {
    expect(html).toContain("h-[2.3rem]");
  });

  test("draws a card as tall as a measured card of 200px", () => {
    expect(html).toContain("h-[12.5rem]");
  });
});

describe("the requirements index skeleton", () => {
  const html = markup(REQUIREMENTS_LOADING_SHAPE);

  test("draws the filter row", () => {
    expect(html).toContain("h-9");
  });

  test("draws a row as tall as a measured row of 81px on a wide screen", () => {
    expect(html).toContain("sm:h-[5.05rem]");
  });

  test("draws a row as tall as a measured row of 106px on a narrow screen", () => {
    expect(html).toContain("h-[6.6rem]");
  });

  test("draws the rows in a bordered card", () => {
    expect(html).toContain("rounded-xl border");
  });
});

describe("the audit list skeleton", () => {
  test("draws a row as tall as a measured row of 99px", () => {
    expect(markup(AUDIT_LIST_LOADING_SHAPE)).toContain("h-[6.2rem]");
  });
});

describe("the analytics skeletons", () => {
  test("the cost section draws two charts of 222px", () => {
    expect(count(markup(ANALYTICS_COST_LOADING_SHAPE), "h-[13.86rem]")).toBe(2);
  });

  test("the cost section draws the table up to its 256px cap", () => {
    expect(markup(ANALYTICS_COST_LOADING_SHAPE)).toContain("h-64");
  });

  test("the approval section draws the figures of 92px", () => {
    expect(markup(ANALYTICS_APPROVALS_LOADING_SHAPE)).toContain("h-[5.74rem]");
  });

  test("the approval section draws the table of 297px", () => {
    expect(markup(ANALYTICS_APPROVALS_LOADING_SHAPE)).toContain("h-[18.6rem]");
  });

  test("the lead time section draws one chart of 222px", () => {
    expect(
      count(markup(ANALYTICS_LEAD_TIME_LOADING_SHAPE), "h-[13.86rem]"),
    ).toBe(1);
  });

  test("the lead time section draws the table of 68px", () => {
    expect(markup(ANALYTICS_LEAD_TIME_LOADING_SHAPE)).toContain("h-[4.2rem]");
  });

  test("the sections keep the 24px gap of the real content", () => {
    expect(markup(ANALYTICS_COST_LOADING_SHAPE)).toContain("gap-6");
  });
});

describe("the job list skeletons", () => {
  test("the job rows are as tall as a measured row of 74px", () => {
    expect(markup(JOB_LIST_LOADING_SHAPE)).toContain("h-[4.625rem]");
  });

  test("the job rows sit in a card as wide as the real list", () => {
    expect(markup(JOB_LIST_LOADING_SHAPE)).toContain("max-w-4xl");
  });

  test("the schedule rows are as tall as a measured row of 130px", () => {
    expect(markup(SCHEDULE_LOADING_SHAPE)).toContain("h-[8.1rem]");
  });

  test("the schedule rows sit in a card as wide as the real list", () => {
    expect(markup(SCHEDULE_LOADING_SHAPE)).toContain("max-w-4xl");
  });
});

describe("the job detail skeleton", () => {
  const html = markup(JOB_DETAIL_LOADING_SHAPE);

  test("uses the body frame of the real screen, which is not centered", () => {
    expect(html).toContain(SCROLL_BODY_CLASS);
  });

  test("draws the overview of 238px", () => {
    expect(html).toContain("h-[14.9rem]");
  });

  test("draws the steps of 91px", () => {
    expect(html).toContain("h-[5.7rem]");
  });

  test("draws the arguments of 100px", () => {
    expect(html).toContain("h-[6.3rem]");
  });

  test("keeps the section width of the real screen", () => {
    expect(html).toContain("max-w-4xl");
  });
});

describe("the audit report skeleton", () => {
  const html = markup(AUDIT_REPORT_LOADING_SHAPE);

  test("uses the body frame of the real screen", () => {
    expect(html).toContain(DETAIL_PANEL_CLASS);
  });

  test("draws the article as wide as the real one", () => {
    expect(html).toContain("max-w-3xl");
  });

  test("draws the article as tall as a measured report of 394px", () => {
    expect(html).toContain("h-[24.6rem]");
  });
});

describe("the work item detail skeleton", () => {
  const html = markup(ITEM_DETAIL_LOADING_SHAPE);

  test("draws the tab strip of 42px", () => {
    expect(html).toContain("h-[2.6rem]");
  });

  test("draws the overview card of 489px", () => {
    expect(html).toContain("h-[30.5rem]");
  });

  test("keeps the width of the real card", () => {
    expect(html).toContain("max-w-[47.5rem]");
  });

  test("uses the body frame of the real screen", () => {
    expect(html).toContain(DETAIL_PANEL_CLASS);
  });

  test("stacks the blocks the way the overview tab does", () => {
    expect(html).toContain(OVERVIEW_BODY_CLASS);
  });
});

describe("the requirements document skeleton", () => {
  const html = markup(REQUIREMENTS_DOC_LOADING_SHAPE);

  test("uses the frame of the real document", () => {
    expect(html).toContain(REQUIREMENTS_FRAME_CLASS);
  });

  test("uses the scroll frame of the real screen", () => {
    expect(html).toContain(REQUIREMENTS_SCROLL_CLASS);
  });

  test("draws the meta row of 63px", () => {
    expect(html).toContain("h-[3.9rem]");
  });

  test("draws the table of contents where the real one is", () => {
    expect(html).toContain("min-[1100px]:block");
  });
});

describe("the system skeletons", () => {
  test("the holds section draws the button to place a hold", () => {
    expect(markup(SYSTEM_SKELETONS["holds-heading"])).toContain("h-8 w-44");
  });

  test("the holds section draws the card of 63px under the button", () => {
    expect(markup(SYSTEM_SKELETONS["holds-heading"])).toContain("h-16");
  });

  test("the config section draws the filter of 53px", () => {
    expect(markup(SYSTEM_SKELETONS["config-heading"])).toContain("h-[3.3rem]");
  });

  test("the config section draws rows of 42px", () => {
    expect(markup(SYSTEM_SKELETONS["config-heading"])).toContain("h-[2.6rem]");
  });
});
