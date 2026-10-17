// 仮の実装。次のコミットで`github.ts`から本体を移す。
export class GitHubHttpError extends Error {
  readonly status: number;
  readonly exitCode: number | undefined;
  readonly timedOut: boolean;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.exitCode = undefined;
    this.timedOut = false;
  }
}
