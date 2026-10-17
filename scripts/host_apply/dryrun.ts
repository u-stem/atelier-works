/** `docker compose up --dry-run`の呼び出しの引数と、出力の解析。 */

export const DRYRUN_EXCLUDED_SERVICES: readonly string[] = [];

export function composeBaseArgs(_input: {
  readonly stagingInfraDir: string;
}): string[] {
  return [];
}

export function dryRunArgs(
  _input: { readonly stagingInfraDir: string },
  _service: string,
): string[] {
  return [];
}

export type DryRunParse =
  | { readonly kind: "running" }
  | { readonly kind: "recreate"; readonly states: readonly string[] }
  | { readonly kind: "failed"; readonly reason: string };

export function parseDryRun(
  _output: string,
  _service: string,
  _project?: string,
): DryRunParse {
  return { kind: "running" };
}

export type DryRunClassification = {
  readonly recreate: readonly string[];
  readonly failed: readonly string[];
};

export function classifyDryRuns(
  _outputs: Readonly<Record<string, string>>,
): DryRunClassification {
  return { recreate: [], failed: [] };
}
