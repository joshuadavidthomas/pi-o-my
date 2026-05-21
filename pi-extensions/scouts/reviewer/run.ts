import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { executeScout } from "../execute.ts";
import { computeOverallStatus } from "../state.ts";
import type { ScoutDetails } from "../types.ts";
import { buildReviewerConfig, isReviewLens, REVIEW_LENSES, type ReviewLens } from "./config.ts";
import { hasResultText, resultText } from "./result.ts";

export type ReviewMode = "notes" | "strict";
export type ReviewContext = "none" | "brief" | "transcript";
export type ReviewLensSelection = "all" | ReviewLens;
export type ReviewScoutResult = Awaited<ReturnType<typeof executeScout>>;
export type ReviewScoutUpdate = Pick<ReviewScoutResult, "content" | "details">;

export type ReviewLensExecution = {
  lens: ReviewLens;
  result: ReviewScoutResult;
  output: string;
  hasText: boolean;
};

export type RunReviewOptions = {
  ctx: ExtensionContext;
  signal?: AbortSignal;
  lenses: ReviewLens[];
  query: string;
  artifactType: string;
  context: ReviewContext;
  mode: ReviewMode;
  artifact?: string;
  artifactSource?: string;
  contextText?: string;
  repoConfig?: string;
  model?: unknown;
  onUpdate?: (lens: ReviewLens, update: ReviewScoutUpdate) => void;
};

export type RunReviewResult = {
  executions: ReviewLensExecution[];
  output: string;
  details: ScoutDetails;
  isError: boolean;
  hasText: boolean;
};

export function selectReviewLenses(selection: ReviewLensSelection): ReviewLens[] {
  return selection === "all" ? [...REVIEW_LENSES] : [selection];
}

export function normalizeReviewLenses(raw: unknown): ReviewLens[] {
  if (raw === undefined || raw === null) return [...REVIEW_LENSES];
  if (!Array.isArray(raw) || raw.length === 0) return [...REVIEW_LENSES];

  const unsupported = raw.filter((lens) => !isReviewLens(lens));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported reviewer lens: ${unsupported.map(String).join(", ")}. Supported lenses: ${REVIEW_LENSES.join(", ")}.`);
  }

  return [...new Set(raw as ReviewLens[])];
}

export function buildReviewTask(options: Omit<RunReviewOptions, "ctx" | "signal" | "lenses" | "model" | "onUpdate">): string {
  const disposition = options.mode === "strict"
    ? "Use strict disposition: every real finding must be Fix in this PR / Fix now or No-op. No defer."
    : "Use notes disposition: separate must-fix findings from advisory notes.";

  return [
    options.query,
    options.artifactSource ? `Artifact source: ${options.artifactSource}.` : "",
    `Artifact type: ${options.artifactType}.`,
    `Context mode: ${options.context}.`,
    disposition,
    options.contextText ? `\nContext:\n${options.contextText}` : "",
    options.repoConfig ? `\nRepo-specific review config:\n${options.repoConfig}` : "",
    options.artifact ? `\nArtifact:\n${options.artifact}` : "",
  ].filter(Boolean).join("\n");
}

export async function runReview(options: RunReviewOptions): Promise<RunReviewResult> {
  const task = buildReviewTask(options);
  const executions = await Promise.all(options.lenses.map(async (lens): Promise<ReviewLensExecution> => {
    const result = await executeScout(
      buildConfig(lens, options.model),
      {
        query: `Reviewer ${lens}: ${options.query}`,
        task,
      },
      options.signal,
      (update) => options.onUpdate?.(lens, update),
      options.ctx,
    );
    const output = resultText(result);
    return { lens, result, output, hasText: hasResultText(result) };
  }));

  const output = executions.map((execution) => `# ${execution.lens}\n\n${execution.output}`).join("\n\n");
  return {
    executions,
    output,
    details: aggregateReviewerDetails(options.query, executions),
    isError: executions.some((execution) => execution.result.isError),
    hasText: executions.some((execution) => execution.hasText),
  };
}

function buildConfig(lens: ReviewLens, model?: unknown) {
  const config = buildReviewerConfig(lens);
  if (typeof model === "string" && model.trim()) {
    return { ...config, configuredModel: model.trim(), workload: undefined };
  }
  return config;
}

function aggregateReviewerDetails(query: string, executions: ReviewLensExecution[]): ScoutDetails {
  const sourceRuns = executions.map((execution) => execution.result.details.runs[0]).filter((run): run is ScoutDetails["runs"][number] => run !== undefined);
  const status = computeOverallStatus(sourceRuns);
  const now = Date.now();
  const startedAt = sourceRuns.length > 0 ? Math.min(...sourceRuns.map((run) => run.startedAt)) : now;
  const endedTimes = sourceRuns.map((run) => run.endedAt).filter((time): time is number => time !== undefined);
  const endedAt = status === "running" || endedTimes.length === 0 ? undefined : Math.max(...endedTimes);
  const provider = sameValue(executions.map((execution) => execution.result.details.subagentProvider));
  const modelId = sameValue(executions.map((execution) => execution.result.details.subagentModelId));
  const summaryText = executions.map((execution) => `# ${execution.lens}\n\n${execution.output}`).join("\n\n");

  return {
    mode: "single",
    status,
    subagentProvider: provider,
    subagentModelId: modelId,
    runs: [{
      status,
      query,
      turns: sourceRuns.reduce((sum, run) => sum + run.turns, 0),
      displayItems: [
        ...executions.map((execution) => ({
          type: "tool" as const,
          name: "reviewer",
          args: {
            query: execution.result.details.runs[0]?.query ?? `${execution.lens} review`,
            lenses: [execution.lens],
          },
          toolCallId: `reviewer-${execution.lens}`,
          result: execution.output,
          isError: execution.result.isError,
          nestedScout: execution.result.details,
        })),
        { type: "text" as const, text: summaryText },
      ],
      summaryText,
      startedAt,
      endedAt,
    }],
  };
}

function sameValue(values: Array<string | undefined>): string | undefined {
  const present = values.filter((value): value is string => value !== undefined);
  if (present.length === 0) return undefined;
  return present.every((value) => value === present[0]) ? present[0] : undefined;
}
