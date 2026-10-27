// コマンドパレットの項目、絞り込み、キー操作、選んだ後の手順。DOMには触れない。
// 検索の対象は、画面の表にある画面と、ショートカットの一覧(ヘルプ)の2つのグループだけにする。
// 表示する文字は、画面の表と、このファイルの固定の文字だけから作り、サーバー由来の文字は使わない。

import { nextNavFocusIndex } from "./navigation.ts";
import { isComposingKey } from "./shortcutKeys.ts";

export type PaletteGroupId = "screens" | "help";

export type PaletteTarget =
  | { readonly kind: "screen"; readonly path: string }
  | { readonly kind: "help" };

export type PaletteItem = {
  readonly id: string;
  readonly group: PaletteGroupId;
  readonly label: string;
  /** 絞り込みだけが見る、ラベルに無い言葉。 */
  readonly keywords: string;
  readonly target: PaletteTarget;
};

export type PaletteSection = {
  readonly id: PaletteGroupId;
  readonly label: string;
  readonly items: readonly PaletteItem[];
};

export type PaletteKeyAction =
  | { readonly kind: "ignore" }
  | { readonly kind: "move"; readonly index: number }
  | { readonly kind: "choose"; readonly index: number };

/** 項目を選んだときに行う操作。 */
export type ChooseEnv = {
  close(): void;
  navigate(path: string): void;
  openHelp(): void;
};

const GROUP_LABELS: Readonly<Record<PaletteGroupId, string>> = {
  screens: "画面",
  help: "ヘルプ",
};

/** グループを並べる順。 */
const GROUP_ORDER: readonly PaletteGroupId[] = ["screens", "help"];

export const HELP_ITEM_LABEL = "ショートカットの一覧を開く";

/**
 * 画面の表から、パレットの項目を作る。
 * 画面ごとに、サイドバーの1回の押下で届かない固定の行き先(`destinations`)が続く。
 * ヘルプの項目は、画面の有無によらず常に末尾に付く。
 */
export function paletteItems(
  screens: readonly {
    readonly id: string;
    readonly label: string;
    readonly path: string;
    readonly destinations: readonly {
      readonly label: string;
      readonly path: string;
    }[];
  }[],
): readonly PaletteItem[] {
  return [
    ...screens.flatMap((screen): PaletteItem[] => [
      {
        id: `screen-${screen.id}`,
        group: "screens",
        label: screen.label,
        keywords: screen.id,
        target: { kind: "screen", path: screen.path },
      },
      ...screen.destinations.map(
        (destination, index): PaletteItem => ({
          id: `screen-${screen.id}-${String(index)}`,
          group: "screens",
          label: destination.label,
          keywords: screen.id,
          target: { kind: "screen", path: destination.path },
        }),
      ),
    ]),
    {
      id: "help",
      group: "help",
      label: HELP_ITEM_LABEL,
      keywords: "ヘルプ キーボード キー 操作 shortcut shortcuts help",
      target: { kind: "help" },
    },
  ];
}

/** 全角と半角、大文字と小文字の違いを無くす。 */
function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** 空白で区切った語のすべてを、ラベルかキーワードに含む項目だけを、元の順で返す。 */
export function filterPaletteItems(
  items: readonly PaletteItem[],
  query: string,
): readonly PaletteItem[] {
  const terms = fold(query)
    .split(/\s+/)
    .filter((term) => term !== "");
  if (terms.length === 0) {
    return items;
  }
  return items.filter((item) => {
    const text = fold(`${item.label} ${item.keywords}`);
    return terms.every((term) => text.includes(term));
  });
}

/** 項目をグループの見出しごとに分ける。項目が無いグループは出さない。 */
export function paletteSections(
  items: readonly PaletteItem[],
): readonly PaletteSection[] {
  return GROUP_ORDER.flatMap((id) => {
    const inGroup = items.filter((item) => item.group === id);
    return inGroup.length === 0
      ? []
      : [{ id, label: GROUP_LABELS[id], items: inGroup }];
  });
}

/**
 * 入力欄のキーから、項目への操作を決める。
 * 変換中のキーは何もしない。変換を確定するEnterで項目を選ぶと、入力が途中で確定されてしまうためである。
 * HomeとEndは入力欄のカーソルの移動に残す。
 */
export function paletteKeyAction(
  event: {
    readonly key: string;
    readonly keyCode: number;
    readonly isComposing: boolean;
  },
  active: number,
  count: number,
): PaletteKeyAction {
  if (isComposingKey(event) || count <= 0) {
    return { kind: "ignore" };
  }
  if (event.key === "Enter") {
    return { kind: "choose", index: active };
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const index = nextNavFocusIndex(event.key, active, count);
    return index === null ? { kind: "ignore" } : { kind: "move", index };
  }
  return { kind: "ignore" };
}

/** 結果の件数を読み上げる文。 */
export function paletteStatus(count: number): string {
  return count > 0 ? `${count}件の候補` : "該当する項目はありません";
}

/**
 * 項目を選んだ後の手順。先にパレットを閉じてから行き先へ移る。
 * 閉じるとブラウザが開く前の要素へフォーカスを戻すので、遷移後のフォーカスの移動を奪わない。
 */
export function chooseItem(item: PaletteItem, env: ChooseEnv): void {
  env.close();
  if (item.target.kind === "screen") {
    env.navigate(item.target.path);
  } else {
    env.openHelp();
  }
}
