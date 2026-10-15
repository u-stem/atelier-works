import { isWorkerLoad } from "../../api/guards/workerLoad.ts";
import { describeWorkerLoad } from "../../lib/workerLoadView.ts";
import { EmptyNote } from "./SystemSection.tsx";

/**
 * defaultのworkerの負荷。直近24時間の枠の使用、queueの待ち、メモリを出す。
 * 値は数だけで、外部の文字列を含まない。
 * 負荷を返す前のbackendの応答では`undefined`になるので、記録なしと同じに扱う。
 * 形が違う値は、このカードだけを「読めない」にし、画面の他の節は出す。
 */
export function WorkerLoadCard({ load }: { load: unknown }) {
  if (load === null || load === undefined) {
    return (
      <EmptyNote>
        直近24時間の記録がないか、集計を読めませんでした。sample_worker_loadのスケジュールが有効かと、console_queryのジョブログの警告を確かめてください
      </EmptyNote>
    );
  }
  if (!isWorkerLoad(load)) {
    return (
      <EmptyNote>
        workerの負荷の応答の形が想定と違うため、表示できません。ConsoleとFactoryの版がそろっているかを確かめてください
      </EmptyNote>
    );
  }
  const view = describeWorkerLoad(load);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-small text-muted-foreground">{view.coverage}</p>
      <dl className="divide-y divide-border rounded-xl border border-border bg-card">
        {view.rows.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[12rem_1fr] items-baseline gap-x-4 px-5 py-3"
          >
            <dt className="text-small text-subtle">{row.label}</dt>
            <dd className="min-w-0 text-body break-words text-foreground tabular-nums">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
