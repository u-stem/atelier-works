// Claude CodeのPreToolUseフックの入出力を扱う。
// Claude Codeは終了コード2だけをツールの呼び出しの拒否として扱い、ほかの失敗では呼び出しを通す。
// そのため、入力を読めないときやルールが例外を投げたときは、必ず終了コード2で返す。

/** フックの入力から取り出した、Bashの呼び出し。`agentId`はsubagentの中の呼び出しでだけ値を持つ。 */
export type BashToolInput = {
  readonly command: string;
  readonly cwd: string;
  readonly agentId: string | null;
};

export type Decision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string };

export type HookResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export const ALLOW: Decision = { kind: "allow" };

export function deny(reason: string): Decision {
  return { kind: "deny", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * フックの標準入力(JSON)から、Bashの呼び出しを取り出す。
 * Bash以外のツールならnullを返す。形が想定と違えば例外を投げる。
 */
export function parseBashHookInput(
  stdin: string,
  fallbackCwd: string,
): BashToolInput | null {
  const parsed: unknown = JSON.parse(stdin);
  if (!isRecord(parsed)) throw new Error("hook input is not a JSON object");
  if (parsed.tool_name !== "Bash") return null;
  const toolInput = parsed.tool_input;
  if (!isRecord(toolInput) || typeof toolInput.command !== "string") {
    throw new Error("hook input has no tool_input.command string");
  }
  const cwd =
    typeof parsed.cwd === "string" && parsed.cwd !== ""
      ? parsed.cwd
      : fallbackCwd;
  const agentId =
    typeof parsed.agent_id === "string" && parsed.agent_id !== ""
      ? parsed.agent_id
      : null;
  return { command: toolInput.command, cwd, agentId };
}

/** 判定を、Claude Codeが読むstdoutと終了コードに変える。許可なら何も出力しない。 */
export function renderDecision(decision: Decision): HookResult {
  if (decision.kind === "allow") return { stdout: "", stderr: "", exitCode: 0 };
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  };
  return { stdout: `${JSON.stringify(output)}\n`, stderr: "", exitCode: 0 };
}

/** 入力を読み、ルールで判定する。失敗は終了コード2の結果にして返し、例外を外に出さない。 */
export async function runHook(
  stdin: string,
  evaluate: (input: BashToolInput) => Promise<Decision>,
  fallbackCwd: string,
): Promise<HookResult> {
  try {
    const input = parseBashHookInput(stdin, fallbackCwd);
    if (input === null) return renderDecision(ALLOW);
    return renderDecision(await evaluate(input));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stdout: "",
      stderr: `claude hook failed, denying the tool call: ${message}\n`,
      exitCode: 2,
    };
  }
}

/** 標準入力を読んで判定し、結果を書き出す。各フックのエントリーポイントから呼ぶ。 */
export async function runHookMain(
  evaluate: (input: BashToolInput) => Promise<Decision>,
): Promise<void> {
  const result = await runHook(await Bun.stdin.text(), evaluate, process.cwd());
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
