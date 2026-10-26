import { useMemo, useState } from "react";
import { Disclosure } from "../../components/Disclosure.tsx";
import { DrawioFrame } from "../../components/drawio/DrawioFrame.tsx";
import type { FlowGraph } from "../../lib/flowGraph.ts";
import { flowGraphToDrawioXml } from "../../lib/flowGraphXml.ts";

/**
 * 起動の関係の節。スケジュール、script、flow、人の操作が何を起動するかを図にする。
 * データはバンドルに取り込んだ静的なJSONで、取得も実行状態の重ね合わせも無い。
 * そのため`SystemSection`(取得の状態を持つ節)は使わず、同じ見た目の見出しだけを持つ。
 * 図は重く、普段は読まないので、たたんで置く。開いたときに初めて描画し、一度描いた後は閉じても残す。
 * 図の幅は広いので、ほかの節より広く取る。
 */
export function FlowGraphSection({
  graph,
  initiallyOpen,
}: {
  graph: FlowGraph | null;
  initiallyOpen?: boolean | undefined;
}) {
  const [opened, setOpened] = useState(initiallyOpen === true);
  // 再描画のたびに組み立て直すと、DrawioFrameがXMLの変更とみなしてiframeを作り直す。
  const xml = useMemo(
    () => (graph === null ? null : flowGraphToDrawioXml(graph)),
    [graph],
  );
  return (
    <section
      aria-labelledby="flow-graph-heading"
      className="flex max-w-5xl flex-col gap-3"
    >
      <div className="min-w-0">
        <h2
          id="flow-graph-heading"
          tabIndex={-1}
          className="scroll-mt-4 rounded-sm text-lead font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          起動の関係
        </h2>
        <div className="text-small text-muted-foreground">
          スケジュール、script、flow、人の操作が、何を起動するかを示します。
          実線の矢印はscriptがflowを起動する関係、破線の矢印は時刻や人の操作による起動、点線の矢印はflowが実行するステップです。
          scriptからscriptの起動は含みません。
          たとえばself_updateがauto_retry_stale_imageを起動する関係は、図に出ません。
          コードから読み取った構造で、実行の状態は示しません。
        </div>
      </div>
      {xml === null ? (
        <p className="rounded-xl border border-border bg-card p-5 text-small text-muted-foreground">
          起動の関係のデータを読み込めませんでした。
        </p>
      ) : (
        <Disclosure
          summary="図を表示"
          initiallyOpen={initiallyOpen === true}
          onToggle={(open) => {
            if (open) {
              setOpened(true);
            }
          }}
        >
          {opened ? <DrawioFrame xml={xml} title="起動の関係の図" /> : null}
        </Disclosure>
      )}
    </section>
  );
}
