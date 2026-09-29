// PathScript step 2/4 of f/factory/implement (工程3 design §2
// implement_generate): one headless Claude run of the factory-implementation
// skill in the implement worktree, with a fresh copy of the approved
// requirements directory (withReadOnlyDocDirCopy). No module-level retry in
// the flow: runClaude already retries a malformed output once, and a flow
// retry would multiply the budget (design §2). A failed run is returned as
// data (an ImplementClaudeRound of kind claude_failed); implement_verify
// records every round on implement_rounds.

import * as wmill from "windmill-client@1.817.0";
import { buildSystemPrompt, runClaude } from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import { recordAgentRun } from "../lib/db.ts";
import {
  IMPLEMENT_SKILL_NAME,
  type ImplementClaudeRound,
  type ImplementContext,
  implementPromptInput,
  runImplementClaudeRound,
  withReadOnlyDocDirCopy,
} from "../lib/implement_loop.ts";
import { implementPrompt } from "../lib/prompts.ts";
import { runCommand } from "../lib/workspace.ts";

export async function main(
  work_item_id: number,
  context: ImplementContext,
): Promise<ImplementClaudeRound> {
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const oauthToken = await wmill.getVariable("f/factory/claude_oauth_token");
  const systemPrompt = await buildSystemPrompt({
    skillNames: [IMPLEMENT_SKILL_NAME],
    factoryCloneDir: context.factory_clone_dir,
  });
  try {
    return await withReadOnlyDocDirCopy(
      context.requirements_doc_dir,
      (docDir) =>
        runImplementClaudeRound(
          { runClaude, recordAgentRun },
          {
            run: runCommand,
            config,
            workItemId: work_item_id,
            attempt: context.attempt,
            stage: "implement",
            prompt: implementPrompt(implementPromptInput(context, docDir)),
            systemPromptPath: systemPrompt.path,
            worktreeDir: context.worktree_dir,
            docDir,
            oauthToken,
          },
        ),
    );
  } finally {
    await systemPrompt.cleanup();
  }
}
