import { DrawioFrame } from "../../components/drawio/DrawioFrame.tsx";
import type { FlowGraph } from "../../lib/flowGraph.ts";
import { flowGraphToDrawioXml } from "../../lib/flowGraphXml.ts";

/**
 * 起動の関係の節。スケジュール、script、flow、人の操作が何を起動するかを図にする。
 * データはバンドルに取り込んだ静的なJSONで、取得も実行状態の重ね合わせも無い。
 * そのため`SystemSection`(取得の状態を持つ節)は使わず、同じ見た目の見出しだけを持つ。
 * 図の幅は広いので、ほかの節より広く取る。
 */
export function FlowGraphSection({ graph }: { graph: FlowGraph | null }) {
  return (
    <section
      aria-labelledby="flow-graph-heading"
      className="flex max-w-5xl flex-col gap-3"
    >
      <div className="min-w-0">
        <h2 id="flow-graph-heading" className="text-lead font-semibold">
          起動の関係
        </h2>
        <div className="text-small text-muted-foreground">
          スケジュール、script、flow、人の操作が、何を起動するかを示します。
          実線の矢印はscriptがflowを起動する関係、破線の矢印は時刻や人の操作による起動、点線の矢印はflowが実行するステップです。
          コードから読み取った構造で、実行の状態は示しません。
        </div>
      </div>
      {graph === null ? (
        <p className="rounded-xl border border-border bg-card p-5 text-small text-muted-foreground">
          起動の関係のデータを読み込めませんでした。
        </p>
      ) : (
        <DrawioFrame xml={flowGraphToDrawioXml(graph)} title="起動の関係の図" />
      )}
    </section>
  );
}
