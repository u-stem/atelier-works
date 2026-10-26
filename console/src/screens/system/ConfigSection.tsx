import { useState } from "react";
import type {
  ConfigItemView,
  ConfigSnapshotView,
} from "../../api/jobsQueries.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { Input } from "../../components/ui/input.tsx";
import {
  CONFIG_REFERENCE_LABEL,
  describeConfigValue,
  filterConfigItems,
} from "../../lib/jobsView.ts";
import { EmptyNote, SystemSection } from "./SystemSection.tsx";

function ConfigValue({ item }: { item: ConfigItemView }) {
  const value = describeConfigValue(item);
  switch (value.kind) {
    case "reference":
      return (
        <span className="text-muted-foreground">{CONFIG_REFERENCE_LABEL}</span>
      );
    case "scalar":
      return <span className="break-words">{value.text}</span>;
    case "structure":
      return (
        <pre className="font-mono text-small break-words whitespace-pre-wrap">
          {value.text}
        </pre>
      );
  }
}

/**
 * 設定の項目の一覧。キー、値の順に並べる。値はテキストのノードとして描く。
 * 参照と、伏せた値は、値を出さずに「参照(出さない)」と表示する。
 */
export function ConfigList({ items }: { items: readonly ConfigItemView[] }) {
  if (items.length === 0) {
    return <EmptyNote>該当する項目はありません。</EmptyNote>;
  }
  return (
    <dl className="divide-y divide-border rounded-xl border border-border bg-card">
      {items.map((item) => (
        <div
          key={item.key}
          className="grid gap-1 px-4 py-2.5 text-small sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-x-4"
        >
          <dt className="font-mono break-all">{item.key}</dt>
          <dd className="min-w-0 tabular-nums">
            <ConfigValue item={item} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ConfigBody({ items }: { items: readonly ConfigItemView[] }) {
  const [query, setQuery] = useState("");
  return (
    <div className="flex flex-col gap-3">
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
      <ConfigList items={filterConfigItems(items, query)} />
    </div>
  );
}

/**
 * 設定のタブの節。factory_configの全項目を読むだけで、変更はできない。
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
      description="factory_configの全項目です。参照と伏せた値は「参照(出さない)」と表示します。変更はここではできません。"
      query={query}
      loginHint="上のバナーからログインすると、設定を表示します。"
    >
      {(data) => <ConfigBody items={data.items} />}
    </SystemSection>
  );
}
