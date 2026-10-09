// 新しいサイクルが始まって、承認済みの作業項目を取り消したときの、Issueへのコメントのテスト。

import { describe, expect, test } from "bun:test";
import type { GhClient } from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  buildSupersededComment,
  type PostSupersededDeps,
  postSupersededComments,
} from "../../f/factory/lib/supersede_support.ts";
import { ok } from "./testSupport.ts";

const CLIENT: GhClient = { run: async () => ok(), ghToken: "tok" };

type CommentCall = {
  kind: string;
  workItemId: number;
  body: string;
  viewer: string;
  number: number;
};

function fakeDeps(overrides: Partial<PostSupersededDeps> = {}): {
  deps: PostSupersededDeps;
  comments: CommentCall[];
} {
  const comments: CommentCall[] = [];
  const deps: PostSupersededDeps = {
    commentIssue: async (
      _client,
      _owner,
      _repo,
      number,
      kind,
      workItemId,
      body,
      viewer,
    ) => {
      comments.push({ kind, workItemId, body, viewer, number });
      return { id: comments.length, created: true };
    },
    ...overrides,
  };
  return { deps, comments };
}

function recordingLog(): { log: Logger; warns: string[] } {
  const warns: string[] = [];
  const log: Logger = {
    info() {},
    warn(message) {
      warns.push(message);
    },
    error() {},
  };
  return { log, warns };
}

function post(
  superseded: { id: number; attempt: number }[],
  deps: PostSupersededDeps,
  log: Logger,
) {
  return postSupersededComments(
    {
      client: CLIENT,
      owner: "octo-owner",
      repo: "atelier-works",
      issueNumber: 12,
      viewerLogin: "factory-bot",
      newWorkItemId: 77,
      superseded,
      log,
    },
    deps,
  );
}

describe("buildSupersededComment", () => {
  test("names the cancelled and the new work item and asks for no action", () => {
    expect(buildSupersededComment(5, 77)).toBe(
      [
        "承認済みだった要件定義(work_item_id: 5)を取り消しました。",
        "このIssueで新しいサイクル(work_item_id: 77)が始まったためです。",
        "新しいサイクルの要件定義には、あらためて承認が必要です。",
        "前の承認について、対応いただく必要はありません。",
      ].join("\n"),
    );
  });

  test("does not assert that the cause was a re-label", () => {
    expect(buildSupersededComment(5, 77)).not.toContain("ラベル");
  });

  test("does not promise that an approval request will arrive", () => {
    expect(buildSupersededComment(5, 77)).not.toContain("お送りします");
  });
});

describe("postSupersededComments", () => {
  test("posts nothing when no work item was superseded", async () => {
    const { deps, comments } = fakeDeps();
    const { log } = recordingLog();
    await post([], deps, log);
    expect(comments).toEqual([]);
  });

  test("posts one comment for each superseded work item", async () => {
    const { deps, comments } = fakeDeps();
    const { log } = recordingLog();
    await post(
      [
        { id: 5, attempt: 2 },
        { id: 6, attempt: 1 },
      ],
      deps,
      log,
    );
    expect(comments.map((c) => c.workItemId)).toEqual([5, 6]);
  });

  test("keys the marker on the attempt of the cancelled work item", async () => {
    const { deps, comments } = fakeDeps();
    const { log } = recordingLog();
    await post([{ id: 5, attempt: 2 }], deps, log);
    expect(comments[0]?.kind).toBe("issue-superseded-2");
  });

  test("posts to the issue as the factory user", async () => {
    const { deps, comments } = fakeDeps();
    const { log } = recordingLog();
    await post([{ id: 5, attempt: 2 }], deps, log);
    expect([comments[0]?.number, comments[0]?.viewer]).toEqual([
      12,
      "factory-bot",
    ]);
  });

  test("words the comment with both work item ids", async () => {
    const { deps, comments } = fakeDeps();
    const { log } = recordingLog();
    await post([{ id: 5, attempt: 2 }], deps, log);
    expect(comments[0]?.body).toBe(buildSupersededComment(5, 77));
  });

  test("goes on with the next comment when one fails", async () => {
    const { deps, comments } = fakeDeps();
    let first = true;
    const failingFirst: PostSupersededDeps = {
      commentIssue: async (...args) => {
        if (first) {
          first = false;
          throw new Error("gh down");
        }
        return deps.commentIssue(...args);
      },
    };
    const { log } = recordingLog();
    await post(
      [
        { id: 5, attempt: 2 },
        { id: 6, attempt: 1 },
      ],
      failingFirst,
      log,
    );
    expect(comments.map((c) => c.workItemId)).toEqual([6]);
  });

  test("logs a failing comment instead of throwing", async () => {
    const { deps } = fakeDeps({
      commentIssue: async () => {
        throw new Error("gh down");
      },
    });
    const { log, warns } = recordingLog();
    await post([{ id: 5, attempt: 2 }], deps, log);
    expect(warns).toEqual(["superseded comment could not be posted"]);
  });
});
