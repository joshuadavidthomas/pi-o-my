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
  query: Type.Optional(Type.String({
    description: [
      "Complete implementation or validation brief for the Worker subagent. Required unless resume is set.",
      "Use worker when the concrete change or verification target is already known. Worker is for bounded implementation, mechanical edits, and running requested verification — not open-ended discovery or architecture planning.",
      "Include the desired end state, relevant files/components, constraints, and what should not change. For validation-only tasks, set readOnly: true.",
      "When resume is set, query is an optional short follow-up instruction or steering note for the resumed run.",
      "For research or code understanding, use finder/oracle/librarian before worker.",
      "Example: 'Update the scout model resolver. Change models.ts and related tests, then run the scout test suite.'",
    ].join("\n"),
  })),
  resume: Type.Optional(
    Type.String({
      description: "Resume a suspended worker run by its runId (from a previous timeout or more-time result). When set, `query` becomes an optional follow-up instruction for the resumed run and other parameters are ignored; the original run's configuration, tools, and model are reused. A resumed run gets a fresh time budget.",
    }),
  ),
  readOnly: Type.Optional(
    Type.Boolean({
      description: "Set true for validation-only runs. The worker gets no edit or write tools, so it cannot modify files, and it runs without the single-worker lock so it can go in parallel with a mutating worker.",
      default: false,
    }),
  ),
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

const BASE_WORKER_CONFIG = {
  name: "worker",
  thinkingLevelForParams: (params: Record<string, unknown>) => workerThinkingLevel(params.effort),
  modelTargets: SCOUT_MODEL_TARGETS.worker,
  buildUserPrompt: buildWorkerUserPrompt,
} satisfies Partial<ScoutConfig>;

export const WORKER_CONFIG: ScoutConfig = {
  ...BASE_WORKER_CONFIG,
  isMutatingWorker: true,
  buildSystemPrompt: (timeoutMs) => buildWorkerSystemPrompt(timeoutMs, false),
  createTools: (cwd) => [
    createReadTool(cwd),
    createBashTool(cwd),
    createEditTool(cwd),
    createWriteTool(cwd),
  ],
};

export const READ_ONLY_WORKER_CONFIG: ScoutConfig = {
  ...BASE_WORKER_CONFIG,
  isMutatingWorker: false,
  buildSystemPrompt: (timeoutMs) => buildWorkerSystemPrompt(timeoutMs, true),
  createTools: (cwd) => [
    createReadTool(cwd),
    createBashTool(cwd),
  ],
};
