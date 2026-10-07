// 承認の判断を記録するときの承認者を、ジョブの実行コンテキストから導く。
// 承認依頼の全種別(requirements、issue_proposalなど)の判断を記録する
// `approval_decide.ts`が使う。

export type ApproverEnv = {
  readonly WM_USERNAME?: string | undefined;
  readonly WM_EMAIL?: string | undefined;
};

/**
 * 承認者の識別子を、ジョブ自身のWindmill実行コンテキストから返す。
 * 呼び出し側が渡す引数は識別子として信用できないため使わない。
 * `WM_USERNAME`を優先し、メールだけが設定されている場合は`WM_EMAIL`を使う。
 * どちらも無ければ例外を投げる。
 * `"unknown"`のような既定値で記録すると、誰が判断したかが残らないため、
 * 承認者が分からない判断は記録しない(fail closed)。
 * テストのため、環境変数は引数で受け取る純粋関数にしている。
 */
export function deriveApprover(env: ApproverEnv): string {
  const username = env.WM_USERNAME;
  if (username !== undefined && username.length > 0) {
    return username;
  }
  const email = env.WM_EMAIL;
  if (email !== undefined && email.length > 0) {
    return email;
  }
  throw new Error(
    "deriveApprover: cannot determine approver identity (WM_USERNAME and WM_EMAIL are both unset)",
  );
}
