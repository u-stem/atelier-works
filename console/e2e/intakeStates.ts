// 投入の2画面(新規投入、PRレビューの投入)を、入力の操作だけで出せる状態にする部品。
// 送信は、入力に誤りがあるときだけ押す。誤りが無い入力を送ると、書き込みのscriptが呼ばれ、
// 検査用の受け口が中断して検査を失敗にする。
// そのため、断られた理由と投入できた結果の表示は、ブラウザでは出さない。それらは静的な描画の検査が見る。
// 送信中の入力欄の見た目だけは、読み取り専用を直接付けて、色のコントラストを測るために模す。

import type { Page } from "@playwright/test";
import { expect } from "./support.ts";

export const NEW_ITEM_PATH = "items/new";
export const NEW_PR_REVIEW_PATH = "items/new-pr-review";

/** 題名の上限(256字)を超える題名。 */
const TITLE_OVER_LIMIT = "あ".repeat(257);

export type IntakeState = {
  readonly name: string;
  readonly path: string;
  /** 経路を開いた後に、状態を作る。作れたことを確かめるところまで含む。 */
  readonly prepare: (page: Page) => Promise<void>;
};

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true });

const choose = (page: Page, label: RegExp) =>
  page.getByRole("radio", { name: label }).check();

/** 新規投入の必須の欄を、誤りの無い値で埋める。リポジトリが空のときは、候補の形で埋める。 */
export async function fillNewItem(page: Page): Promise<void> {
  await field(page, "リポジトリ").fill("o/r");
  await field(page, "題名").fill("example title");
  await field(page, "目的").fill("example purpose");
}

async function fillBugfix(page: Page): Promise<void> {
  await field(page, "再現手順").fill("example steps");
  await field(page, "期待する動作").fill("example expected");
  await field(page, "実際の動作").fill("example actual");
}

/**
 * 送信中の入力欄を模す。文字を入れる入力欄(ラジオを除く)と複数行の入力欄を読み取り専用にする。
 * 画面は送信中にこの属性を付ける。フォームの外の入力欄は触らない。送信は書き込みなので、実際の送信ではブラウザに出せない。
 */
async function makeTextFieldsReadOnly(page: Page): Promise<void> {
  await page.evaluate(() => {
    const form = document.querySelector("form");
    if (form === null) {
      return;
    }
    for (const element of form.querySelectorAll("input, textarea")) {
      if (
        (element instanceof HTMLInputElement && element.type === "text") ||
        element instanceof HTMLTextAreaElement
      ) {
        element.readOnly = true;
      }
    }
  });
}

export const INTAKE_STATES: readonly IntakeState[] = [
  {
    name: "new item: the initial form",
    path: NEW_ITEM_PATH,
    prepare: async (page) => {
      await expect(field(page, "題名")).toHaveValue("");
    },
  },
  {
    name: "new item: problems of an empty form",
    path: NEW_ITEM_PATH,
    prepare: async (page) => {
      await page.getByRole("button", { name: "投入する", exact: true }).click();
      await expect(page.getByText("題名を入力してください。")).toBeVisible();
    },
  },
  {
    name: "new item: a title over the limit",
    path: NEW_ITEM_PATH,
    prepare: async (page) => {
      await field(page, "題名").fill(TITLE_OVER_LIMIT);
      await field(page, "目的").fill("example purpose");
      await page.getByRole("button", { name: "投入する", exact: true }).click();
      await expect(
        page.getByText("題名は256字までにしてください。"),
      ).toBeVisible();
    },
  },
  {
    name: "new item: a filled form",
    path: NEW_ITEM_PATH,
    prepare: async (page) => {
      await fillNewItem(page);
      await expect(field(page, "題名")).toHaveValue("example title");
    },
  },
  {
    name: "new item: the notice of a profile that skips approval",
    path: NEW_ITEM_PATH,
    prepare: async (page) => {
      await choose(page, /^直接/);
      await expect(
        page.getByText("PRは人がレビューしてからマージしてください"),
      ).toBeVisible();
    },
  },
  {
    name: "new item: the fields of a bug fix",
    path: NEW_ITEM_PATH,
    prepare: async (page) => {
      await choose(page, /^不具合の修正/);
      await expect(field(page, "再現手順")).toBeVisible();
    },
  },
  {
    name: "new item: problems of the fields of a bug fix",
    path: NEW_ITEM_PATH,
    prepare: async (page) => {
      await choose(page, /^不具合の修正/);
      await page
        .getByRole("button", { name: "承認なしで投入する", exact: true })
        .click();
      await expect(
        page.getByText("再現手順を入力してください。"),
      ).toBeVisible();
    },
  },
  {
    name: "new item: a filled form of a bug fix",
    path: NEW_ITEM_PATH,
    prepare: async (page) => {
      await choose(page, /^不具合の修正/);
      await fillNewItem(page);
      await fillBugfix(page);
      await expect(field(page, "実際の動作")).toHaveValue("example actual");
    },
  },
  {
    name: "new item: read only text fields while sending",
    path: NEW_ITEM_PATH,
    prepare: async (page) => {
      await choose(page, /^不具合の修正/);
      await fillNewItem(page);
      await fillBugfix(page);
      await makeTextFieldsReadOnly(page);
      // リポジトリと題名の入力欄、目的と3欄と受入基準の複数行の入力欄。
      await expect(page.locator("form input[readonly]")).toHaveCount(2);
      await expect(page.locator("form textarea[readonly]")).toHaveCount(5);
    },
  },
  {
    name: "PR review: the initial form",
    path: NEW_PR_REVIEW_PATH,
    prepare: async (page) => {
      await expect(field(page, "PRの番号またはURL")).toHaveValue("");
    },
  },
  {
    name: "PR review: problem of an empty pull request",
    path: NEW_PR_REVIEW_PATH,
    prepare: async (page) => {
      await page
        .getByRole("button", { name: "レビューを投入する", exact: true })
        .click();
      await expect(
        page.getByText("PRの番号またはURLを入力してください。"),
      ).toBeVisible();
    },
  },
  {
    name: "PR review: problem of a repository",
    path: NEW_PR_REVIEW_PATH,
    prepare: async (page) => {
      await field(page, "リポジトリ").fill("invalid");
      await field(page, "PRの番号またはURL").fill("1");
      await page
        .getByRole("button", { name: "レビューを投入する", exact: true })
        .click();
      await expect(
        page.getByText(
          "リポジトリは「オーナー名/リポジトリ名」の形で入力してください。",
        ),
      ).toBeVisible();
    },
  },
  {
    name: "PR review: a filled form",
    path: NEW_PR_REVIEW_PATH,
    prepare: async (page) => {
      await field(page, "リポジトリ").fill("o/r");
      await field(page, "PRの番号またはURL").fill("1");
      await expect(field(page, "PRの番号またはURL")).toHaveValue("1");
    },
  },
];
