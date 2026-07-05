import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { executeScout } from "../execute.ts";
import { ScoutCall, ScoutResult } from "../render.ts";
import { trackScoutToolCall } from "../state.ts";
import type { ScoutDetails } from "../types.ts";
import { makeErrorResult, validateQuery } from "../validate.ts";
import { READ_ONLY_WORKER_CONFIG, WORKER_CONFIG, WorkerParams } from "./config.ts";

let activeWorkerToolCallId: string | undefined;

export const WORKER_TOOL: ToolDefinition<typeof WorkerParams, ScoutDetails> = {
  name: "worker",
  label: "Worker",
  description:
    "Bounded implementation and validation worker. Use when you know the concrete change to make or checks to run. Worker can read, edit, write, run commands, and verify. It should not do open-ended discovery or architecture planning. Set effort: quick | standard | thorough. For validation-only tasks, set readOnly: true — the worker then has no edit or write tools — and provide verificationCommands. Use finder/oracle/librarian before worker when the target or design is unclear. Only one mutating worker can run at a time; a second call while one is active returns an error. readOnly workers are exempt and can run in parallel.",
  parameters: WorkerParams,

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const error = validateQuery(params);
    if (error) return error;

    const readOnly = params.readOnly === true;

    if (!readOnly && activeWorkerToolCallId) {
      return makeErrorResult(
        "A mutating worker is already running. Wait for the current worker to finish, or set readOnly: true for validation-only runs, which can go in parallel.",
        typeof params.query === "string" ? params.query : "",
      );
    }

    if (!readOnly) activeWorkerToolCallId = toolCallId || "worker";
    const finishTracking = trackScoutToolCall(toolCallId);
    try {
      return await executeScout(readOnly ? READ_ONLY_WORKER_CONFIG : WORKER_CONFIG, params as Record<string, unknown>, signal, onUpdate, ctx);
    } finally {
      finishTracking();
      if (!readOnly) activeWorkerToolCallId = undefined;
    }
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
