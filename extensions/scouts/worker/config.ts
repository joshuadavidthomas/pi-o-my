import { Type } from "typebox";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";

import { SCOUT_MODEL_TARGETS } from "../models.ts";
import type { ScoutConfig } from "../types.ts";
import { buildWorkerSystemPrompt, buildWorkerUserPrompt } from "./prompt.ts";

export const WORKER_EFFORTS = ["quick", "standard", "thorough"] as const;
export type WorkerEffort = (typeof WORKER_EFFORTS)[number];

export function workerThinkingLevel(effort: unknown): ThinkingLevel {
  if (effort === "quick") return "low";
  if (effort === "thorough") return "high";
  return "medium";
}

export const WorkerParams = Type.Object({
  query: Type.String({
    description: [
      "Complete implementation or validation brief for the Worker subagent.",
      "Use worker when the concrete change or verification target is already known. Worker is for bounded implementation, mechanical edits, and running requested verification — not open-ended discovery or architecture planning.",
      "Include the desired end state, relevant files/components, constraints, and what should not change. For validation-only tasks, state that no edits should be made.",
      "For research or code understanding, use finder/oracle/librarian before worker.",
      "Example: 'Update the scout model resolver. Change models.ts and related tests, then run the scout test suite.'",
    ].join("\n"),
  }),
  allowedPaths: Type.Optional(
    Type.Array(Type.String({ description: "Path or directory the worker is allowed or expected to modify." }), {
      description: "Optional intended edit scope. If supplied, worker should not modify files outside these paths unless the task is impossible without doing so, in which case it must stop and report the conflict.",
      maxItems: 100,
    }),
  ),
  verificationCommands: Type.Optional(
    Type.Array(Type.String({ description: "Command to run after edits, from the repository root unless the command itself changes directory." }), {
      description: "Optional verification commands to run after implementing the change.",
      maxItems: 20,
    }),
  ),
  effort: Type.Optional(
    Type.String({
      enum: [...WORKER_EFFORTS],
      description: "Implementation effort. Controls the worker model's reasoning level: quick uses low reasoning for small/local edits, standard uses medium reasoning, and thorough uses high reasoning for deeper in-scope implementation and broader validation.",
      default: "standard",
    }),
  ),
});

export const WORKER_CONFIG: ScoutConfig = {
  name: "worker",
  thinkingLevelForParams: (params) => workerThinkingLevel(params.effort),
  modelTargets: SCOUT_MODEL_TARGETS.worker,
  buildSystemPrompt: buildWorkerSystemPrompt,
  buildUserPrompt: buildWorkerUserPrompt,
  createTools: (cwd) => [
    createReadTool(cwd),
    createBashTool(cwd),
    createEditTool(cwd),
    createWriteTool(cwd),
  ],
};
