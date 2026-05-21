import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { executeScout } from "../execute.ts";
import { ScoutCall, ScoutResult } from "../render.ts";
import { trackScoutToolCall } from "../state.ts";
import type { ScoutDetails } from "../types.ts";
import { makeErrorResult } from "../validate.ts";
import { buildSpecialistConfig, SpecialistParams, type SpecialistTool } from "./config.ts";

export const SPECIALIST_TOOL: ToolDefinition<typeof SpecialistParams, ScoutDetails> = {
  name: "specialist",
  label: "Specialist",
  description:
    "Skill-powered domain expert. Load any installed skill as domain expertise and dispatch a task. The specialist reads the skill, becomes an expert, and applies that expertise to your task. Defaults to read-only tools (read, bash). Pass tools: [\"read\", \"bash\", \"write\", \"edit\"] for tasks that need to modify files. Use for delegating work that requires specific domain knowledge — code review styles, framework patterns, documentation standards, or any skill in ~/.agents/skills/ or ~/.pi/agent/skills/. Usually omit the optional `model` parameter unless the user explicitly asked for a specific model/provider.",
  parameters: SpecialistParams,

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const p = params;
    const skillName = (p.skill ?? "").trim();
    const task = (p.task ?? "").trim();

    if (!skillName) {
      return makeErrorResult("Missing required parameter: skill");
    }

    if (!task) {
      return makeErrorResult("Missing required parameter: task");
    }

    try {
      const configOrError = await buildSpecialistConfig(skillName, ctx.cwd, {
        configName: "specialist",
        tools: p.tools as SpecialistTool[] | undefined,
      });

      if ("error" in configOrError) {
        return makeErrorResult(configOrError.error, task);
      }

      const finishTracking = trackScoutToolCall(toolCallId);
      try {
        return await executeScout(
          configOrError,
          { ...p, task, query: task },
          signal,
          onUpdate,
          ctx,
        );
      } finally {
        finishTracking();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return makeErrorResult(`Specialist setup failed: ${message}`, task);
    }
  },

  renderCall(args, theme, context) {
    const p = args as { skill?: string };
    const skill = p?.skill ?? "unknown";
    return new ScoutCall("specialist", { theme, executionStarted: context.executionStarted, titleSuffix: `skill:${skill}` });
  },

  renderResult(result, options, theme, context) {
    const p = context.args as { skill?: string };
    const skill = p?.skill ?? "unknown";
    const component = context.lastComponent instanceof ScoutResult
      ? context.lastComponent
      : new ScoutResult(result, options, theme, "specialist", `skill:${skill}`);
    component.update(result, options, theme, context.invalidate);
    return component;
  },
};
