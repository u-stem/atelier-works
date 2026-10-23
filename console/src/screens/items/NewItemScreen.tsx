import { ArrowLeft } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Link } from "react-router";
import { isBannerError } from "../../api/errors.ts";
import { useIntakeTargets } from "../../api/intakeQueries.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { JobLink } from "../../components/JobLink.tsx";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { describeIntakeAttempt } from "../../lib/intakeAttempt.ts";
import {
  fieldsAfterCount,
  type IntakeFields,
  restoreFields,
} from "../../lib/intakeFields.ts";
import {
  buildIntakeInput,
  defaultRepoText,
  describeIntakeProblem,
  INTAKE_TITLE_MAX_CHARS,
  type IntakeProblem,
  repoOptionLabel,
  titleLength,
} from "../../lib/manualIntake.ts";
import { apiErrorOf } from "../../lib/queryFailureView.ts";
import { useManualIntake } from "./useManualIntake.ts";

function BackLink() {
  return (
    <Link
      to="/items"
      className="mt-1 inline-flex items-center gap-1 rounded-sm text-small text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft aria-hidden="true" className="size-3.5" />
      作業項目の一覧
    </Link>
  );
}

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

function problemOf(
  problems: readonly IntakeProblem[],
  ...kinds: IntakeProblem[]
): string | undefined {
  const found = problems.find((problem) => kinds.includes(problem));
  return found === undefined ? undefined : describeIntakeProblem(found);
}

/**
 * 新規投入の画面。リポジトリ、題名、目的、受入基準を入力して、`manual_intake`フローを起動する。
 * 候補は設定で許可されたリポジトリで、一覧に無いリポジトリも入力できる。許可の判定はscriptが行う。
 * 投入できなかったときと、投入されたか分からないときは、入力を残す。
 * 投入されたか分からないときは、確かめたと明示するまで再送のボタンを止める。
 */
export function NewItemScreen() {
  const ids = useId();
  const targets = useIntakeTargets();
  const intake = useManualIntake();
  const { session } = intake;
  // 一覧へ移って戻っても、投入できた後を除いて、直近に送った入力欄の値を復元する。
  const [typed, setTyped] = useState<IntakeFields>(() =>
    restoreFields(session),
  );
  const [seenCount, setSeenCount] = useState(session.clearedCount);
  const [checked, setChecked] = useState(false);
  // 表示中に保存した入力を消したとき(投入できた、破棄した)は、入力欄を空に戻す。
  const reconciled = fieldsAfterCount(typed, seenCount, session);
  if (reconciled.seenCount !== seenCount) {
    setSeenCount(reconciled.seenCount);
    setTyped(reconciled.fields);
    setChecked(false);
  }
  const {
    repo,
    title,
    body,
    acceptanceCriteria: acceptance,
  } = reconciled.fields;
  const setField = (change: Partial<IntakeFields>) => {
    setTyped({ ...reconciled.fields, ...change });
  };

  const candidates = targets.data ?? [];
  const repoText = repo ?? defaultRepoText(candidates);
  const form = { repo: repoText, title, body, acceptanceCriteria: acceptance };
  const built = buildIntakeInput(form);
  const problems: readonly IntakeProblem[] =
    checked && !built.ok ? built.problems : [];
  const view = describeIntakeAttempt(session.attempt, session.form);
  const targetsError = targets.isError ? apiErrorOf(targets.error) : null;
  const targetsFailed =
    targets.isError && !(targetsError !== null && isBannerError(targetsError));

  const send = () => {
    setChecked(true);
    if (built.ok && !intake.blocked) {
      intake.submit(form, built.input);
    }
  };

  return (
    <>
      <PageHeader title="新規投入" subtitle="Factoryにタスクを手動で投入します">
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
            hint="「オーナー名/リポジトリ名」の形で入力します。候補に無いリポジトリも入力できますが、許可されていなければ断られます。"
            problem={problemOf(problems, "repo_invalid")}
          >
            <Input
              id={`${ids}-repo`}
              list={`${ids}-targets`}
              value={repoText}
              disabled={intake.locked}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={problemOf(problems, "repo_invalid") !== undefined}
              onChange={(event) => {
                setField({ repo: event.target.value });
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
          <Field
            id={`${ids}-title`}
            label="題名"
            hint={`${titleLength(title)} / ${INTAKE_TITLE_MAX_CHARS}字`}
            problem={problemOf(problems, "title_empty", "title_too_long")}
          >
            <Input
              id={`${ids}-title`}
              value={title}
              disabled={intake.locked}
              aria-invalid={
                problemOf(problems, "title_empty", "title_too_long") !==
                undefined
              }
              onChange={(event) => {
                setField({ title: event.target.value });
              }}
            />
          </Field>
          <Field
            id={`${ids}-body`}
            label="目的"
            hint="何を実現したいかを書きます。Issueの本文になります。"
            problem={problemOf(problems, "body_empty")}
          >
            <Textarea
              id={`${ids}-body`}
              rows={6}
              value={body}
              disabled={intake.locked}
              aria-invalid={problemOf(problems, "body_empty") !== undefined}
              onChange={(event) => {
                setField({ body: event.target.value });
              }}
            />
          </Field>
          <Field
            id={`${ids}-acceptance`}
            label="受入基準(任意)"
            hint="1行に1項目で書きます。"
          >
            <Textarea
              id={`${ids}-acceptance`}
              rows={4}
              value={acceptance}
              disabled={intake.locked}
              onChange={(event) => {
                setField({ acceptanceCriteria: event.target.value });
              }}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={intake.blocked}>
              {intake.locked ? "送信しています" : "投入する"}
            </Button>
            {session.attempt.kind === "unknown" &&
            !session.attempt.resendConfirmed ? (
              <Button
                type="button"
                variant="outline"
                disabled={intake.locked}
                onClick={intake.confirmResend}
              >
                確かめたので再送する
              </Button>
            ) : null}
            {session.attempt.kind === "unknown" ? (
              <Button
                type="button"
                variant="outline"
                disabled={intake.locked}
                onClick={intake.discard}
              >
                投入されていたので入力を破棄する
              </Button>
            ) : null}
          </div>
          {session.stale && intake.locked ? (
            <Alert variant="warning">
              <AlertDescription>
                <p>
                  作業項目の一覧を読み直せませんでした。一覧が更新されるまで、送信は止まります。
                </p>
              </AlertDescription>
            </Alert>
          ) : null}
          {view === null ? null : (
            <Alert
              variant={
                view.tone === "error"
                  ? "destructive"
                  : view.tone === "warning"
                    ? "warning"
                    : "default"
              }
            >
              <AlertTitle>{view.headline}</AlertTitle>
              <AlertDescription>
                {view.lines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
                <JobLink jobId={view.flowJobId} label="投入のジョブを開く" />
              </AlertDescription>
            </Alert>
          )}
        </form>
      </div>
    </>
  );
}
