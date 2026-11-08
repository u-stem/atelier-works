import { Check, Minus } from "lucide-react";
import { useState } from "react";
import type {
  ConfigItemView,
  ConfigSnapshotView,
  DesignStageView,
} from "../../api/jobsQueries.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { EmptyNote } from "../../components/EmptyNote.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card } from "../../components/ui/card.tsx";
import { Field } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  type ChangeOffer,
  changeOffersOf,
  checkCommandsOf,
  EDITABLE_LISTS,
} from "../../lib/configChange.ts";
import { groupConfigItems } from "../../lib/configGroups.ts";
import type { ConfigEntryValue } from "../../lib/configValue.ts";
import {
  CONFIG_REFERENCE_LABEL,
  describeConfigValue,
  describeDesignStage,
  filterConfigItems,
} from "../../lib/jobsView.ts";
import { safeText } from "../../lib/safeText.ts";
import { ConfigChangeDialog } from "./ConfigChangeDialog.tsx";
import { EmptyValue, KeyText, TextValue } from "./ConfigText.tsx";
import { EditableListValue } from "./EditableListValue.tsx";
import { SystemSection } from "./SystemSection.tsx";
import { useConfigChange } from "./useConfigChange.ts";

function ConfigValue({ item }: { item: ConfigItemView }) {
  const value = describeConfigValue(item);
  switch (value.kind) {
    case "reference":
      return (
        <span className="text-muted-foreground">{CONFIG_REFERENCE_LABEL}</span>
      );
    case "scalar":
      return (
        <span className="break-words">
          <TextValue text={value.text} />
        </span>
      );
    case "boolean":
      return <SwitchBadge enabled={value.enabled} rawText={value.text} />;
    case "number":
      return <NumberValue text={value.text} unit={value.unit} />;
    case "empty":
      return <EmptyValue note={value.note} />;
    case "list":
      return <ValueRows items={value.items} />;
    case "table":
      return <ValueTable columns={value.columns} rows={value.rows} />;
    case "entries":
      return <ValueEntries entries={value.entries} />;
    case "structure":
      return (
        <pre className="font-mono text-small break-words whitespace-pre-wrap">
          {safeText(value.text)}
        </pre>
      );
  }
}

/**
 * 真偽。語(有効、無効)と記号(チェック、ハイフン)で示し、色だけに頼らない。
 * 有効は強調した枠、無効は薄い枠にする。成功や警告の色は使わない。
 * 慎重に入れる項目も同じ見た目になるので、有効を健全な状態と読ませないためである。
 * 書かれた値(true、false)は、読み上げにだけ残す。
 */
function SwitchBadge({
  enabled,
  rawText,
}: {
  enabled: boolean;
  rawText: string;
}) {
  const Mark = enabled ? Check : Minus;
  return (
    <Badge
      variant="outline"
      className={enabled ? "border-foreground/60 text-foreground" : undefined}
    >
      <Mark aria-hidden="true" />
      {enabled ? "有効" : "無効"}
      <span className="sr-only">({rawText})</span>
    </Badge>
  );
}

/**
 * 数値。左端を、文字列の値とそろえる。桁は等幅の数字にする。
 * 単位は数字の後ろに薄く添え、生の数字はそのまま読める。
 */
function NumberValue({ text, unit }: { text: string; unit: string | null }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="tabular-nums">{text}</span>
      {unit === null ? null : (
        <span className="text-caption text-muted-foreground">{unit}</span>
      )}
    </span>
  );
}

/** 要素ごとの1行。括弧とカンマを出さない。 */
function ValueRows({ items }: { items: readonly string[] }) {
  if (items.length === 0) {
    return <span className="text-muted-foreground">空です。</span>;
  }
  return (
    <ul className="flex flex-col gap-0.5 font-mono text-small">
      {items.map((text, index) => (
        // 要素は重なりうるので、位置を含めて見分ける。並びは変わらない。
        // biome-ignore lint/suspicious/noArrayIndexKey: 同じ文字列の要素が並びうる。
        <li key={`${index}:${text}`} className="break-words">
          <TextValue text={text} />
        </li>
      ))}
    </ul>
  );
}

/**
 * 同じ形のオブジェクトの配列。列の見出しを持つ表で、行が持たないキーのセルは「未設定」と出す。
 * 列の幅は内容に合わせ、長い名前はハイフンなどの切れ目で折る。
 * セルは`overflow-wrap:anywhere`にして、切れ目の無い長い文字列が表の最小幅を押し広げないようにする。
 * それでも収まらない表は、表の中だけを横にスクロールする。
 */
function ValueTable({
  columns,
  rows,
}: {
  columns: readonly string[];
  rows: readonly (readonly (string | null)[])[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="max-w-full table-auto border-collapse text-small">
        <thead className="text-left text-muted-foreground">
          <tr>
            {columns.map((column, columnIndex) => (
              // 見えない文字だけが違う列は、`safeText`の後で同じ文字列になるので、位置を含めて見分ける。
              <th
                // biome-ignore lint/suspicious/noArrayIndexKey: 同じ文字列の列が並びうる。
                key={`${columnIndex}:${column}`}
                scope="col"
                className="py-1 pr-6 font-medium"
              >
                <TextValue text={safeText(column)} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((cells, rowIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 行を見分けるキーが無く、並びは変わらない。
            <tr key={rowIndex}>
              {cells.map((cell, cellIndex) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: 同じ文字列の列が並びうる。
                  key={`${cellIndex}:${columns[cellIndex]}`}
                  className="min-w-[14ch] py-1 pr-6 align-top [overflow-wrap:anywhere]"
                >
                  {cell === null ? (
                    <span className="text-muted-foreground">未設定</span>
                  ) : (
                    <TextValue text={cell} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * オブジェクトのキーと値の行。
 * 値が配列のときは、キーを上の行、配列を下の行に字下げして積む。コマンドやURLが長くても、値の幅を使えるためである。
 * 値が文字列、数、真偽のときだけ、キーと値を横に並べる。キーの列は、値の列を圧迫しない幅にとどめる。
 */
function ValueEntries({
  entries,
}: {
  entries: readonly { key: string; value: ConfigEntryValue }[];
}) {
  return (
    // 横に並べるかは、一覧全体でなく、このセルの幅で決める。`td`は表のレイアウトを崩さないよう、包みの`div`にコンテナを付ける。
    <div className="@container">
      <dl className="flex flex-col gap-1.5 text-small">
        {entries.map(({ key, value }, index) => (
          // キーは`safeText`の後で重なりうるので、位置を含めて見分ける。並びは変わらない。
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 同じ文字列のキーが並びうる。
            key={`${index}:${key}`}
            className={
              value.kind === "list"
                ? "flex flex-col gap-0.5"
                : "grid gap-0.5 @md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] @md:gap-x-3"
            }
          >
            <dt className="font-mono break-words">
              <TextValue text={safeText(key)} />
            </dt>
            <dd
              className={
                value.kind === "list" ? "min-w-0 pl-4" : "min-w-0 pl-4 @md:pl-0"
              }
            >
              {value.kind === "list" ? (
                <ValueRows items={value.items} />
              ) : (
                <span className="break-words">
                  <TextValue text={value.text} />
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * 表の役割。狭い幅では`display:block`にして縦に積むが、ブラウザによっては、表の要素の`display`を替えると表の意味(役割)を落とす。
 * Chromiumでは、役割を外すと行の集まり(rowgroup)の一部が落ちることを確かめた。Safariでの欠落は未確認で、保険として明示する。
 * 見出しと行と列の結びつきを保つため、役割を明示する。
 * 広い幅の表の要素が持つ意味と重なるが、同じ役割なので、読み上げは二重にならない。
 * `noRedundantRoles`は、この意図を知らずに外させるので、属性を一括で渡して当てない。
 */
const ROLE = {
  table: { role: "table" },
  rowgroup: { role: "rowgroup" },
  row: { role: "row" },
  columnheader: { role: "columnheader" },
  rowheader: { role: "rowheader" },
  cell: { role: "cell" },
} as const;

type SwitchOrNumberOffer = Extract<ChangeOffer, { kind: "stop" | "lower" }>;

function isSwitchOrNumberOffer(
  offer: ChangeOffer | undefined,
): offer is SwitchOrNumberOffer {
  return offer?.kind === "stop" || offer?.kind === "lower";
}

/** 1つの項目の変更の候補。一覧の3項目は値の中のボタンになり、操作の列のボタンは持たない。 */
type RowOffers = {
  readonly offers: readonly ChangeOffer[];
  readonly editableList: boolean;
  /** 操作の列のボタン。無ければ`null`。 */
  readonly button: SwitchOrNumberOffer | null;
};

function rowOffersOf(
  item: ConfigItemView,
  onChoose: ((offer: ChangeOffer) => void) | undefined,
): RowOffers {
  const offers = onChoose === undefined ? [] : changeOffersOf(item);
  const editableList =
    onChoose !== undefined &&
    EDITABLE_LISTS.includes(item.key) &&
    offers.length > 0;
  const offer = offers[0];
  return {
    offers,
    editableList,
    button: !editableList && isSwitchOrNumberOffer(offer) ? offer : null,
  };
}

function ChangeButton({
  offer,
  locked,
  onChoose,
}: {
  offer: SwitchOrNumberOffer;
  locked: boolean;
  onChoose: (offer: ChangeOffer) => void;
}) {
  const verb = offer.kind === "stop" ? "止める" : "下げる";
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={locked}
      aria-label={`${safeText(offer.key)}を${verb}`}
      onClick={() => {
        onChoose(offer);
      }}
    >
      {verb}
    </Button>
  );
}

/**
 * 設定の項目の一覧。機能ごとのグループに分け、グループごとに、項目、値、操作の列を持つ表にする。
 * どのグループにも入らない項目は、最後の「その他」に出す。値はテキストのノードとして描く。
 * 参照と、伏せた値は、値を出さずに「参照(出さない)」と表示する。
 * `onChoose`を渡すと、止める向きか下げる向きに変えられる項目に、操作の列のボタンを添える。
 * 操作の列は、ボタンを持つ項目があるグループだけに出す。
 * 一覧の3項目は、値の行を編集できる一覧にして、要素ごとの削除と一覧の追加のボタンを値の中に置く。
 * ボタンは確認のダイアログを開くだけで、書き込みは確認を通った後にだけ呼ぶ。
 */
export function ConfigList({
  items,
  onChoose,
  isLocked = () => false,
}: {
  items: readonly ConfigItemView[];
  onChoose?: (offer: ChangeOffer) => void;
  isLocked?: (offer: ChangeOffer) => boolean;
}) {
  if (items.length === 0) {
    return <EmptyNote>該当する項目はありません。</EmptyNote>;
  }
  return (
    <div className="@container flex flex-col gap-5">
      {groupConfigItems(items).map((group) => (
        <ConfigGroupTable
          key={group.id}
          id={group.id}
          label={group.label}
          items={group.items}
          onChoose={onChoose}
          isLocked={isLocked}
        />
      ))}
    </div>
  );
}

/**
 * 1つの項目の行。キーは行の見出し、値は型ごとの表示、操作の列は止めるか下げるのボタンである。
 * 一覧の追加と削除のボタンは、値の中にあるので、操作の列には置かない。
 * 狭い幅では`display`を変えて縦に積むので、表の役割は`role`で明示する。
 */
function ConfigRow({
  item,
  onChoose,
  isLocked,
  showOperation,
}: {
  item: ConfigItemView;
  onChoose: ((offer: ChangeOffer) => void) | undefined;
  isLocked: (offer: ChangeOffer) => boolean;
  showOperation: boolean;
}) {
  const { offers, editableList, button } = rowOffersOf(item, onChoose);
  return (
    <tr {...ROLE.row} className="block @min-[40rem]:table-row">
      <th
        scope="row"
        {...ROLE.rowheader}
        className="block px-4 pt-2.5 pb-1 text-left align-top font-mono font-normal break-words @min-[40rem]:table-cell @min-[40rem]:py-2.5"
      >
        <KeyText text={safeText(item.key)} />
      </th>
      <td
        {...ROLE.cell}
        className="block min-w-0 px-4 pb-2.5 align-top tabular-nums @min-[40rem]:table-cell @min-[40rem]:py-2.5"
      >
        {editableList && onChoose !== undefined ? (
          <EditableListValue
            item={item}
            offers={offers}
            isLocked={isLocked}
            onChoose={onChoose}
          />
        ) : (
          <ConfigValue item={item} />
        )}
      </td>
      {showOperation ? (
        <td
          {...ROLE.cell}
          className="block px-4 align-top @min-[40rem]:table-cell @min-[40rem]:px-2 @min-[40rem]:py-2.5 @min-[40rem]:text-right"
        >
          {button === null || onChoose === undefined ? null : (
            <div className="pb-2.5 @min-[40rem]:-my-1.5 @min-[40rem]:pb-0">
              <ChangeButton
                offer={button}
                locked={isLocked(button)}
                onChoose={onChoose}
              />
            </div>
          )}
        </td>
      ) : null}
    </tr>
  );
}

/**
 * 1つのグループの表。見出し(h3)が表の名前になる。
 * 見出しは区画(landmark)にせず、表の`aria-labelledby`で結ぶ。グループの数だけ区画が並ぶのを避けるためである。
 * 狭い幅では、表をやめて項目ごとに縦に積む。
 * 操作の列は、操作の列のボタンを持つ項目があるときだけ出し、無ければ値の列が幅を使う。
 */
function ConfigGroupTable({
  id,
  label,
  items,
  onChoose,
  isLocked,
}: {
  id: string;
  label: string;
  items: readonly ConfigItemView[];
  onChoose: ((offer: ChangeOffer) => void) | undefined;
  isLocked: (offer: ChangeOffer) => boolean;
}) {
  const headingId = `config-group-${id}`;
  const showOperation = items.some(
    (item) => rowOffersOf(item, onChoose).button !== null,
  );
  return (
    <div className="flex flex-col gap-2">
      <h3 id={headingId} className="text-small font-semibold">
        {label}
      </h3>
      <Card className="overflow-hidden text-small">
        <table
          {...ROLE.table}
          aria-labelledby={headingId}
          className="block w-full border-collapse @min-[40rem]:table @min-[40rem]:table-fixed"
        >
          <colgroup>
            <col className="@min-[40rem]:w-56 @min-[48rem]:w-64 @min-[56rem]:w-76" />
            <col />
            {showOperation ? <col className="@min-[40rem]:w-20" /> : null}
          </colgroup>
          <thead
            {...ROLE.rowgroup}
            className="sr-only @min-[40rem]:not-sr-only @min-[40rem]:table-header-group"
          >
            <tr
              {...ROLE.row}
              className="border-b border-border text-left text-muted-foreground"
            >
              <th
                scope="col"
                {...ROLE.columnheader}
                className="px-4 py-2 font-medium"
              >
                項目
              </th>
              <th
                scope="col"
                {...ROLE.columnheader}
                className="px-4 py-2 font-medium"
              >
                値
              </th>
              {showOperation ? (
                <th
                  scope="col"
                  {...ROLE.columnheader}
                  className="px-2 py-2 text-right font-medium"
                >
                  操作
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody
            {...ROLE.rowgroup}
            className="block divide-y divide-border @min-[40rem]:table-row-group"
          >
            {items.map((item) => (
              <ConfigRow
                key={item.key}
                item={item}
                onChoose={onChoose}
                isLocked={isLocked}
                showOperation={showOperation}
              />
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/**
 * 設計工程の、効いている値。一覧の値は書かれたままなので、実際に動くかはここで確かめる。
 * 書かれた値が無視されているときと、参照のため判定できないときは、その理由を添える。
 */
function DesignStageStatus({ stage }: { stage: DesignStageView }) {
  const text = describeDesignStage(stage);
  return (
    <Card
      padding="compact"
      className="flex max-w-3xl flex-col gap-1 text-small"
    >
      <p>
        <span className="text-muted-foreground">設計工程: </span>
        <span className="font-medium">{safeText(text.state)}</span>
      </p>
      {text.note === null ? null : (
        <p className="text-muted-foreground">{safeText(text.note)}</p>
      )}
    </Card>
  );
}

function ConfigBody({
  items,
  designStage,
}: {
  items: readonly ConfigItemView[];
  designStage: DesignStageView | undefined;
}) {
  const [query, setQuery] = useState("");
  const change = useConfigChange();
  return (
    <div className="flex flex-col gap-3">
      {designStage === undefined ? null : (
        <DesignStageStatus stage={designStage} />
      )}
      <Field tone="filter" label="キー名で絞り込む" className="max-w-sm">
        {(control) => (
          <Input
            {...control}
            type="search"
            value={query}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        )}
      </Field>
      <ConfigList
        items={filterConfigItems(items, query)}
        onChoose={change.choose}
        isLocked={change.isLocked}
      />
      <ConfigChangeDialog
        offer={change.offer}
        text={change.text}
        checkCommands={checkCommandsOf(items)}
        onTextChange={change.setText}
        onConfirm={change.confirm}
        onCancel={change.dismiss}
      />
    </div>
  );
}

/**
 * 設定のタブの節。factory_configの全項目を読む。許可した項目だけ、止める向きか下げる向きに変えるか、一覧の要素を追加か削除できる。
 * 見出しは、タブの名前と重なるので、画面には出さない。
 * 取得は画面が持つ。値は、補間しない生の値で読んだものである。
 */
export function ConfigSection({
  query,
}: {
  query: SectionQuery<ConfigSnapshotView>;
}) {
  return (
    <SystemSection
      id="config-heading"
      title="設定"
      visuallyHiddenTitle
      wide
      description="factory_configの全項目です。参照と伏せた値は「参照(出さない)」と表示します。許可した項目だけ、止める向きと下げる向きの変更と、一覧の追加と削除ができます。"
      query={query}
      loginHint="上のバナーからログインすると、設定を表示します。"
    >
      {(data) => (
        <ConfigBody items={data.items} designStage={data.design_stage} />
      )}
    </SystemSection>
  );
}
