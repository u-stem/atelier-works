// CIの失敗が、CI回のClaudeにソースを編集させて直せる種類かを、ジョブの名前と結論から決める純関数。
// ジョブ名は外部由来の文字列なので、判定には正規化した名前を使い、表示には無害化して長さを制限した名前を使う。
// 判断できないものは「直せない」側に倒す。

import { sanitizeExternalName } from "./ci_log_support.ts";

/** `sanitizeRunName`が、空の名前に代わりに返す文字列。 */
const UNNAMED_DISPLAY_NAME = "(unnamed)";

/** 分類に使うジョブの事実。`T`の他の項目(IDなど)は、そのまま呼び出し側に返す。 */
export type CiJobFacts = {
  readonly name: string;
  readonly conclusion: string | null;
};

/** 失敗(`failure`)以外で、ジョブを直せない結論。`unknown`は未知の文字列か結論が無い場合。 */
export type CiOtherConclusion =
  | "cancelled"
  | "timed_out"
  | "startup_failure"
  | "action_required"
  | "stale"
  | "unknown";

const OTHER_CONCLUSIONS: readonly CiOtherConclusion[] = [
  "cancelled",
  "timed_out",
  "startup_failure",
  "action_required",
  "stale",
];

/** 失敗していないとみなす結論。 */
const NON_FAILURE_CONCLUSIONS: readonly string[] = [
  "success",
  "skipped",
  "neutral",
];

/**
 * 分類の結果。
 * - `fixable`: 失敗したジョブがすべてソースの編集で直せる種類。`jobs`は失敗したジョブ。
 * - `unfixable_job`: ソースの編集では直せないジョブが失敗した。
 *   `metadata_job`は`generate-metadata`で直す種類、`unnamed_job`は名前が無く種類を決められない。
 * - `other_conclusion`: `failure`以外の結論。一時的な原因のことがあり、再実行や待ちで変わりうる。
 * - `no_failure`: 失敗したジョブが無い。
 * 複数のジョブが当たるときは、`unfixable_job`、`other_conclusion`、`fixable`の順に優先する。
 * 直せない失敗が混ざったまま一部だけを直しても、CIは通らないため。
 */
export type CiFailureClass<T extends CiJobFacts> =
  | { readonly kind: "fixable"; readonly jobs: readonly T[] }
  | {
      readonly kind: "unfixable_job";
      readonly reason: "metadata_job" | "unnamed_job";
      /** 表示用に無害化し、長さを制限した名前。 */
      readonly jobName: string;
    }
  | {
      readonly kind: "other_conclusion";
      readonly conclusion: CiOtherConclusion;
      readonly jobName: string;
    }
  | { readonly kind: "no_failure" };

/**
 * 判定用の名前。表示用の名前から、互換文字を畳み、小文字にして前後の空白を除く。
 * 名前が空のときは空文字を返す。
 */
function comparableName(raw: string): string {
  const shown = sanitizeExternalName(raw);
  if (shown === UNNAMED_DISPLAY_NAME) return "";
  return shown.normalize("NFKC").toLowerCase().trim();
}

/** `generate-metadata`で直すジョブか。名前が`metadata`で始まるものをすべて含める。 */
function isMetadataJob(comparable: string): boolean {
  return comparable.startsWith("metadata");
}

type JobVerdict =
  | { readonly kind: "ignored" }
  | { readonly kind: "failure" }
  | {
      readonly kind: "unfixable_job";
      readonly reason: "metadata_job" | "unnamed_job";
    }
  | {
      readonly kind: "other_conclusion";
      readonly conclusion: CiOtherConclusion;
    };

function judgeJob(job: CiJobFacts): JobVerdict {
  const { conclusion } = job;
  if (conclusion !== null && NON_FAILURE_CONCLUSIONS.includes(conclusion)) {
    return { kind: "ignored" };
  }
  if (conclusion === "failure") {
    const comparable = comparableName(job.name);
    if (comparable === "")
      return { kind: "unfixable_job", reason: "unnamed_job" };
    if (isMetadataJob(comparable)) {
      return { kind: "unfixable_job", reason: "metadata_job" };
    }
    return { kind: "failure" };
  }
  const known = OTHER_CONCLUSIONS.find((candidate) => candidate === conclusion);
  return { kind: "other_conclusion", conclusion: known ?? "unknown" };
}

/**
 * 実行のジョブを分類する。結論が`failure`のジョブの名前から「ソースの編集で直せるか」を決める。
 * `metadata`で始まるジョブと、名前が空(不可視文字だけを含む)のジョブは直せない種類にする。
 * それ以外の`failure`(`check`など)は直せる種類にする。
 * `failure`以外の結論(`cancelled`、`timed_out`、`startup_failure`など)は、結論で区別して返す。
 */
export function classifyCiFailure<T extends CiJobFacts>(
  jobs: readonly T[],
): CiFailureClass<T> {
  const failed: T[] = [];
  let unfixable: CiFailureClass<T> | null = null;
  let other: CiFailureClass<T> | null = null;
  for (const job of jobs) {
    const verdict = judgeJob(job);
    if (verdict.kind === "failure") {
      failed.push(job);
    } else if (verdict.kind === "unfixable_job") {
      unfixable ??= {
        kind: "unfixable_job",
        reason: verdict.reason,
        jobName: sanitizeExternalName(job.name),
      };
    } else if (verdict.kind === "other_conclusion") {
      other ??= {
        kind: "other_conclusion",
        conclusion: verdict.conclusion,
        jobName: sanitizeExternalName(job.name),
      };
    }
  }
  if (unfixable !== null) return unfixable;
  if (other !== null) return other;
  if (failed.length > 0) return { kind: "fixable", jobs: failed };
  return { kind: "no_failure" };
}
