import { evaluateBashGuard } from "../../../scripts/claude-hooks/bash-guard.ts";
import { runHook } from "../../../scripts/claude-hooks/hook-io.ts";

export type Options = {
  /** 既定のブランチ。`null`ならブランチが決まらない状態を表す。 */
  readonly branch?: string | null;
  /** ディレクトリごとのブランチ。ここに無いディレクトリは`branch`を返す。 */
  readonly branches?: Readonly<Record<string, string | null>>;
  /** ローカルに存在するブランチの名前。 */
  readonly localBranches?: readonly string[];
  readonly subagent?: boolean;
  readonly cwd?: string;
};

const REPO_ROOT = "/repo";

function hookInput(command: string, options: Options): string {
  return JSON.stringify({
    session_id: "session",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd: options.cwd ?? REPO_ROOT,
    ...(options.subagent
      ? { agent_id: "agent-1", agent_type: "implementer" }
      : {}),
  });
}

async function run(command: string, options: Options) {
  const fallbackBranch =
    options.branch === undefined ? "feature" : options.branch;
  return runHook(
    hookInput(command, options),
    (input) =>
      Promise.resolve(
        evaluateBashGuard(input, {
          currentBranch: (dir) => {
            const branches = options.branches ?? {};
            return dir in branches ? (branches[dir] ?? null) : fallbackBranch;
          },
          localBranchExists: (_dir, name) =>
            (options.localBranches ?? []).includes(name),
          // セッションのディレクトリと、/repo の下のディレクトリは同じリポジトリ、それ以外は自分自身が根になる。
          repoRoot: (dir) =>
            dir === (options.cwd ?? REPO_ROOT) ||
            dir === REPO_ROOT ||
            dir.startsWith(`${REPO_ROOT}/`)
              ? REPO_ROOT
              : dir,
        }),
      ),
    "/fallback",
  );
}

/** フックの入力のJSONを与えて、allow / deny / errorのどれになるかを返す。 */
export async function decide(
  command: string,
  options: Options = {},
): Promise<string> {
  const result = await run(command, options);
  if (result.exitCode !== 0) return "error";
  return result.stdout === "" ? "allow" : "deny";
}

/** 拒否したときの標準出力(理由を含むJSON)を返す。拒否でなければ空文字を返す。 */
export async function denyReason(
  command: string,
  options: Options = {},
): Promise<string> {
  return (await run(command, options)).stdout;
}
