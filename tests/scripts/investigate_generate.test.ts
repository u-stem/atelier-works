// 調査の生成のstep(`steps/investigate_generate.ts`)の手順を固定する。
// 保護パスに置く。設定の再確認、排他の確認、関門、掃除、作業ツリーの作成、起動の順序を緩める変更が、このテストを書き換えて通らないようにするため。
// 順序と分岐は、依存を差し替えた実行で確かめる。

import { describe, expect, test } from "bun:test";
import type {
  InvestigateClaudeOptions,
  InvestigateClaudeResult,
} from "../../f/factory/lib/investigate_claude.ts";
import type { EscalationSpec } from "../../f/factory/lib/investigate_flow.ts";
import {
  gateClosedEscalation,
  INVESTIGATE_ROLE_TAG,
  INVESTIGATE_SCHEMA,
  type InvestigateOutput,
  isInvestigateOutput,
  withheldEscalation,
} from "../../f/factory/lib/investigate_flow.ts";
import {
  ISOLATION_GATE_CODES,
  IsolationGateError,
} from "../../f/factory/lib/investigate_isolation_gate.ts";
import { mintIsolationProof } from "../../f/factory/lib/isolation_proof.ts";
import type { AgentRunRecord, WorkItem } from "../../f/factory/lib/types.ts";
import {
  type InvestigateGenerateDeps,
  runInvestigateGenerate,
} from "../../f/factory/steps/investigate_generate.ts";
import {
  INVESTIGATE_ROOT_JOB,
  investigationItem,
} from "../lib/investigateTestSupport.ts";

type Proof = InvestigateClaudeOptions<InvestigateOutput>["proof"];

const INPUT = {
  workItemId: 7,
  rootJobId: INVESTIGATE_ROOT_JOB,
  repoDir: "/workspaces/acme/widgets/main",
  sha: "a".repeat(40),
  factoryCloneDir: "/workspaces/factory/atelier-works",
};

const OUTPUT: InvestigateOutput = {
  summary: "The build is slow.",
  findings: [{ title: "Cache", detail: "The cache key changes." }],
  open_questions: [],
};

const AGENT_RUN: AgentRunRecord = {
  work_item_id: 7,
  stage: "investigate",
  attempt: 1,
  model: "claude-sonnet-5-5",
  claude_version: null,
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cost_usd: 0.5,
  num_turns: 3,
  duration_ms: 1000,
  session_id: "session",
  exit_code: 0,
  error: null,
  model_usage: [],
};

const SUCCESS: InvestigateClaudeResult<InvestigateOutput> = {
  outcome: "success",
  structuredOutput: OUTPUT,
  agentRun: AGENT_RUN,
  retried: false,
  agentRunId: 1,
};

type ScanResult = { readonly ok: boolean; readonly output: string };

type World = {
  readonly enabled?: boolean;
  /** 秘密値の検査器の結果を、呼ばれた順に返す。尽きたら異常なし。 */
  readonly scans?: readonly (ScanResult | Error)[];
  readonly secrets?: readonly string[];
  readonly secretsFail?: boolean;
  /** 設定を読むたびに順に返す値。尽きたら最後の値を返す。 */
  readonly enabledReads?: readonly boolean[];
  readonly item?: WorkItem | null;
  readonly ids?: number[];
  readonly probeActive?: boolean;
  readonly proofs?: (() => Promise<Proof>)[];
  readonly purge?: () => Promise<unknown>;
  readonly create?: () => Promise<{ dir: string }>;
  readonly disable?: () => Promise<unknown>;
  readonly launch?: () => Promise<InvestigateClaudeResult<InvestigateOutput>>;
  readonly remove?: () => Promise<void>;
};

function fake(world: World = {}) {
  const calls: string[] = [];
  const escalations: EscalationSpec[] = [];
  const launched: InvestigateClaudeOptions<InvestigateOutput>[] = [];
  const proofsGiven: Proof[] = [];
  const scanned: string[] = [];
  const logged: string[] = [];
  let proofCall = 0;
  let enabledCall = 0;
  const deps: InvestigateGenerateDeps = {
    readEnabled: async () => {
      calls.push("enabled");
      const reads = world.enabledReads;
      if (reads !== undefined) {
        const value = reads[Math.min(enabledCall, reads.length - 1)];
        enabledCall += 1;
        return value ?? true;
      }
      return world.enabled ?? true;
    },
    cancel: async () => {
      calls.push("cancel");
      return true;
    },
    getWorkItem: async () => {
      calls.push("item");
      return world.item === undefined ? investigationItem() : world.item;
    },
    listInvestigatingIds: async () => {
      calls.push("ids");
      return world.ids ?? [7];
    },
    isProbeActive: async () => {
      calls.push("probe");
      return world.probeActive ?? false;
    },
    escalate: async (_item, spec) => {
      calls.push("escalate");
      escalations.push(spec);
      return true;
    },
    checkProof: async () => {
      calls.push("proof");
      const next = world.proofs?.[proofCall];
      proofCall += 1;
      const proof = next === undefined ? mintIsolationProof() : await next();
      proofsGiven.push(proof);
      return proof;
    },
    purge: async () => {
      calls.push("purge");
      return world.purge === undefined ? {} : world.purge();
    },
    createWorktree: async () => {
      calls.push("create");
      return world.create === undefined
        ? { dir: "/var/lib/factory-investigate/7" }
        : world.create();
    },
    disableInstructions: async () => {
      calls.push("disable");
      return world.disable === undefined ? {} : world.disable();
    },
    buildSystemPrompt: async () => {
      calls.push("prompt");
      return {
        path: "/tmp/system-prompt.md",
        cleanup: async () => {
          calls.push("cleanup");
        },
      };
    },
    readOauthToken: async () => {
      calls.push("oauth");
      return "oauth-token";
    },
    launch: async (opts) => {
      calls.push("launch");
      launched.push(opts);
      return world.launch === undefined ? SUCCESS : world.launch();
    },
    readSecrets: async () => {
      calls.push("secrets");
      if (world.secretsFail === true) throw new Error("unreadable");
      return world.secrets ?? [];
    },
    scan: async (text) => {
      calls.push("scan");
      scanned.push(text);
      const next = world.scans?.[scanned.length - 1] ?? {
        ok: true,
        output: "",
      };
      if (next instanceof Error) throw next;
      return next;
    },
    removeWorktree: async () => {
      calls.push("remove");
      if (world.remove !== undefined) await world.remove();
    },
    run: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    record: async () => 1,
    settings: {
      model: "claude-sonnet-5-5",
      maxTurns: 40,
      maxBudgetUsd: 5,
      timeoutMs: 1_800_000,
    },
    log: {
      info: (message, fields) => {
        logged.push(JSON.stringify([message, fields]));
      },
      warn: (message, fields) => {
        logged.push(JSON.stringify([message, fields]));
      },
      error: (message, fields) => {
        logged.push(JSON.stringify([message, fields]));
      },
    },
  };
  return { deps, calls, escalations, launched, proofsGiven, scanned, logged };
}

describe("runInvestigateGenerate", () => {
  describe("the order of the steps", () => {
    test("reads the setting, checks the row and the exclusion, passes the gate, clears the place, makes the worktree, passes the gate again, starts, and removes the worktree", async () => {
      const f = fake();
      await runInvestigateGenerate(INPUT, f.deps);
      expect(f.calls).toEqual([
        "enabled",
        "item",
        "ids",
        "probe",
        "proof",
        "purge",
        "create",
        "disable",
        "prompt",
        "oauth",
        "enabled",
        "proof",
        "launch",
        "secrets",
        "scan",
        "scan",
        "cleanup",
        "remove",
      ]);
    });

    test("returns the final body of a success, and no withheld code", async () => {
      const f = fake();
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(result.skip).toBe(false);
      expect(result.withheld).toBeNull();
      expect(result.comment_body?.startsWith(INVESTIGATE_ROLE_TAG)).toBe(true);
    });
  });

  describe("the setting that opens the investigation", () => {
    test("cancels the investigation and stops when the setting is off", async () => {
      const f = fake({ enabled: false });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(result).toEqual({
        skip: true,
        reason: "disabled",
        comment_body: null,
        withheld: null,
      });
      expect(f.calls).toEqual(["enabled", "cancel"]);
    });
  });

  describe("what the step hands to the next step", () => {
    const RAW: InvestigateOutput = {
      summary: "ping @someone <!-- hidden --> topsecretvalue",
      findings: [{ title: "Raw title", detail: "Raw detail" }],
      open_questions: ["Raw question?"],
    };
    const RAW_RESULT: InvestigateClaudeResult<InvestigateOutput> = {
      ...SUCCESS,
      structuredOutput: RAW,
    };

    test("holds only the skip flag, the reason, the body and the withheld code", async () => {
      const f = fake({ launch: async () => RAW_RESULT });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(Object.keys(result).sort()).toEqual([
        "comment_body",
        "reason",
        "skip",
        "withheld",
      ]);
    });

    test("does not hand over the raw output, only the sanitized and masked body", async () => {
      const f = fake({
        launch: async () => RAW_RESULT,
        secrets: ["topsecretvalue"],
      });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      const body = result.comment_body ?? "";
      expect(body).not.toContain("<!--");
      expect(body).not.toContain("topsecretvalue");
      expect(JSON.stringify(result)).not.toContain("open_questions");
    });

    test("scans the raw output first and the final body last", async () => {
      const f = fake({ launch: async () => RAW_RESULT });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(f.scanned[0]).toContain("<!-- hidden -->");
      expect(f.scanned[1]).toBe(result.comment_body ?? "");
    });

    test("skips the post step and hands over a code and no body when the raw output has a secret", async () => {
      const f = fake({
        launch: async () => RAW_RESULT,
        scans: [{ ok: false, output: "- rule" }],
      });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(result).toEqual({
        skip: true,
        reason: "withheld:secret_detected",
        comment_body: null,
        withheld: "secret_detected",
      });
    });

    test("sends the investigation to a person itself when the raw output has a secret", async () => {
      const f = fake({
        launch: async () => RAW_RESULT,
        scans: [{ ok: false, output: "- rule" }],
      });
      await runInvestigateGenerate(INPUT, f.deps);
      expect(f.escalations).toEqual([withheldEscalation("secret_detected")]);
    });

    test("does not send a person of an ordinary success", async () => {
      const f = fake({ launch: async () => RAW_RESULT });
      await runInvestigateGenerate(INPUT, f.deps);
      expect(f.escalations).toEqual([]);
    });

    test("hands over a body that opens with the role tag even when a field looks like a variable reference", async () => {
      const f = fake({
        launch: async () => ({
          ...SUCCESS,
          structuredOutput: {
            ...OUTPUT,
            summary: "$var:f/factory/github_token",
          },
        }),
      });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(result.comment_body?.startsWith(INVESTIGATE_ROLE_TAG)).toBe(true);
    });

    test("hands over a code and no body when the scan fails", async () => {
      const f = fake({
        launch: async () => RAW_RESULT,
        scans: [new Error("gitleaks timed out")],
      });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(result.withheld).toBe("scan_failed");
      expect(result.comment_body).toBeNull();
      expect(result.skip).toBe(true);
      expect(f.escalations).toEqual([withheldEscalation("scan_failed")]);
    });

    test("withholds the body when the secrets cannot be read", async () => {
      const f = fake({ launch: async () => RAW_RESULT, secretsFail: true });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(result.withheld).toBe("scan_failed");
      expect(result.comment_body).toBeNull();
      expect(f.escalations).toEqual([withheldEscalation("scan_failed")]);
    });

    test("does not scan when the secrets cannot be read", async () => {
      const f = fake({ launch: async () => RAW_RESULT, secretsFail: true });
      await runInvestigateGenerate(INPUT, f.deps);
      expect(f.scanned).toEqual([]);
    });

    test("writes no text of the raw output to the log", async () => {
      const f = fake({ launch: async () => RAW_RESULT });
      await runInvestigateGenerate(INPUT, f.deps);
      expect(f.logged.join("\n")).not.toContain("Raw detail");
    });
  });

  describe("the setting read again just before the start", () => {
    test("cancels the investigation and does not start when the setting turned off meanwhile", async () => {
      const f = fake({ enabledReads: [true, false] });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(result).toEqual({
        skip: true,
        reason: "disabled",
        comment_body: null,
        withheld: null,
      });
      expect(f.calls).toContain("cancel");
      expect(f.calls).not.toContain("launch");
    });

    test("does not ask the gate again once the setting turned off", async () => {
      const f = fake({ enabledReads: [true, false] });
      await runInvestigateGenerate(INPUT, f.deps);
      expect(f.calls.filter((call) => call === "proof")).toHaveLength(1);
    });

    test("removes the worktree and the prompt file when the setting turned off", async () => {
      const f = fake({ enabledReads: [true, false] });
      await runInvestigateGenerate(INPUT, f.deps);
      expect(f.calls.slice(-2)).toEqual(["cleanup", "remove"]);
    });
  });

  describe("the row and the exclusion", () => {
    test("throws when the work item does not exist", async () => {
      const f = fake({ item: null });
      await expect(runInvestigateGenerate(INPUT, f.deps)).rejects.toThrow(
        "no work item",
      );
    });

    test("skips a run that does not hold the lease", async () => {
      const f = fake({ item: investigationItem({ flow_job_id: "another" }) });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(result.skip).toBe(true);
      expect(f.calls).toEqual(["enabled", "item"]);
    });

    test("escalates when another investigation is running", async () => {
      const f = fake({ ids: [7, 9] });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(result.skip).toBe(true);
      expect(f.escalations[0]?.note).toBe("another investigation is running");
      expect(f.calls).not.toContain("proof");
    });

    test("escalates while the isolation probe runs", async () => {
      const f = fake({ probeActive: true });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(result.skip).toBe(true);
      expect(f.escalations[0]?.note).toBe("the isolation probe is running");
      expect(f.calls).not.toContain("proof");
    });

    test("does not clear the place before it has confirmed the exclusion", async () => {
      const f = fake({ probeActive: true });
      await runInvestigateGenerate(INPUT, f.deps);
      expect(f.calls).not.toContain("purge");
    });
  });

  describe("the gate", () => {
    test.each([...ISOLATION_GATE_CODES])(
      "escalates with the code when the gate closes with %s",
      async (code) => {
        const f = fake({
          proofs: [
            async () => {
              throw new IsolationGateError(code);
            },
          ],
        });
        const result = await runInvestigateGenerate(INPUT, f.deps);
        expect(result.skip).toBe(true);
        expect(f.escalations).toEqual([gateClosedEscalation(code)]);
      },
    );

    test("does not clear the place, make a worktree or start when the gate is closed", async () => {
      const f = fake({
        proofs: [
          async () => {
            throw new IsolationGateError("proof_missing");
          },
        ],
      });
      await runInvestigateGenerate(INPUT, f.deps);
      expect(f.calls).toEqual([
        "enabled",
        "item",
        "ids",
        "probe",
        "proof",
        "escalate",
      ]);
    });

    test("rethrows a failure of the gate that is not a closed gate", async () => {
      const f = fake({
        proofs: [
          async () => {
            throw new Error("network");
          },
        ],
      });
      await expect(runInvestigateGenerate(INPUT, f.deps)).rejects.toThrow(
        "network",
      );
    });

    test("asks the gate again just before it starts, and does not start when it closed in the meantime", async () => {
      const f = fake({
        proofs: [
          async () => mintIsolationProof(),
          async () => {
            throw new IsolationGateError("isolation_changed");
          },
        ],
      });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(result.skip).toBe(true);
      expect(f.calls).not.toContain("launch");
      expect(f.escalations).toEqual([
        gateClosedEscalation("isolation_changed"),
      ]);
    });

    test("removes the worktree when the gate closes just before the start", async () => {
      const f = fake({
        proofs: [
          async () => mintIsolationProof(),
          async () => {
            throw new IsolationGateError("isolation_changed");
          },
        ],
      });
      await runInvestigateGenerate(INPUT, f.deps);
      expect(f.calls.slice(-2)).toEqual(["cleanup", "remove"]);
    });

    test("starts with the proof of the second check", async () => {
      const f = fake();
      await runInvestigateGenerate(INPUT, f.deps);
      expect(f.launched[0]?.proof).toBe(f.proofsGiven[1]);
      expect(f.proofsGiven[1]).not.toBe(f.proofsGiven[0]);
    });
  });

  describe("the start", () => {
    test("runs in the worktree that it made", async () => {
      const f = fake();
      await runInvestigateGenerate(INPUT, f.deps);
      expect(f.launched[0]?.cwd).toBe("/var/lib/factory-investigate/7");
    });

    test("hands the fixed settings, the schema and the recording to the wrapper", async () => {
      const f = fake();
      await runInvestigateGenerate(INPUT, f.deps);
      const opts = f.launched[0];
      expect(opts).toMatchObject({
        workItemId: 7,
        stage: "investigate",
        attempt: 1,
        model: "claude-sonnet-5-5",
        appendSystemPromptFile: "/tmp/system-prompt.md",
        jsonSchema: INVESTIGATE_SCHEMA,
        isStructuredOutput: isInvestigateOutput,
        maxTurns: 40,
        maxBudgetUsd: 5,
        oauthToken: "oauth-token",
        timeoutMs: 1_800_000,
      });
      expect(opts?.recording.mode).toBe("record");
    });

    test("gives the stored request, fenced, and not the body of the issue", async () => {
      const f = fake({
        item: investigationItem({ body: "Why is the build slow?" }),
      });
      await runInvestigateGenerate(INPUT, f.deps);
      const prompt = f.launched[0]?.prompt ?? "";
      expect(prompt).toContain("Why is the build slow?");
      expect(prompt).toContain("investigation request");
    });

    test("throws when the row has no stored request", async () => {
      const f = fake({ item: investigationItem({ body: null }) });
      await expect(runInvestigateGenerate(INPUT, f.deps)).rejects.toThrow(
        "request",
      );
    });
  });

  describe("a failure of the run", () => {
    const FAILURE: InvestigateClaudeResult<InvestigateOutput> = {
      outcome: "failure",
      reason: "timeout",
      detail: "timeout (4000 characters withheld)",
      agentRun: AGENT_RUN,
      retried: true,
      agentRunId: 2,
    };

    test("escalates with the code of the reason", async () => {
      const f = fake({ launch: async () => FAILURE });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(result).toEqual({
        skip: true,
        reason: "claude_failed",
        comment_body: null,
        withheld: null,
      });
      expect(f.escalations[0]?.note).toBe("claude run failed: timeout");
    });

    test("puts no detail of the failure in the escalation", async () => {
      const f = fake({ launch: async () => FAILURE });
      await runInvestigateGenerate(INPUT, f.deps);
      expect(JSON.stringify(f.escalations)).not.toContain("withheld");
    });

    test("removes the worktree after the failure", async () => {
      const f = fake({ launch: async () => FAILURE });
      await runInvestigateGenerate(INPUT, f.deps);
      expect(f.calls.slice(-2)).toEqual(["cleanup", "remove"]);
    });
  });

  describe("the cleanup", () => {
    test("removes the worktree and the prompt file when the start throws", async () => {
      const f = fake({
        launch: async () => {
          throw new Error("spawn failed");
        },
      });
      await expect(runInvestigateGenerate(INPUT, f.deps)).rejects.toThrow(
        "spawn failed",
      );
      expect(f.calls.slice(-2)).toEqual(["cleanup", "remove"]);
    });

    test("removes the worktree when the instructions cannot be disabled", async () => {
      const f = fake({
        disable: async () => {
          throw new Error("could not rename");
        },
      });
      await expect(runInvestigateGenerate(INPUT, f.deps)).rejects.toThrow(
        "could not rename",
      );
      expect(f.calls).not.toContain("launch");
      expect(f.calls.at(-1)).toBe("remove");
    });

    test("removes what it can when the worktree cannot be made", async () => {
      const f = fake({
        create: async () => {
          throw new Error("fetch failed");
        },
      });
      await expect(runInvestigateGenerate(INPUT, f.deps)).rejects.toThrow(
        "fetch failed",
      );
      expect(f.calls.at(-1)).toBe("remove");
    });

    test("keeps the first failure when the removal fails as well", async () => {
      const f = fake({
        launch: async () => {
          throw new Error("spawn failed");
        },
        remove: async () => {
          throw new Error("rm failed");
        },
      });
      await expect(runInvestigateGenerate(INPUT, f.deps)).rejects.toThrow(
        "spawn failed",
      );
    });

    test("does not hide a success when the removal fails", async () => {
      const f = fake({
        remove: async () => {
          throw new Error("rm failed");
        },
      });
      const result = await runInvestigateGenerate(INPUT, f.deps);
      expect(result.skip).toBe(false);
    });

    test("does not make a worktree when the place cannot be cleared", async () => {
      const f = fake({
        purge: async () => {
          throw new Error("could not remove");
        },
      });
      await expect(runInvestigateGenerate(INPUT, f.deps)).rejects.toThrow(
        "could not remove",
      );
      expect(f.calls).not.toContain("create");
    });
  });
});
