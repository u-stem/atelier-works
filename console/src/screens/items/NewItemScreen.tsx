import { ArrowLeft } from "lucide-react";
import { useId, useState } from "react";
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
import { Field } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { cn } from "../../lib/cn.ts";
import { CHECKBOX_CLASS } from "../../lib/controlClasses.ts";
import { describeIntakeAttempt } from "../../lib/intakeAttempt.ts";
import {
  draftForm,
  fieldsAfterCount,
  type IntakeFields,
  restoreFields,
} from "../../lib/intakeFields.ts";
import {
  blocksImplicitSubmit,
  buildIntakeInput,
  defaultRepoText,
  describeIntakeProblem,
  INTAKE_TITLE_MAX_CHARS,
  type IntakeProblem,
  type IntakeProfile,
  PROFILE_OPTIONS,
  profileNotice,
  repoOptionLabel,
  submitLabel,
  titleLength,
} from "../../lib/manualIntake.ts";
import { apiErrorOf } from "../../lib/queryFailureView.ts";
import { useFocusFirstInvalid } from "../../lib/useFocusFirstInvalid.ts";
import { useManualIntake } from "./useManualIntake.ts";

/** 見出しの題の下に置く、一覧への戻りのリンク。 */
export function BackLink() {
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

/**
 * 進め方の選択。ネイティブのラジオを`fieldset`でまとめ、矢印キーで選べるようにする。
 * ラジオでのEnterは暗黙の送信になるので、止める。矢印キーで切り替えた直後に、確認なしで送らないためである。
 * 題名などの欄のEnterは従来どおり送信し、そのときも送信ボタンの文言が進め方を示す。
 */
function ProfileChoice({
  name,
  value,
  disabled,
  describedBy,
  onChange,
}: {
  name: string;
  value: IntakeProfile;
  disabled: boolean;
  describedBy: string | undefined;
  onChange: (profile: IntakeProfile) => void;
}) {
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
      aria-describedby={describedBy}
    >
      <legend className="mb-1.5 p-0 text-body font-medium">進め方</legend>
      {PROFILE_OPTIONS.map((option) => (
        <label
          key={option.value}
          className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2 has-[:checked]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            className={cn(CHECKBOX_CLASS, "mt-1")}
            onKeyDown={(event) => {
              if (blocksImplicitSubmit(event.key)) {
                event.preventDefault();
              }
            }}
            onChange={() => {
              onChange(option.value);
            }}
          />
          <span className="flex flex-col">
            <span className="text-body font-medium">{option.label}</span>
            <span className="text-small text-muted-foreground">
              {option.description}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
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
 * 新規投入の画面。リポジトリ、進め方、題名、目的、受入基準を入力して、`manual_intake`フローを起動する。
 * 承認を省く進め方を選ぶと、送信ボタンと注記がそれを示す。不具合の修正では、再現手順などの3欄を足す。
 * 承認を省く進め方を受け付けるかは、画面が知らずscriptが決める。画面は設定を読まない。
 * 候補は設定で許可されたリポジトリで、一覧に無いリポジトリも入力できる。許可の判定はscriptが行う。
 * 投入できなかったときと、投入されたか分からないときは、入力を残す。
 * 投入されたか分からないときは、確かめたと明示するまで再送のボタンを止める。
 * 入力の誤りで送信が止まったときは、最初の誤りの入力欄へフォーカスを移す。
 */
export function NewItemScreen() {
  const ids = useId();
  const targets = useIntakeTargets();
  const intake = useManualIntake();
  const focusInvalid = useFocusFirstInvalid();
  const { session } = intake;
  // 一覧へ移って戻っても、投入できた後を除いて、入力中か直近に送った入力欄の値を復元する。
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
    profile,
    reproduction,
    expectedBehavior,
    actualBehavior,
  } = reconciled.fields;
  const candidates = targets.data ?? [];
  const repoText = repo ?? defaultRepoText(candidates);
  // 入力のたびに、タブ全体の状態へ残す。サイドバーやパレットで別の画面へ移って戻っても、入力を失わない。
  const setField = (change: Partial<IntakeFields>) => {
    const next = { ...reconciled.fields, ...change };
    setTyped(next);
    intake.saveDraft(draftForm(next, repoText));
  };
  const form = {
    repo: repoText,
    title,
    body,
    acceptanceCriteria: acceptance,
    profile,
    reproduction,
    expectedBehavior,
    actualBehavior,
  };
  const notice = profileNotice(profile);
  const built = buildIntakeInput(form);
  const problems: readonly IntakeProblem[] =
    checked && !built.ok ? built.problems : [];
  const view = describeIntakeAttempt(session.attempt, session.form);
  const targetsError = targets.isError ? apiErrorOf(targets.error) : null;
  const targetsFailed =
    targets.isError && !(targetsError !== null && isBannerError(targetsError));

  const send = () => {
    setChecked(true);
    if (!built.ok) {
      focusInvalid.request();
      return;
    }
    if (!intake.blocked) {
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
          ref={focusInvalid.formRef}
          className="flex w-full max-w-[47.5rem] flex-col gap-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <Field
            label="リポジトリ"
            hint="「オーナー名/リポジトリ名」の形で入力します。候補に無いリポジトリも入力できますが、許可されていなければ断られます。"
            problem={problemOf(problems, "repo_invalid")}
          >
            {(control) => (
              <>
                <Input
                  {...control}
                  list={`${ids}-targets`}
                  value={repoText}
                  disabled={intake.locked}
                  autoComplete="off"
                  spellCheck={false}
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
              </>
            )}
          </Field>
          <ProfileChoice
            name={`${ids}-profile`}
            value={profile}
            disabled={intake.locked}
            describedBy={notice === null ? undefined : `${ids}-profile-notice`}
            onChange={(next) => {
              setField({ profile: next });
            }}
          />
          {notice === null ? null : (
            <p
              id={`${ids}-profile-notice`}
              className="-mt-3 text-small text-muted-foreground"
            >
              {notice}
            </p>
          )}
          <Field
            label="題名"
            hint={`${titleLength(title)} / ${INTAKE_TITLE_MAX_CHARS}字`}
            problem={problemOf(problems, "title_empty", "title_too_long")}
          >
            {(control) => (
              <Input
                {...control}
                value={title}
                disabled={intake.locked}
                onChange={(event) => {
                  setField({ title: event.target.value });
                }}
              />
            )}
          </Field>
          <Field
            label="目的"
            hint="何を実現したいかを書きます。Issueの本文になります。"
            problem={problemOf(problems, "body_empty")}
          >
            {(control) => (
              <Textarea
                {...control}
                rows={6}
                value={body}
                disabled={intake.locked}
                onChange={(event) => {
                  setField({ body: event.target.value });
                }}
              />
            )}
          </Field>
          {profile === "bugfix" ? (
            <>
              <Field
                label="再現手順"
                hint="不具合が起きるまでの手順を書きます。Issueの本文になります。"
                problem={problemOf(problems, "reproduction_empty")}
              >
                {(control) => (
                  <Textarea
                    {...control}
                    rows={4}
                    value={reproduction}
                    disabled={intake.locked}
                    onChange={(event) => {
                      setField({ reproduction: event.target.value });
                    }}
                  />
                )}
              </Field>
              <Field
                label="期待する動作"
                hint="本来どう動くべきかを書きます。受入基準の先頭になります。"
                problem={problemOf(problems, "expected_empty")}
              >
                {(control) => (
                  <Textarea
                    {...control}
                    rows={3}
                    value={expectedBehavior}
                    disabled={intake.locked}
                    onChange={(event) => {
                      setField({ expectedBehavior: event.target.value });
                    }}
                  />
                )}
              </Field>
              <Field
                label="実際の動作"
                hint="いま実際にどう動くかを書きます。Issueの本文になります。"
                problem={problemOf(problems, "actual_empty")}
              >
                {(control) => (
                  <Textarea
                    {...control}
                    rows={3}
                    value={actualBehavior}
                    disabled={intake.locked}
                    onChange={(event) => {
                      setField({ actualBehavior: event.target.value });
                    }}
                  />
                )}
              </Field>
            </>
          ) : null}
          <Field label="受入基準(任意)" hint="1行に1項目で書きます。">
            {(control) => (
              <Textarea
                {...control}
                rows={4}
                value={acceptance}
                disabled={intake.locked}
                onChange={(event) => {
                  setField({ acceptanceCriteria: event.target.value });
                }}
              />
            )}
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={intake.blocked}>
              {intake.locked ? "送信しています" : submitLabel(profile)}
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
