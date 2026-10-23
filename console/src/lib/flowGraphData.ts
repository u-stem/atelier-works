import flowGraphJson from "../generated/flow-graph.json";
import { parseFlowGraph } from "./flowGraph.ts";

/**
 * バンドルに取り込んだ起動関係のデータ。形が違えばnullになる。
 * JSONは`scripts/docs-gen.ts`が生成し、CIが古さを検査する。
 */
export const FLOW_GRAPH = parseFlowGraph(flowGraphJson);
