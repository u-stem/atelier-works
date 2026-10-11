// 要対応の一覧で、同じ種類の未解決の通知を1行にまとめる純粋関数。
// まとめるのは通知だけで、承認と失敗は1件ずつ判断するので、まとめない。
// まとめても個々の項目は失わず、`rowItems`で元の項目に戻せる。件数は`rowCount`の合計が項目の数と一致する。

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

/** 行に含まれる個々の項目。グループなら中の通知すべて。 */
export function rowItems(row: InboxRow): readonly InboxItem[] {
  return row.type === "item" ? [row.item] : row.notices;
}

/** 行が表す項目の数。全行の合計は、項目の数と一致する。 */
export function rowCount(row: InboxRow): number {
  return rowItems(row).length;
}

export type GroupDescription = {
  /** 行の識別子。 */
  readonly key: string;
  readonly title: string;
  /** 「3件」の形。 */
  readonly countLabel: string;
  /** 中で最も新しい通知の時刻。一覧の並び(新しい順)の根拠と揃える。 */
  readonly iso: string;
};

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

/**
 * 選択に合わせて開くグループを足した集合を返す。
 * 選んだ通知を折りたたみの中に隠さないためである。
 * 足すものが無いときは、同じ集合をそのまま返す(状態の更新で再描画を起こさない)。
 */
export function expandedAfterSelection(
  expanded: ReadonlySet<string>,
  rows: readonly InboxRow[],
  selection: InboxSelection | null,
): ReadonlySet<string> {
  const kind = groupKindOfSelection(rows, selection);
  if (kind === null || expanded.has(kind)) {
    return expanded;
  }
  return new Set([...expanded, kind]);
}
