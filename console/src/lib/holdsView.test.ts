import { describe, expect, test } from "bun:test";
import type {
  DeployFreezeRowView,
  FreezeRowView,
  HoldRowView,
} from "../api/guards/holds.ts";
import {
  deployFreezeItems,
  effectText,
  foreignHolderWarning,
  freezesFailureView,
  holdItems,
  holdsFailureView,
  isExpiredAt,
  otherActiveDeployCount,
  remainingText,
  scheduleFreezeItems,
} from "./holdsView.ts";

const T0 = "2026-10-24T02:00:00.000Z";
const NOW = Date.parse("2026-10-24T03:00:00.000Z");

function hold(overrides: Partial<HoldRowView> = {}): HoldRowView {
  return {
    id: 7,
    scope: "merge",
    target: "octo/repo",
    reason: "wait",
    holder_kind: "session",
    holder: "session:feat/x",
    created_at: T0,
    expires_at: "2026-10-24T04:00:00.000Z",
    ...overrides,
  };
}

function schedule(overrides: Partial<FreezeRowView> = {}): FreezeRowView {
  return {
    id: "0a1b2c3d",
    target: "f/factory/poll_issues",
    reason: "verify",
    holder_kind: "human",
    holder: "human",
    created_at: T0,
    expires_at: "2026-10-24T04:00:00.000Z",
    ...overrides,
  };
}

function deploy(
  overrides: Partial<DeployFreezeRowView> = {},
): DeployFreezeRowView {
  return {
    id: "1b2c3d4e",
    reason: "migration",
    holder_kind: "human",
    holder: "human",
    created_at: T0,
    expires_at: "2026-10-24T04:00:00.000Z",
    ...overrides,
  };
}

describe("holdItems", () => {
  test("puts the merge holds before the claim holds", () => {
    const items = holdItems([
      hold({ id: 1, scope: "claim", target: "o/r#1" }),
      hold({ id: 2, scope: "merge" }),
    ]);
    expect(items.map((item) => item.target)).toEqual([
      { kind: "hold", id: 2 },
      { kind: "hold", id: 1 },
    ]);
  });

  test("orders holds of one scope by the nearest expiry", () => {
    const items = holdItems([
      hold({ id: 1, expires_at: "2026-10-24T05:00:00.000Z" }),
      hold({ id: 2, expires_at: "2026-10-24T04:00:00.000Z" }),
    ]);
    expect(items.map((item) => item.target)).toEqual([
      { kind: "hold", id: 2 },
      { kind: "hold", id: 1 },
    ]);
  });

  test("breaks a tie of the expiry by the id", () => {
    const items = holdItems([hold({ id: 9 }), hold({ id: 3 })]);
    expect(items.map((item) => item.target)).toEqual([
      { kind: "hold", id: 3 },
      { kind: "hold", id: 9 },
    ]);
  });

  test("keys a hold apart from a freeze", () => {
    expect(holdItems([hold({ id: 12 })])[0]?.key).toBe("hold:12");
  });

  test("labels a merge hold", () => {
    expect(holdItems([hold()])[0]?.kindLabel).toBe("マージの保留");
  });

  test("labels a claim hold as one that stops nothing", () => {
    expect(
      holdItems([hold({ scope: "claim", target: "o/r#1" })])[0]?.kindLabel,
    ).toBe("Issueの取り込みの保留(止める処理なし)");
  });

  test("notes that a claim hold stops nothing", () => {
    expect(
      holdItems([hold({ scope: "claim", target: "o/r#1" })])[0]?.note,
    ).toBe("この範囲を読む処理は無いので、何も止めていません。");
  });

  test("has no note for a merge hold", () => {
    expect(holdItems([hold()])[0]?.note).toBeNull();
  });

  test("falls back to a fixed label for an unknown scope", () => {
    expect(holdItems([hold({ scope: "other" })])[0]?.kindLabel).toBe(
      "不明な種類の保留",
    );
  });

  test("puts an unknown scope after the known ones", () => {
    const items = holdItems([
      hold({ id: 1, scope: "other" }),
      hold({ id: 2, scope: "claim", target: "o/r#1" }),
    ]);
    expect(items.map((item) => item.category)).toEqual(["claim", "unknown"]);
  });

  test("labels the holder kind", () => {
    expect(holdItems([hold()])[0]?.holderLabel).toBe("ローカルのセッション");
  });

  test("falls back to a fixed label for an unknown holder kind", () => {
    expect(holdItems([hold({ holder_kind: "robot" })])[0]?.holderLabel).toBe(
      "不明な主体",
    );
  });

  test("replaces hidden characters in the reason", () => {
    expect(holdItems([hold({ reason: "a‮b" })])[0]?.reasonText).toBe("a�b");
  });

  test("replaces hidden characters in the target", () => {
    expect(holdItems([hold({ target: "o/r​" })])[0]?.targetText).toBe("o/r�");
  });

  test("replaces hidden characters in the holder", () => {
    expect(holdItems([hold({ holder: "session:‮x" })])[0]?.holderText).toBe(
      "session:�x",
    );
  });

  test("keeps markup in the reason as plain text", () => {
    const reason = '<a href="https://evil.example">x</a><img src=x>';
    expect(holdItems([hold({ reason })])[0]?.reasonText).toBe(reason);
  });

  test("does not treat a human holder as foreign", () => {
    expect(
      holdItems([hold({ holder_kind: "human", holder: "human" })])[0]
        ?.foreignHolder,
    ).toBe(false);
  });

  test("treats a session holder as foreign", () => {
    expect(holdItems([hold()])[0]?.foreignHolder).toBe(true);
  });

  test("treats a factory holder as foreign", () => {
    expect(
      holdItems([hold({ holder_kind: "factory", holder: "factory:x" })])[0]
        ?.foreignHolder,
    ).toBe(true);
  });

  test("treats an unknown holder kind as foreign", () => {
    expect(holdItems([hold({ holder_kind: "robot" })])[0]?.foreignHolder).toBe(
      true,
    );
  });
});

describe("scheduleFreezeItems", () => {
  test("shows the schedule that the freeze keeps from the push", () => {
    expect(scheduleFreezeItems([schedule()])[0]?.targetText).toBe(
      "f/factory/poll_issues",
    );
  });

  test("keys a freeze by its id", () => {
    expect(scheduleFreezeItems([schedule()])[0]?.key).toBe("freeze:0a1b2c3d");
  });

  test("targets the release at the freeze", () => {
    expect(scheduleFreezeItems([schedule()])[0]?.target).toEqual({
      kind: "freeze",
      id: "0a1b2c3d",
    });
  });

  test("labels a schedule freeze", () => {
    expect(scheduleFreezeItems([schedule()])[0]?.kindLabel).toBe(
      "スケジュールの凍結",
    );
  });

  test("orders by the nearest expiry", () => {
    const items = scheduleFreezeItems([
      schedule({ id: "aaaaaaaa", expires_at: "2026-10-24T06:00:00.000Z" }),
      schedule({ id: "bbbbbbbb", expires_at: "2026-10-24T05:00:00.000Z" }),
    ]);
    expect(items.map((item) => item.key)).toEqual([
      "freeze:bbbbbbbb",
      "freeze:aaaaaaaa",
    ]);
  });

  test("labels a holder kind that only a session or a human has", () => {
    expect(
      scheduleFreezeItems([schedule({ holder_kind: "session" })])[0]
        ?.holderLabel,
    ).toBe("ローカルのセッション");
  });
});

describe("deployFreezeItems", () => {
  test("names the whole deployment as the target", () => {
    expect(deployFreezeItems([deploy()])[0]?.targetText).toBe(
      "反映全体(self_update、push、migration)",
    );
  });

  test("labels a deploy freeze", () => {
    expect(deployFreezeItems([deploy()])[0]?.kindLabel).toBe("deployの保留");
  });

  test("is in the deploy category", () => {
    expect(deployFreezeItems([deploy()])[0]?.category).toBe("deploy");
  });

  test("orders by the nearest expiry", () => {
    const items = deployFreezeItems([
      deploy({ id: "aaaaaaaa", expires_at: "2026-10-24T06:00:00.000Z" }),
      deploy({ id: "bbbbbbbb", expires_at: "2026-10-24T05:00:00.000Z" }),
    ]);
    expect(items.map((item) => item.key)).toEqual([
      "freeze:bbbbbbbb",
      "freeze:aaaaaaaa",
    ]);
  });
});

describe("isExpiredAt", () => {
  test("is false before the expiry", () => {
    expect(isExpiredAt("2026-10-24T03:00:01.000Z", NOW)).toBe(false);
  });

  test("is true at the expiry", () => {
    expect(isExpiredAt("2026-10-24T03:00:00.000Z", NOW)).toBe(true);
  });

  test("is true after the expiry", () => {
    expect(isExpiredAt("2026-10-24T02:59:59.000Z", NOW)).toBe(true);
  });

  test("is true for a time that cannot be read", () => {
    expect(isExpiredAt("not a time", NOW)).toBe(true);
  });
});

describe("remainingText", () => {
  test("shows the minutes left", () => {
    expect(remainingText("2026-10-24T03:30:00.000Z", NOW)).toBe("残り30分");
  });

  test("shows an expired row as expired", () => {
    expect(remainingText("2026-10-24T02:00:00.000Z", NOW)).toBe("期限切れ");
  });
});

describe("effectText", () => {
  test("tells what releasing a merge hold resumes", () => {
    const item = holdItems([hold()])[0];
    expect(item && effectText(item, 0)).toBe(
      "解除すると、このリポジトリのdependabotの自動マージとローカルのセッションのマージが、次の取得から再開します。",
    );
  });

  test("tells that releasing a claim hold changes nothing", () => {
    const item = holdItems([hold({ scope: "claim", target: "o/r#1" })])[0];
    expect(item && effectText(item, 0)).toBe(
      "この範囲を読む処理は無いので、解除しても動作は変わりません。表の掃除として解除できます。",
    );
  });

  test("tells what releasing a deploy freeze resumes", () => {
    const item = deployFreezeItems([deploy()])[0];
    expect(item && effectText(item, 0)).toBe(
      "解除すると、self_updateが次の回から反映を再開し、見送っていた変更をまとめて反映します。",
    );
  });

  test("tells how many other deploy freezes keep the deployment stopped", () => {
    const item = deployFreezeItems([deploy()])[0];
    expect(item && effectText(item, 2)).toContain(
      "ほかに2件のdeployの保留が有効です。すべて外れるまで反映は再開しません。",
    );
  });

  test("does not mention other deploy freezes when there are none", () => {
    const item = deployFreezeItems([deploy()])[0];
    expect(item && effectText(item, 0)).not.toContain("ほかに");
  });

  test("tells what releasing a schedule freeze does", () => {
    const item = scheduleFreezeItems([schedule()])[0];
    expect(item && effectText(item, 0)).toBe(
      "解除すると、次の反映(self_updateの追従)で、このスケジュールがリポジトリの定義に戻ります。",
    );
  });

  test("tells that a deploy hold keeps the schedule from returning", () => {
    const item = scheduleFreezeItems([schedule()])[0];
    expect(item && effectText(item, 1)).toContain(
      "有効なdeployの保留が1件あるあいだは、追従も待つので、スケジュールは戻りません。",
    );
  });

  test("does not mention a deploy hold of a schedule freeze when there is none", () => {
    const item = scheduleFreezeItems([schedule()])[0];
    expect(item && effectText(item, 0)).not.toContain("deployの保留");
  });

  test("does not promise anything for a scope it does not know", () => {
    const item = holdItems([hold({ scope: "other" })])[0];
    expect(item && effectText(item, 0)).toBe(
      "この種類の保留が何を止めているか、この画面は知りません。置いた理由を確かめてから解除してください。",
    );
  });
});

describe("otherActiveDeployCount", () => {
  test("counts the other deploy freezes that have not expired", () => {
    const items = deployFreezeItems([
      deploy({ id: "aaaaaaaa" }),
      deploy({ id: "bbbbbbbb" }),
      deploy({ id: "cccccccc" }),
    ]);
    const first = items[0];
    expect(first && otherActiveDeployCount(items, first, NOW)).toBe(2);
  });

  test("does not count an expired one", () => {
    const items = deployFreezeItems([
      deploy({ id: "aaaaaaaa" }),
      deploy({ id: "bbbbbbbb", expires_at: "2026-10-24T02:30:00.000Z" }),
    ]);
    const first = items.find((item) => item.key === "freeze:aaaaaaaa");
    expect(first && otherActiveDeployCount(items, first, NOW)).toBe(0);
  });
});

describe("foreignHolderWarning", () => {
  test("warns about a hold that another party placed", () => {
    const item = holdItems([hold()])[0];
    expect(item && foreignHolderWarning(item)).toBe(
      "別の主体が置いた保留です。置いた理由を確かめてから解除してください。",
    );
  });

  test("does not warn about a hold that a human placed", () => {
    const item = holdItems([
      hold({ holder_kind: "human", holder: "human" }),
    ])[0];
    expect(item && foreignHolderWarning(item)).toBeNull();
  });

  test("says freeze when the row is a freeze", () => {
    const item = scheduleFreezeItems([
      schedule({ holder_kind: "session", holder: "session:x" }),
    ])[0];
    expect(item && foreignHolderWarning(item)).toBe(
      "別の主体が置いた凍結です。置いた理由を確かめてから解除してください。",
    );
  });
});

describe("holdsFailureView", () => {
  test("names a missing table and says that the migration is not applied", () => {
    expect(
      holdsFailureView({ ok: false, kind: "missing_table", reason: "r" }),
    ).toMatchObject({
      title: "保留の表がありません",
      detail:
        "migrationが未反映です。この間、dependabotの自動マージとローカルのマージは止まります。",
    });
  });

  test("names an unreadable table and says that merges stop", () => {
    expect(
      holdsFailureView({ ok: false, kind: "read_failed", reason: "r" }),
    ).toMatchObject({
      title: "保留を読めませんでした",
      detail:
        "読めない間、dependabotの自動マージとローカルのマージは止まります。",
    });
  });

  test("offers a retry for an unreadable table", () => {
    expect(
      holdsFailureView({ ok: false, kind: "read_failed", reason: "r" }).retry,
    ).toBe(true);
  });

  test("names a corrupt table and shows the recovery steps as they are", () => {
    expect(
      holdsFailureView({
        ok: false,
        kind: "corrupt",
        reason: "inspect it with psql",
      }),
    ).toMatchObject({
      title: "保留の表に壊れた行があるため、一覧を出せません",
      reason: "inspect it with psql",
      reasonOpen: true,
    });
  });

  test("points at the list command for a corrupt table", () => {
    expect(
      holdsFailureView({ ok: false, kind: "corrupt", reason: "r" }).hint,
    ).toContain("mise run hold:list");
  });

  test("offers no retry for a corrupt table", () => {
    expect(
      holdsFailureView({ ok: false, kind: "corrupt", reason: "r" }).retry,
    ).toBe(false);
  });

  test("treats an unknown kind like an unreadable table", () => {
    expect(
      holdsFailureView({ ok: false, kind: "timeout", reason: "r" }).title,
    ).toBe("保留を読めませんでした");
  });

  test("replaces hidden characters in the reason", () => {
    expect(
      holdsFailureView({ ok: false, kind: "read_failed", reason: "a‮b" }).reason,
    ).toBe("a�b");
  });
});

describe("freezesFailureView", () => {
  test("names the freezes that cannot be read", () => {
    expect(freezesFailureView({ ok: false, reason: "r" }).title).toBe(
      "凍結とdeployの保留を読めません",
    );
  });

  test("says that a deployment that is needed stops", () => {
    expect(freezesFailureView({ ok: false, reason: "r" }).detail).toBe(
      "反映が要る回のself_updateは、凍結を読めない間、反映せずに止まります。",
    );
  });

  test("shows the recovery steps in the reason as they are", () => {
    expect(
      freezesFailureView({ ok: false, reason: "run freeze:reset" }),
    ).toMatchObject({ reason: "run freeze:reset", reasonOpen: true });
  });

  test("offers a retry", () => {
    expect(freezesFailureView({ ok: false, reason: "r" }).retry).toBe(true);
  });
});
