import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { executeScout } from "../execute.ts";
import { buildReviewerConfig, REVIEW_LENSES, type ReviewLens } from "./config.ts";
import { hasResultText, resultText } from "./result.ts";

export const REVIEW_ARTIFACT_TYPES = ["repository", "diff", "plan", "design", "file", "module", "session", "brief", "other"] as const;
export type ReviewArtifactType = (typeof REVIEW_ARTIFACT_TYPES)[number];
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
  artifactType: ReviewArtifactType;
  context: ReviewContext;
  mode: ReviewMode;
  artifact?: string;
  artifactSource?: string;
  contextText?: string;
  repoConfig?: string;
  model?: unknown;
  onUpdate?: (lens: ReviewLens, update: ReviewScoutUpdate) => void;
};

export type RunReviewLensOptions = Omit<RunReviewOptions, "lenses" | "onUpdate"> & {
  lens: ReviewLens;
  onUpdate?: (update: ReviewScoutUpdate) => void;
};

export type RunReviewResult = {
  executions: ReviewLensExecution[];
  output: string;
  isError: boolean;
  hasText: boolean;
};

export function selectReviewLenses(selection: ReviewLensSelection): ReviewLens[] {
  return selection === "all" ? [...REVIEW_LENSES] : [selection];
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

export async function runReviewLens(options: RunReviewLensOptions): Promise<ReviewLensExecution> {
  const task = buildReviewTask(options);
  const result = await executeScout(
    buildConfig(options.lens, options.model),
    {
      query: `Reviewer ${options.lens}: ${options.query}`,
      task,
    },
    options.signal,
    options.onUpdate,
    options.ctx,
  );
  return createReviewLensExecution(options.lens, result);
}

export async function runReview(options: RunReviewOptions): Promise<RunReviewResult> {
  const executions = await Promise.all(options.lenses.map((lens) => runReviewLens({
    ...options,
    lens,
    onUpdate: (update) => options.onUpdate?.(lens, update),
  })));

  const output = executions.map((execution) => `# ${execution.lens}\n\n${execution.output}`).join("\n\n");
  return {
    executions,
    output,
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

function createReviewLensExecution(lens: ReviewLens, result: ReviewScoutResult): ReviewLensExecution {
  return { lens, result, output: resultText(result), hasText: hasResultText(result) };
}
