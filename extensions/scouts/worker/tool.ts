import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { executeScout, resumeScout } from "../execute.ts";
import { getSuspendedRun } from "../runs.ts";
import { ScoutCall, ScoutResult } from "../render.ts";
import { trackScoutToolCall } from "../state.ts";
import type { ScoutDetails } from "../types.ts";
import { makeErrorResult, validateQuery } from "../validate.ts";
import { READ_ONLY_WORKER_CONFIG, WORKER_CONFIG, WorkerParams } from "./config.ts";

let activeWorkerToolCallId: string | undefined;

type WorkerToolRunners = {
  executeScout: typeof executeScout;
  resumeScout: typeof resumeScout;
};

const DEFAULT_RUNNERS: WorkerToolRunners = { executeScout, resumeScout };

function resumeRunId(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const rawResume = (params as { resume?: unknown }).resume;
  if (rawResume === undefined) return undefined;
  return typeof rawResume === "string" ? rawResume.trim() : "";
}

function validateWorkerParams(params: unknown): ReturnType<typeof makeErrorResult> | null {
  const resume = resumeRunId(params);
  if (resume !== undefined) {
    if (!resume) return makeErrorResult("Invalid parameters: expected `resume` to be a non-empty string.");
    return null;
  }

  return validateQuery(params);
}

function activeWorkerError(query: unknown): ReturnType<typeof makeErrorResult> {
  return makeErrorResult(
    "A mutating worker is already running. Wait for the current worker to finish, or set readOnly: true for validation-only runs, which can go in parallel.",
    typeof query === "string" ? query : "",
  );
}

export async function executeWorkerToolCall(
  toolCallId: string | undefined,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: Parameters<ToolDefinition<typeof WorkerParams, ScoutDetails>["execute"]>[3],
  ctx: ExtensionContext,
  runners: WorkerToolRunners = DEFAULT_RUNNERS,
) {
  const error = validateWorkerParams(params);
  if (error) return error;

  const resume = resumeRunId(params);
  const readOnly = params.readOnly === true;
  const lockRequired = resume
    ? getSuspendedRun(resume)?.isMutatingWorker === true
    : !readOnly;

  if (lockRequired && activeWorkerToolCallId) {
    return activeWorkerError(params.query);
  }

  if (lockRequired) activeWorkerToolCallId = toolCallId || "worker";
  const finishTracking = trackScoutToolCall(toolCallId);
  try {
    if (resume) return await runners.resumeScout(resume, params.query, signal, onUpdate);
    return await runners.executeScout(readOnly ? READ_ONLY_WORKER_CONFIG : WORKER_CONFIG, params as Record<string, unknown>, signal, onUpdate, ctx);
  } finally {
    finishTracking();
    if (lockRequired) activeWorkerToolCallId = undefined;
  }
}

export const WORKER_TOOL: ToolDefinition<typeof WorkerParams, ScoutDetails> = {
  name: "worker",
  label: "Worker",
  description:
    "Bounded implementation and validation worker. Use when you know the concrete change to make or checks to run. Worker can read, edit, write, run commands, and verify. It should not do open-ended discovery or architecture planning. Set effort: quick | standard | thorough. For validation-only tasks, set readOnly: true — the worker then has no edit or write tools — and provide verificationCommands. Use finder/oracle/librarian before worker when the target or design is unclear. Only one mutating worker can run at a time; a second call while one is active returns an error. readOnly workers are exempt and can run in parallel.",
  parameters: WorkerParams,

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executeWorkerToolCall(toolCallId, params as Record<string, unknown>, signal, onUpdate, ctx);
  },

  renderCall(_args, theme, context) {
    return new ScoutCall("worker", { theme, executionStarted: context.executionStarted });
  },

  renderResult(result, options, theme, context) {
    const component = context.lastComponent instanceof ScoutResult
      ? context.lastComponent
      : new ScoutResult(result, options, theme, "worker");
    component.update(result, options, theme, context.invalidate);
    return component;
  },
};
