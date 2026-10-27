import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { ApiFailure } from "../../api/errors.ts";
import {
  type JobDetailView,
  type JobSummaryView,
  jobDetailQueryKey,
} from "../../api/jobsQueries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { JobDetailScreen } from "./JobDetailScreen.tsx";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const OUTPUT_KEY = jobDetailQueryKey(ID, { includeOutput: true });
const STATUS_KEY = jobDetailQueryKey(ID, { includeOutput: false });

function summary(state: string): JobSummaryView {
  return {
    id: ID,
    state,
    script_path: "f/factory/implement",
    job_kind: "flow",
    created_at: "2026-10-26T05:00:00.000000Z",
    started_at: "2026-10-26T05:00:01.000000Z",
    completed_at: state === "running" ? null : "2026-10-26T05:00:03.000000Z",
    scheduled_for: null,
    duration_ms: state === "running" ? null : 2000,
    schedule_path: null,
    parent_job: null,
    tag: "",
    is_flow_step: false,
  };
}

type DetailOptions = {
  readonly steps?: readonly string[];
  readonly completedAt?: string;
  readonly scriptPath?: string;
};

function detail(state: string, options: DetailOptions = {}): JobDetailView {
  const base = summary(state);
  return {
    found: true,
    job: {
      ...base,
      completed_at: options.completedAt ?? base.completed_at,
      script_path: options.scriptPath ?? base.script_path,
    },
    args: [{ key: "work_item_id", type: "number", value: 7 }],
    steps: (options.steps ?? []).map((id) => ({
      id,
      state: "success",
      job_id: null,
      iterations: null,
      skipped: false,
    })),
    log: { text: "log line", truncated: false, masked: false, nonJsonLines: 0 },
    result: null,
    result_error: null,
    failures: { ok: true, items: [] },
  };
}

type Seed = {
  readonly output?: JobDetailView;
  readonly outputAt?: number;
  readonly status?: JobDetailView;
  readonly statusAt?: number;
  readonly statusFetching?: boolean;
  readonly statusError?: boolean;
};

function render(path: string, seed: Seed = {}): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (seed.output !== undefined) {
    client.setQueryData(OUTPUT_KEY, seed.output, {
      updatedAt: seed.outputAt ?? Date.now() - 4000,
    });
  }
  if (seed.status !== undefined) {
    client.setQueryData(STATUS_KEY, seed.status, {
      updatedAt: seed.statusAt ?? Date.now() - 1000,
    });
    const query = client.getQueryCache().find({ queryKey: STATUS_KEY });
    if (seed.statusError === true) {
      query?.setState({
        status: "error",
        error: new ApiFailure({ kind: "network" }),
        fetchFailureCount: 1,
        errorUpdateCount: 1,
        errorUpdatedAt: 3000,
      });
    }
    if (seed.statusFetching === true) {
      query?.setState({ fetchStatus: "fetching" });
    }
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/jobs/:id" element={<JobDetailScreen />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const NOT_FOUND =
  "ジョブが見つかりません。保持期間(30日)を過ぎたか、IDが違います。";

function bodyOf(html: string): string {
  return html.match(/<p class="max-w-sm[^>]*>([^<]*)<\/p>/)?.[1] ?? "";
}

describe("JobDetailScreen with an id that is not a UUID", () => {
  test("says the job was not found", () => {
    expect(render("/jobs/not-a-job")).toContain("ジョブが見つかりません");
  });

  test("gives the heading of the page", () => {
    expect(render("/jobs/not-a-job")).toMatch(/<h1[^>]*>ジョブの詳細<\/h1>/);
  });

  test("goes back to the job list", () => {
    expect(render("/jobs/not-a-job")).toContain('href="/jobs"');
  });

  test("does not echo the id the user typed", () => {
    expect(render("/jobs/%3Cb%3Ex")).not.toContain("<b>x");
  });

  test("names the retention and the id as the reasons", () => {
    expect(bodyOf(render("/jobs/not-a-job"))).toBe(NOT_FOUND);
  });
});

describe("JobDetailScreen before the first read", () => {
  test("shows the job id in mono under the title, as the loaded header does", () => {
    expect(render(`/jobs/${ID}`)).toMatch(
      new RegExp(`<p class="[^"]*font-mono[^"]*">${ID}</p>`),
    );
  });
});

describe("JobDetailScreen from the cache", () => {
  test("shows the overview of the job that was read", () => {
    expect(render(`/jobs/${ID}`, { output: detail("failure") })).toMatch(
      /<h2[^>]*>概要<\/h2>/,
    );
  });

  test("names the job by its script", () => {
    expect(render(`/jobs/${ID}`, { output: detail("failure") })).toMatch(
      /<h1[^>]*>implement<\/h1>/,
    );
  });

  test("says the same thing for a job the server did not find as for a bad id", () => {
    expect(bodyOf(render(`/jobs/${ID}`, { output: { found: false } }))).toBe(
      bodyOf(render("/jobs/not-a-job")),
    );
  });

  test("says the retention and the id as the reasons for a job that was not found", () => {
    expect(bodyOf(render(`/jobs/${ID}`, { output: { found: false } }))).toBe(
      NOT_FOUND,
    );
  });

  test("offers to refresh the status from the header", () => {
    expect(render(`/jobs/${ID}`, { output: detail("failure") })).toContain(
      'aria-label="状態を更新"',
    );
  });

  test("offers one button for the log, which is the only way to reread it", () => {
    expect(
      render(`/jobs/${ID}`, { output: detail("failure") }).match(
        /ログと原因を更新/g,
      ),
    ).toHaveLength(1);
  });

  test("tells a running job refreshes its status by itself", () => {
    expect(render(`/jobs/${ID}`, { output: detail("running") })).toContain(
      "15秒ごとに更新します",
    );
  });

  test("offers to stop a running flow of a work item", () => {
    expect(render(`/jobs/${ID}`, { output: detail("running") })).toContain(
      "ジョブを中止",
    );
  });

  test("offers nothing to stop for a job that failed", () => {
    expect(render(`/jobs/${ID}`, { output: detail("failure") })).not.toContain(
      "ジョブを中止",
    );
  });

  test("offers nothing to stop for a flow that is not on the list", () => {
    expect(
      render(`/jobs/${ID}`, {
        output: detail("running", { scriptPath: "f/factory/manual_intake" }),
      }),
    ).not.toContain("ジョブを中止");
  });
});

describe("JobDetailScreen when the job finished after the output was read", () => {
  const seed: Seed = {
    output: detail("running"),
    outputAt: Date.now() - 4000,
    status: detail("success"),
    statusAt: Date.now() - 1000,
  };

  test("shows the newer state", () => {
    expect(render(`/jobs/${ID}`, seed)).toMatch(
      /状態<\/dt><dd[^>]*>[\s\S]*?成功/,
    );
  });

  test("leaves the notice to the sections that were not read yet", () => {
    expect(render(`/jobs/${ID}`, seed)).not.toContain(
      "ジョブの状態が変わりました",
    );
  });

  test("says the saved causes were not read yet, not that there are none", () => {
    const html = render(`/jobs/${ID}`, seed);
    expect(html).not.toContain("保存された失敗の原因はありません");
  });

  test("says the result was not read yet, not that there is none", () => {
    const html = render(`/jobs/${ID}`, seed);
    expect(html).not.toContain("結果はありません");
  });

  test("tells the sections that were not read yet", () => {
    expect(render(`/jobs/${ID}`, seed)).toContain("まだ読んでいません");
  });

  test("keeps the log that was read", () => {
    expect(render(`/jobs/${ID}`, seed)).toContain("log line");
  });

  test("does not say the sections were not read when the output is newer", () => {
    expect(
      render(`/jobs/${ID}`, {
        output: detail("success"),
        outputAt: Date.now() - 500,
        status: detail("running"),
        statusAt: Date.now() - 3000,
      }),
    ).not.toContain("まだ読んでいません");
  });
});

describe("JobDetailScreen while a flow is running", () => {
  const running = (steps: string[]) => detail("running", { steps });

  test("shows the steps that the newer status read has, so progress is visible", () => {
    expect(
      render(`/jobs/${ID}`, {
        output: running(["prepare"]),
        outputAt: Date.now() - 20_000,
        status: running(["prepare", "generate"]),
        statusAt: Date.now() - 1000,
      }),
    ).toContain("generate");
  });

  test("shows the steps of the log read when it is newer", () => {
    expect(
      render(`/jobs/${ID}`, {
        output: running(["prepare", "generate"]),
        outputAt: Date.now() - 1000,
        status: running(["prepare"]),
        statusAt: Date.now() - 20_000,
      }),
    ).toContain("generate");
  });
});

describe("JobDetailScreen for a job that is waiting for its time", () => {
  test("does not say the status refreshes every 15 seconds", () => {
    expect(
      render(`/jobs/${ID}`, { output: detail("scheduled") }),
    ).not.toContain("15秒ごとに更新します");
  });
});

describe("JobDetailScreen for a failure whose cause may not be saved yet", () => {
  const soon = new Date(Date.now() - 60_000).toISOString();

  test("says the cause may not be saved yet", () => {
    expect(
      render(`/jobs/${ID}`, {
        output: detail("failure", { completedAt: soon }),
      }),
    ).toContain("まだ保存されていない場合があります");
  });

  test("says there is no cause once the detection had its chance", () => {
    expect(render(`/jobs/${ID}`, { output: detail("failure") })).toContain(
      "保存された失敗の原因はありません",
    );
  });
});

describe("JobDetailScreen hidden characters in the title", () => {
  test("replaces them in the heading", () => {
    expect(
      render(`/jobs/${ID}`, {
        output: detail("failure", { scriptPath: "f/factory/a\u202Eb" }),
      }),
    ).not.toContain("\u202E");
  });
});

describe("JobDetailScreen when the status cannot be refreshed", () => {
  const seed: Seed = {
    output: detail("running"),
    status: detail("running"),
    statusError: true,
  };

  test("says the latest fetch failed and the old value is shown, as the other screens do", () => {
    expect(render(`/jobs/${ID}`, seed)).toContain(
      "最新の取得に失敗したため、前回取得した値を表示しています。",
    );
  });

  test("offers to fetch it again", () => {
    expect(render(`/jobs/${ID}`, seed)).toContain("もう一度取得する");
  });

  test("says nothing when the status was refreshed", () => {
    expect(
      render(`/jobs/${ID}`, {
        output: detail("running"),
        status: detail("running"),
      }),
    ).not.toContain("最新の取得に失敗したため");
  });
});

describe("JobDetailScreen while the status is being fetched", () => {
  test("stops the log button, so two reads never run together", () => {
    expect(
      render(`/jobs/${ID}`, {
        output: detail("running"),
        status: detail("running"),
        statusFetching: true,
      }),
    ).toMatch(/aria-disabled="true"[^>]*>ログと原因を更新/);
  });

  test("leaves the log button alone when nothing is being fetched", () => {
    expect(
      render(`/jobs/${ID}`, {
        output: detail("running"),
        status: detail("running"),
      }),
    ).not.toMatch(/aria-disabled="true"[^>]*>ログと原因を更新/);
  });
});
