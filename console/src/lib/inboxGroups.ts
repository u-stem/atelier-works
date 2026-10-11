// 要対応の一覧で、同じ種類の未解決の通知を1行にまとめる純粋関数。
// まとめるのは通知だけで、承認と失敗は1件ずつ判断するので、まとめない。
// まとめても個々の通知は失わず、グループの件数と通常の行(1件)の合計が項目の数と一致する。

import type { InboxSelection } from "./inboxSelection.ts";
import { type InboxItem, itemId } from "./inboxView.ts";
import { describeNotice } from "./noticeView.ts";

type NoticeItem = Extract<InboxItem, { type: "notice" }>;

/** 一覧の1行。まとめない項目は`item`、まとめた通知は`group`である。 */
export type InboxRow =
  | { readonly type: "item"; readonly item: InboxItem }
  | {
      readonly type: "group";
      /** 通知の種別。まとめる単位で、開閉の状態のキーでもある。 */
      readonly kind: string;
      /** 2件以上。入力の順を保つ。 */
      readonly notices: readonly NoticeItem[];
    };

/** まとめられる通知か。解決済みの通知は、対応が済んでいるのでまとめず、1件ずつ出す。 */
function isGroupable(item: InboxItem): item is NoticeItem {
  return item.type === "notice" && !item.notice.resolved;
}

/**
 * 項目を一覧の行にする。同じ種別の未解決の通知が2件以上あれば、1つのグループの行にする。
 * グループは、最初の通知があった位置に置く。並びは入力の順を保つ。
 * 1件だけの通知と、承認、失敗、解決済みの通知は、そのまま1行にする。
 */
export function groupInboxItems(items: readonly InboxItem[]): InboxRow[] {
  const byKind = new Map<string, NoticeItem[]>();
  for (const item of items) {
    if (isGroupable(item)) {
      const members = byKind.get(item.notice.kind) ?? [];
      members.push(item);
      byKind.set(item.notice.kind, members);
    }
  }
  const rows: InboxRow[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    if (!isGroupable(item)) {
      rows.push({ type: "item", item });
      continue;
    }
    const kind = item.notice.kind;
    const members = byKind.get(kind) ?? [];
    if (members.length < 2) {
      rows.push({ type: "item", item });
    } else if (!placed.has(kind)) {
      placed.add(kind);
      rows.push({ type: "group", kind, notices: members });
    }
  }
  return rows;
}

export type GroupDescription = {
  /** 行の識別子。 */
  readonly key: string;
  readonly title: string;
  /** 「3件」の形。 */
  readonly countLabel: string;
  /** 中で最も新しい通知の時刻。一覧の並び(新しい順)の根拠と揃える。 */
  readonly iso: string;
  /**
   * 閉じた行の副題。メンバーの本文が挙げる最初の対象を、重複なしで最大2つ並べ、残りは「ほか対象N件」にする。
   * 件数の表示(「3件」は通知の数)と紛れないよう、対象の数だと分かる語を添える。
   * 対象を挙げない通知は数えない。どの通知も挙げなければ`null`。
   * 閉じたままでも、別の対象の通知が紛れ込んだことに気づけるようにするためである。
   */
  readonly targetsLabel: string | null;
};

/** 副題に並べる対象の数。 */
const TARGETS_SHOWN = 2;

function targetsLabelOf(
  group: Extract<InboxRow, { type: "group" }>,
): string | null {
  const labels = [
    ...new Set(
      group.notices.flatMap((each) => {
        const target = describeNotice(each.notice).targets[0];
        return target === undefined ? [] : [target.label];
      }),
    ),
  ];
  if (labels.length === 0) {
    return null;
  }
  const shown = labels.slice(0, TARGETS_SHOWN).join("、");
  const rest = labels.length - TARGETS_SHOWN;
  return rest > 0 ? `${shown} ほか対象${rest}件` : shown;
}

/** グループの行に出す内容。題名は種別の語で、個々の通知の違いは開いた行の副題が担う。 */
export function describeGroup(
  group: Extract<InboxRow, { type: "group" }>,
): GroupDescription {
  const [first] = group.notices;
  const newest = group.notices.reduce(
    (latest, each) =>
      Date.parse(each.notice.created_at) > Date.parse(latest)
        ? each.notice.created_at
        : latest,
    first?.notice.created_at ?? "",
  );
  return {
    key: `notice-group:${group.kind}`,
    title: first === undefined ? "" : describeNotice(first.notice).title,
    countLabel: `${group.notices.length}件`,
    iso: newest,
    targetsLabel: targetsLabelOf(group),
  };
}

/** 選んだ通知を含むグループの種別。選んでいないとき、通知でないとき、まとめられていないときは`null`。 */
export function groupKindOfSelection(
  rows: readonly InboxRow[],
  selection: InboxSelection | null,
): string | null {
  if (selection === null || selection.type !== "notice") {
    return null;
  }
  const group = rows.find(
    (row) =>
      row.type === "group" &&
      row.notices.some((each) => itemId(each) === selection.id),
  );
  return group?.type === "group" ? group.kind : null;
}

/** グループの開閉の状態。 */
export type GroupExpansion = {
  /**
   * 最後に自動で開いたときの選択(`種別:通知のid`)。選択を含むグループが無いときは`null`。
   * 同じ選択のまま自分で閉じたグループを、再描画のたびに開き直さないために持つ。
   */
  readonly openedFor: string | null;
  /** 開いているグループの種別。 */
  readonly expanded: ReadonlySet<string>;
};

export const INITIAL_EXPANSION: GroupExpansion = {
  openedFor: null,
  expanded: new Set<string>(),
};

/**
 * 一覧と選択の現状に合わせて開閉の状態を直す。
 * - 一覧から無くなった(まとめられなくなった)種別は、開いている集合から外す。
 * - 選択が別のグループや別の通知に移ったとき、またはグループが選択を含むようになったときは、そのグループを開く。
 *   選んだ通知を折りたたみの中に隠さないためである。
 * - 同じ選択のまま自分で閉じたグループは、開き直さない。
 * 変えるものが無いときは、同じ状態をそのまま返す(状態の更新で再描画を起こさない)。
 */
export function syncExpansion(
  state: GroupExpansion,
  rows: readonly InboxRow[],
  selection: InboxSelection | null,
): GroupExpansion {
  const present = new Set(
    rows.flatMap((row) => (row.type === "group" ? [row.kind] : [])),
  );
  const kept = [...state.expanded].filter((kind) => present.has(kind));
  const kind = groupKindOfSelection(rows, selection);
  const openedFor =
    kind === null || selection === null ? null : `${kind}:${selection.id}`;
  const selectionMoved = openedFor !== state.openedFor;
  if (!selectionMoved && kept.length === state.expanded.size) {
    return state;
  }
  return {
    openedFor,
    expanded: new Set(selectionMoved && kind !== null ? [...kept, kind] : kept),
  };
}

/** 種別のグループを開閉し直す。`openedFor`は変えない。 */
export function toggleGroup(
  state: GroupExpansion,
  kind: string,
): GroupExpansion {
  const expanded = new Set(state.expanded);
  if (!expanded.delete(kind)) {
    expanded.add(kind);
  }
  return { openedFor: state.openedFor, expanded };
}
