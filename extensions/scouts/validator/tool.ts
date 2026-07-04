import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { executeScout } from "../execute.ts";
import { ScoutCall, ScoutResult } from "../render.ts";
import { trackScoutToolCall } from "../state.ts";
import type { ScoutDetails } from "../types.ts";
import { validateQuery } from "../validate.ts";
import { VALIDATOR_CONFIG, ValidatorParams } from "./config.ts";

export const VALIDATOR_TOOL: ToolDefinition<typeof ValidatorParams, ScoutDetails> = {
  name: "validator",
  label: "Validator",
  description:
    "Validation scout for noisy commands. Use validator to run tests, builds, linters, typecheckers, repro commands, and logs without polluting the main context. Validator can run shell commands and read files, but it does not edit. Provide a complete validation brief in `query`; optionally pass exact `commands` to run first. Usually omit the optional `model` parameter unless the user explicitly asked for a specific model/provider.",
  parameters: ValidatorParams,

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const error = validateQuery(params);
    if (error) return error;
    const finishTracking = trackScoutToolCall(toolCallId);
    try {
      return await executeScout(VALIDATOR_CONFIG, params as Record<string, unknown>, signal, onUpdate, ctx);
    } finally {
      finishTracking();
    }
  },

  renderCall(_args, theme, context) {
    return new ScoutCall("validator", { theme, executionStarted: context.executionStarted });
  },

  renderResult(result, options, theme, context) {
    const component = context.lastComponent instanceof ScoutResult
      ? context.lastComponent
      : new ScoutResult(result, options, theme, "validator");
    component.update(result, options, theme, context.invalidate);
    return component;
  },
};
