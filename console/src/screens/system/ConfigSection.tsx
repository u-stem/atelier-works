import { useState } from "react";
import type {
  ConfigItemView,
  ConfigSnapshotView,
  DesignStageView,
} from "../../api/jobsQueries.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { EmptyNote } from "../../components/EmptyNote.tsx";
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
import type { ConfigEntryValue } from "../../lib/configValue.ts";
import {
  CONFIG_REFERENCE_LABEL,
  describeConfigValue,
  describeDesignStage,
  filterConfigItems,
} from "../../lib/jobsView.ts";
import { safeText } from "../../lib/safeText.ts";
import { ConfigChangeDialog } from "./ConfigChangeDialog.tsx";
import { EmptyValue, TextValue } from "./ConfigText.tsx";
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
        <li key={`${index}:${text}`} className="break-all">
          <TextValue text={text} />
        </li>
      ))}
    </ul>
  );
}

/**
 * 同じ形のオブジェクトの配列。列の見出しを持つ表で、行が持たないキーのセルは「未設定」と出す。
 * 列の幅は内容に合わせ、長い名前はハイフンなどの切れ目で折る。
 * 切れ目の無い長い文字列で収まらない表は、表の中だけを横にスクロールする。
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
      <table className="w-full table-auto border-collapse text-small">
        <thead className="text-left text-muted-foreground">
          <tr>
            {columns.map((column, columnIndex) => (
              // 見えない文字だけが違う列は、`safeText`の後で同じ文字列になるので、位置を含めて見分ける。
              <th
                // biome-ignore lint/suspicious/noArrayIndexKey: 同じ文字列の列が並びうる。
                key={`${columnIndex}:${column}`}
                scope="col"
                className="py-1 pr-3 font-medium"
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
                  className="py-1 pr-3 align-top break-words"
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

/** オブジェクトのキーと値の行。値が配列なら、その中も行で並べる。 */
function ValueEntries({
  entries,
}: {
  entries: readonly { key: string; value: ConfigEntryValue }[];
}) {
  return (
    <dl className="flex flex-col gap-1.5 text-small">
      {entries.map(({ key, value }, index) => (
        // キーは`safeText`の後で重なりうるので、位置を含めて見分ける。並びは変わらない。
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: 同じ文字列のキーが並びうる。
          key={`${index}:${key}`}
          className="grid gap-0.5 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:gap-x-3"
        >
          <dt className="font-mono break-all">
            <TextValue text={safeText(key)} />
          </dt>
          <dd className="min-w-0">
            {value.kind === "list" ? (
              <ValueRows items={value.items} />
            ) : (
              <span className="break-all">
                <TextValue text={value.text} />
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

type SwitchOrNumberOffer = Extract<ChangeOffer, { kind: "stop" | "lower" }>;

function isSwitchOrNumberOffer(
  offer: ChangeOffer | undefined,
): offer is SwitchOrNumberOffer {
  return offer?.kind === "stop" || offer?.kind === "lower";
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
 * 設定の項目の一覧。キー、値の順に並べる。値はテキストのノードとして描く。
 * 参照と、伏せた値は、値を出さずに「参照(出さない)」と表示する。
 * `onChoose`を渡すと、止める向きか下げる向きに変えられる項目に、その操作のボタンを添える。
 * 一覧の3項目は、値の行を編集できる一覧にして、要素ごとの削除と一覧の追加のボタンを置く。
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
    <Card tag="dl" variant="list">
      {items.map((item) => {
        const offers = onChoose === undefined ? [] : changeOffersOf(item);
        const offer = offers[0];
        return (
          <div
            key={item.key}
            className="grid gap-1 px-4 py-2.5 text-small sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-x-4"
          >
            <dt className="font-mono break-all">{safeText(item.key)}</dt>
            {onChoose !== undefined &&
            EDITABLE_LISTS.includes(item.key) &&
            offers.length > 0 ? (
              <dd className="min-w-0 tabular-nums">
                <EditableListValue
                  item={item}
                  offers={offers}
                  isLocked={isLocked}
                  onChoose={onChoose}
                />
              </dd>
            ) : (
              <dd className="flex min-w-0 items-start justify-between gap-3 tabular-nums">
                <div className="min-w-0">
                  <ConfigValue item={item} />
                </div>
                {onChoose === undefined ||
                !isSwitchOrNumberOffer(offer) ? null : (
                  <ChangeButton
                    offer={offer}
                    locked={isLocked(offer)}
                    onChoose={onChoose}
                  />
                )}
              </dd>
            )}
          </div>
        );
      })}
    </Card>
  );
}

/**
 * 設計工程の、効いている値。一覧の値は書かれたままなので、実際に動くかはここで確かめる。
 * 書かれた値が無視されているときと、参照のため判定できないときは、その理由を添える。
 */
function DesignStageStatus({ stage }: { stage: DesignStageView }) {
  const text = describeDesignStage(stage);
  return (
    <Card padding="compact" className="flex flex-col gap-1 text-small">
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
