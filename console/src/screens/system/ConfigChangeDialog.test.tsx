import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type ChangeOffer,
  type CheckCommands,
  changeOfferOf,
  NO_CHECK_COMMANDS,
} from "../../lib/configChange.ts";
import { ConfigChangeDialog } from "./ConfigChangeDialog.tsx";

function offerFor(key: string, value: unknown): ChangeOffer {
  const offer = changeOfferOf({ key, kind: "value", value, masked: false });
  if (offer === null) throw new Error(`no offer for ${key}`);
  return offer;
}

function render(
  offer: ChangeOffer | null,
  text = "",
  checkCommands?: CheckCommands,
) {
  return renderToStaticMarkup(
    <ConfigChangeDialog
      offer={offer}
      text={text}
      checkCommands={checkCommands ?? NO_CHECK_COMMANDS}
      onTextChange={() => undefined}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

describe("ConfigChangeDialog for a switch", () => {
  const offer = offerFor("implement_enabled", true);

  test("asks whether to stop it", () => {
    expect(render(offer)).toContain("この設定を止めますか");
  });

  test("names the item", () => {
    expect(render(offer)).toContain("implement_enabled");
  });

  test("shows the current value and the new one", () => {
    const html = render(offer);
    expect([html.includes(">true<"), html.includes(">false<")]).toEqual([
      true,
      true,
    ]);
  });

  test("has no box to type a value", () => {
    expect(render(offer)).not.toContain("<input");
  });

  test("labels the button that runs the change apart from the one that dismisses", () => {
    expect(render(offer)).toContain(">止める<");
  });

  test("says that a person undoes it in Windmill", () => {
    expect(render(offer)).toContain(
      "元に戻すには、運用者がWindmillでリソースを編集するか、wmill resource pushで戻します",
    );
  });
});

describe("ConfigChangeDialog for a number", () => {
  const offer = offerFor("daily_budget_usd", 50);

  test("asks whether to lower it", () => {
    expect(render(offer)).toContain("この設定の値を下げますか");
  });

  test("shows the current value", () => {
    expect(render(offer)).toContain(">50<");
  });

  test("has a box to type the new value, with a label", () => {
    expect(render(offer)).toMatch(/<label[^>]*>変更後の値<\/label>/);
  });

  test("shows the text that was typed", () => {
    expect(render(offer, "20")).toContain('value="20"');
  });

  test("labels the button that runs the change", () => {
    expect(render(offer, "20")).toContain(">下げる<");
  });

  test("says nothing about the value before anything is typed", () => {
    expect(render(offer, "")).not.toContain("現在の値より小さい");
  });

  test("says why a value that is not lower cannot be used", () => {
    expect(render(offer, "60")).toContain("現在の値より小さい");
  });

  test("says why a text that is not a number cannot be used", () => {
    expect(render(offer, "abc")).toContain("数字");
  });

  test("keeps the confirm button off while the value cannot be used", () => {
    const element = ConfigChangeDialog({
      offer,
      text: "60",
      onTextChange: () => undefined,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
    expect(element.props.confirmDisabled).toBe(true);
  });

  test("keeps the confirm button off while the box is empty", () => {
    const element = ConfigChangeDialog({
      offer,
      text: "",
      onTextChange: () => undefined,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
    expect(element.props.confirmDisabled).toBe(true);
  });

  test("turns the confirm button on for a value that can be used", () => {
    const element = ConfigChangeDialog({
      offer,
      text: "20",
      onTextChange: () => undefined,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
    expect(element.props.confirmDisabled).toBe(false);
  });
});

describe("ConfigChangeDialog handlers", () => {
  const offer = offerFor("daily_budget_usd", 50);

  test("hands the confirmation to the confirm handler", () => {
    const onConfirm = () => undefined;
    const element = ConfigChangeDialog({
      offer,
      text: "20",
      onTextChange: () => undefined,
      onConfirm,
      onCancel: () => undefined,
    });
    expect(element.props.onConfirm).toBe(onConfirm);
  });

  test("hands both the cancel button and Esc to the dismiss handler", () => {
    const onCancel = () => undefined;
    const element = ConfigChangeDialog({
      offer,
      text: "20",
      onTextChange: () => undefined,
      onConfirm: () => undefined,
      onCancel,
    });
    expect(element.props.onCancel).toBe(onCancel);
  });

  test("opens the dialog only for an offer", () => {
    const element = ConfigChangeDialog({
      offer: null,
      text: "",
      onTextChange: () => undefined,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
    expect(element.props.open).toBe(false);
  });

  test("asks nothing when no item is chosen", () => {
    expect(render(null)).not.toContain("この設定");
  });
});

describe("ConfigChangeDialog for adding to a list", () => {
  function addOffer(key: string, current: string[]): ChangeOffer {
    return { kind: "add", key, current };
  }

  function element(offer: ChangeOffer, text: string) {
    return ConfigChangeDialog({
      offer,
      text,
      onTextChange: () => undefined,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
  }

  const offer = addOffer("repo_allowlist", [
    "https://github.com/octo-owner/atelier-works",
  ]);

  test("asks whether to add to the list", () => {
    expect(render(offer)).toContain("この一覧に追加しますか");
  });

  test("names the item", () => {
    expect(render(offer)).toContain("repo_allowlist");
  });

  test("has a box to type the element, with a label", () => {
    expect(render(offer)).toMatch(/<label[^>]*>追加する要素<\/label>/);
  });

  test("shows the text that was typed", () => {
    expect(render(offer, "https://github.com/octo-owner/widgets")).toContain(
      'value="https://github.com/octo-owner/widgets"',
    );
  });

  test("gives the shape of an element of repo_allowlist as an example", () => {
    expect(render(offer)).toContain("https://github.com/owner/repo");
  });

  test("gives the shape of an element of dependabot_other_repos as an example", () => {
    expect(render(addOffer("dependabot_other_repos", []))).toContain(
      "例: owner/repo",
    );
  });

  test("gives the shape of an element of default_reviewers as an example", () => {
    expect(render(addOffer("default_reviewers", []))).toContain(
      "GitHubのログイン名",
    );
  });

  test("labels the button that runs the change", () => {
    expect(render(offer, "x")).toContain(">追加<");
  });

  test("colors the confirm button as a destructive one", () => {
    expect(element(offer, "x").props.destructive).toBe(true);
  });

  test("keeps the confirm button off while the box is empty", () => {
    expect(element(offer, "").props.confirmDisabled).toBe(true);
  });

  test("keeps the confirm button off while the box has only whitespace", () => {
    expect(element(offer, "  ").props.confirmDisabled).toBe(true);
  });

  test("keeps the confirm button off for an element that is too long", () => {
    expect(element(offer, "a".repeat(101)).props.confirmDisabled).toBe(true);
  });

  test("turns the confirm button on for an element of the longest length", () => {
    expect(element(offer, "a".repeat(100)).props.confirmDisabled).toBe(false);
  });

  test("turns the confirm button on for an element with whitespace around it", () => {
    expect(element(offer, "  alice ").props.confirmDisabled).toBe(false);
  });

  test("says nothing about the problem before anything is typed", () => {
    expect(render(offer, "")).not.toContain("追加する要素を入力してください");
  });

  test("says why an element that is too long cannot be used", () => {
    expect(render(offer, "a".repeat(101))).toContain("100字");
  });

  test("leaves the check of the shape to the script", () => {
    expect(element(offer, "not a url").props.confirmDisabled).toBe(false);
  });

  test("says that the Console can undo it by a removal", () => {
    expect(render(offer, "x")).toContain("元に戻すには、同じ値を削除します");
  });

  test("does not say that the Console cannot undo it", () => {
    expect(render(offer, "x")).not.toContain("Consoleからは戻せません");
  });

  test("tells that others leave the targets when repo_allowlist was empty", () => {
    expect(render(addOffer("repo_allowlist", []))).toContain(
      "挙げていない他のリポジトリは対象から外れます",
    );
  });

  test("tells how many check commands also run for the new repository", () => {
    expect(
      render(offer, "x", {
        ...NO_CHECK_COMMANDS,
        allowed: { kind: "count", count: 2 },
      }),
    ).toContain("検査コマンドが 2 件あり");
  });

  test("tells that the check commands cannot be counted", () => {
    expect(
      render(offer, "x", {
        ...NO_CHECK_COMMANDS,
        allowed: { kind: "unknown" },
      }),
    ).toContain("件数を読めません");
  });

  test("tells how many repositories have their own check commands", () => {
    expect(
      render(offer, "x", {
        ...NO_CHECK_COMMANDS,
        byRepo: { kind: "count", count: 3 },
      }),
    ).toContain("リポジトリ別の検査コマンドが 3 リポジトリ分あり");
  });

  test("says nothing about check commands when there are none", () => {
    expect(render(offer, "x")).not.toContain("検査コマンド");
  });
});

describe("ConfigChangeDialog for removing from a list", () => {
  const offer: ChangeOffer = {
    kind: "remove",
    key: "default_reviewers",
    current: ["alice", "bob"],
    index: 1,
    element: "bob",
  };

  function element(chosen: ChangeOffer) {
    return ConfigChangeDialog({
      offer: chosen,
      text: "",
      onTextChange: () => undefined,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
  }

  test("asks whether to remove from the list", () => {
    expect(render(offer)).toContain("この一覧から削除しますか");
  });

  test("names the item", () => {
    expect(render(offer)).toContain("default_reviewers");
  });

  test("shows the element to remove", () => {
    expect(render(offer)).toMatch(/削除する要素<\/dt><dd[^>]*>bob</);
  });

  test("has no box to type a value", () => {
    expect(render(offer)).not.toContain("<input");
  });

  test("labels the button that runs the change", () => {
    expect(render(offer)).toContain(">削除<");
  });

  test("colors the confirm button as a destructive one", () => {
    expect(element(offer).props.destructive).toBe(true);
  });

  test("leaves the confirm button on", () => {
    expect(element(offer).props.confirmDisabled).toBe(false);
  });

  test("says that adding the same value undoes it", () => {
    expect(render(offer)).toContain("元に戻すには、同じ値を追加します");
  });

  test("does not say that the Console cannot undo it", () => {
    expect(render(offer)).not.toContain("Consoleからは戻せません");
  });

  test("writes the element as text, not as markup", () => {
    const html = render({
      ...offer,
      element: "<img src=x onerror=alert(1)>",
    });
    expect(html).not.toContain("<img");
  });

  test("replaces hidden characters in the element", () => {
    expect(render({ ...offer, element: "a‮b" })).not.toContain("‮");
  });

  test("says nothing about check commands", () => {
    expect(
      render({ ...offer, key: "repo_allowlist" }, "", {
        allowed: { kind: "count", count: 2 },
        byRepo: { kind: "count", count: 3 },
      }),
    ).not.toContain("検査コマンド");
  });
});
