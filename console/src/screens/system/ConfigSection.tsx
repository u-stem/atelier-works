import { useState } from "react";
import type {
  ConfigItemView,
  ConfigSnapshotView,
  DesignStageView,
} from "../../api/jobsQueries.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { type ChangeOffer, changeOfferOf } from "../../lib/configChange.ts";
import {
  CONFIG_REFERENCE_LABEL,
  describeConfigValue,
  describeDesignStage,
  filterConfigItems,
} from "../../lib/jobsView.ts";
import { safeText } from "../../lib/safeText.ts";
import { ConfigChangeDialog } from "./ConfigChangeDialog.tsx";
import { EmptyNote, SystemSection } from "./SystemSection.tsx";
import { useConfigChange } from "./useConfigChange.ts";

function ConfigValue({ item }: { item: ConfigItemView }) {
  const value = describeConfigValue(item);
  switch (value.kind) {
    case "reference":
      return (
        <span className="text-muted-foreground">{CONFIG_REFERENCE_LABEL}</span>
      );
    case "scalar":
      return <span className="break-words">{safeText(value.text)}</span>;
    case "structure":
      return (
        <pre className="font-mono text-small break-words whitespace-pre-wrap">
          {safeText(value.text)}
        </pre>
      );
  }
}

function ChangeButton({
  offer,
  locked,
  onChoose,
}: {
  offer: ChangeOffer;
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
    <dl className="divide-y divide-border rounded-xl border border-border bg-card">
      {items.map((item) => {
        const offer = onChoose === undefined ? null : changeOfferOf(item);
        return (
          <div
            key={item.key}
            className="grid gap-1 px-4 py-2.5 text-small sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-x-4"
          >
            <dt className="font-mono break-all">{safeText(item.key)}</dt>
            <dd className="flex min-w-0 items-start justify-between gap-3 tabular-nums">
              <div className="min-w-0">
                <ConfigValue item={item} />
              </div>
              {offer === null || onChoose === undefined ? null : (
                <ChangeButton
                  offer={offer}
                  locked={isLocked(offer)}
                  onChoose={onChoose}
                />
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * 設計工程の、効いている値。一覧の値は書かれたままなので、実際に動くかはここで確かめる。
 * 書かれた値が無視されているときと、参照のため判定できないときは、その理由を添える。
 */
function DesignStageStatus({ stage }: { stage: DesignStageView }) {
  const text = describeDesignStage(stage);
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-card px-4 py-2.5 text-small">
      <p>
        <span className="text-muted-foreground">設計工程: </span>
        <span className="font-medium">{safeText(text.state)}</span>
      </p>
      {text.note === null ? null : (
        <p className="text-muted-foreground">{safeText(text.note)}</p>
      )}
    </div>
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
      <div className="flex max-w-sm flex-col gap-1">
        <label
          htmlFor="config-search"
          className="text-small text-muted-foreground"
        >
          キー名で絞り込む
        </label>
        <Input
          id="config-search"
          type="search"
          value={query}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>
      <ConfigList
        items={filterConfigItems(items, query)}
        onChoose={change.choose}
        isLocked={change.isLocked}
      />
      <ConfigChangeDialog
        offer={change.offer}
        text={change.text}
        onTextChange={change.setText}
        onConfirm={change.confirm}
        onCancel={change.dismiss}
      />
    </div>
  );
}

/**
 * 設定のタブの節。factory_configの全項目を読む。許可した項目だけ、止める向きか下げる向きに変えられる。
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
      description="factory_configの全項目です。参照と伏せた値は「参照(出さない)」と表示します。止める向きと下げる向きの変更だけ、許可した項目でできます。"
      query={query}
      loginHint="上のバナーからログインすると、設定を表示します。"
    >
      {(data) => (
        <ConfigBody items={data.items} designStage={data.design_stage} />
      )}
    </SystemSection>
  );
}
