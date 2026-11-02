import { type ReactNode, useId, useMemo, useState } from "react";
import { isBannerError } from "../../api/errors.ts";
import { useIntakeTargets } from "../../api/intakeQueries.ts";
import { useWriteMutation } from "../../api/mutations.ts";
import { prReviewConfig } from "../../api/prReviewConfig.ts";
import type { PrReviewSubmitInput } from "../../api/writes.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { repoOptionLabel } from "../../lib/manualIntake.ts";
import {
  buildPrReviewInput,
  describePrReviewProblem,
  EMPTY_PR_REVIEW_FORM,
  type PrReviewForm,
  type PrReviewProblem,
} from "../../lib/prReviewInput.ts";
import {
  attemptFromOutcome,
  type PrReviewAttempt,
  submitControl,
} from "../../lib/prReviewOutcome.ts";
import { apiErrorOf } from "../../lib/queryFailureView.ts";
import { BackLink } from "./NewItemScreen.tsx";
import { PrReviewAttemptNotice, PrReviewResult } from "./PrReviewResult.tsx";

/** 共有のロックの状態を引くための入力。キーは入力によらず固定なので、値は使われない。 */
const NO_INPUT: PrReviewSubmitInput = { owner: "", repo: "", prNumber: 0 };

function Field({
  id,
  label,
  hint,
  problem,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  problem?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-body font-medium">
        {label}
      </label>
      {children}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-small text-muted-foreground">
          {hint}
        </p>
      )}
      {problem === undefined ? null : (
        <p id={`${id}-problem`} className="text-small text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

function problemFor(
  problem: PrReviewProblem | null,
  field: "repo" | "pr",
): string | undefined {
  if (problem === null) {
    return undefined;
  }
  const isRepoProblem = problem === "repo_invalid";
  return isRepoProblem === (field === "repo")
    ? describePrReviewProblem(problem)
    : undefined;
}

/**
 * PRレビューの投入の画面。リポジトリとPRの番号かURLを入力して、PRのレビューを始める。
 * 候補は設定で許可されたリポジトリで、一覧に無いリポジトリも入力できる。許可の判定はscriptが行う。
 * リポジトリ欄は空から始め、PRのURLを入力したときは、URLのリポジトリを使う。
 * 結果と入力はこの画面の中だけに持つ。画面を離れると失うが、同じPRのレビューは重複して始まらない。
 * 投入できても、レビューが始まったかは、投入したフローのジョブの結果で分かる。結果を待つ間は、次の投入を止める。
 */
export function NewPrReviewScreen() {
  const ids = useId();
  const targets = useIntakeTargets();
  const [form, setForm] = useState<PrReviewForm>(EMPTY_PR_REVIEW_FORM);
  const [checked, setChecked] = useState(false);
  const [attempt, setAttempt] = useState<PrReviewAttempt | null>(null);
  const [waiting, setWaiting] = useState(false);
  const config = useMemo(
    () =>
      prReviewConfig({
        onOutcome: (outcome) => {
          setAttempt(attemptFromOutcome(outcome));
        },
      }),
    [],
  );
  const mutation = useWriteMutation(config);
  const control = submitControl({
    locked: mutation.isLocked(NO_INPUT),
    waiting,
  });

  const candidates = targets.data ?? [];
  const built = buildPrReviewInput(form);
  const problem = checked && !built.ok ? built.problem : null;
  const repoProblem = problemFor(problem, "repo");
  const prProblem = problemFor(problem, "pr");
  const targetsError = targets.isError ? apiErrorOf(targets.error) : null;
  const targetsFailed =
    targets.isError && !(targetsError !== null && isBannerError(targetsError));

  const send = () => {
    setChecked(true);
    if (!built.ok || control.disabled) {
      return;
    }
    // 始められたときだけ、前の結果を消す。
    if (mutation.submit(built.input)) {
      setAttempt(null);
    }
  };

  return (
    <>
      <PageHeader
        title="PRレビューの投入"
        subtitle="既存のPRを指定して、レビューを始めます"
      >
        <BackLink />
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 md:px-8">
        <form
          className="flex w-full max-w-[47.5rem] flex-col gap-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <Field
            id={`${ids}-repo`}
            label="リポジトリ"
            hint="「オーナー名/リポジトリ名」の形で入力します。PRのURLを入力するときは、空のままでも構いません。候補に無いリポジトリも入力できますが、許可されていなければ断られます。"
            problem={repoProblem}
          >
            <Input
              id={`${ids}-repo`}
              list={`${ids}-targets`}
              value={form.repo}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={repoProblem !== undefined}
              onChange={(event) => {
                setForm({ ...form, repo: event.target.value });
              }}
            />
            <datalist id={`${ids}-targets`}>
              {candidates.map((target) => (
                <option
                  key={repoOptionLabel(target)}
                  value={repoOptionLabel(target)}
                />
              ))}
            </datalist>
            {targetsFailed ? (
              <p className="text-small text-muted-foreground">
                候補を取得できませんでした。リポジトリを直接入力してください。
              </p>
            ) : null}
          </Field>
          <Field id={`${ids}-pr`} label="PRの番号またはURL" problem={prProblem}>
            <Input
              id={`${ids}-pr`}
              value={form.pr}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={prProblem !== undefined}
              onChange={(event) => {
                setForm({ ...form, pr: event.target.value });
              }}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={control.disabled}>
              {control.label}
            </Button>
          </div>
          {attempt !== null && attempt.kind === "submitted" ? (
            <PrReviewResult
              key={attempt.flowJobId}
              flowJobId={attempt.flowJobId}
              onWaitingChange={setWaiting}
            />
          ) : null}
          {attempt === null ? null : (
            <PrReviewAttemptNotice attempt={attempt} />
          )}
        </form>
      </div>
    </>
  );
}
