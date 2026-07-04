import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { executeScout } from "../execute.ts";
import { ScoutCall, ScoutResult } from "../render.ts";
import { trackScoutToolCall } from "../state.ts";
import type { ScoutDetails } from "../types.ts";
import { makeErrorResult, validateQuery } from "../validate.ts";
import { WORKER_CONFIG, WorkerParams } from "./config.ts";

let activeWorkerToolCallId: string | undefined;

export const WORKER_TOOL: ToolDefinition<typeof WorkerParams, ScoutDetails> = {
  name: "worker",
  label: "Worker",
  description:
    "Bounded implementation and validation worker. Use when you know the concrete change to make or checks to run, and you want a bounded subagent to edit files and/or run verification. Worker can read, edit, write, run commands, and verify, but it should not do open-ended discovery or architecture planning. Set effort to quick for low-reasoning small/local changes, standard for medium-reasoning bounded work, or thorough for high-reasoning deeper in-scope implementation and broader validation. For validation-only tasks, tell worker not to edit and provide verificationCommands. Use finder/oracle/librarian before worker when the target or design is unclear. Do not launch parallel workers unless future tooling explicitly supports disjoint write scopes; this worker enforces one active worker at a time.",
  parameters: WorkerParams,

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const error = validateQuery(params);
    if (error) return error;

    if (activeWorkerToolCallId) {
      return makeErrorResult(
        "A worker is already running. Wait for the current worker to finish before starting another mutating worker.",
        typeof params.query === "string" ? params.query : "",
      );
    }

    activeWorkerToolCallId = toolCallId || "worker";
    const finishTracking = trackScoutToolCall(toolCallId);
    try {
      return await executeScout(WORKER_CONFIG, params as Record<string, unknown>, signal, onUpdate, ctx);
    } finally {
      finishTracking();
      activeWorkerToolCallId = undefined;
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
