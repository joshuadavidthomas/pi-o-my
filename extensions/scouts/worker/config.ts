import { Type } from "typebox";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";

import type { ScoutConfig } from "../types.ts";
import { ModelParam } from "../validate.ts";
import { buildWorkerSystemPrompt, buildWorkerUserPrompt } from "./prompt.ts";

export const WorkerParams = Type.Object({
  query: Type.String({
    description: [
      "Complete implementation brief for the Worker subagent.",
      "Use worker only after the main agent/orchestrator has decided what to change. Worker is for bounded implementation, mechanical edits, and running requested verification — not open-ended discovery or architecture planning.",
      "Include the desired end state, relevant files/components, constraints, and what should not change.",
      "For research or code understanding, use finder/oracle/librarian before worker.",
      "Example: 'Implement the validator scout. Add config/prompt/tool files, register it in index.ts, update README, and follow existing scout patterns.'",
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
  model: ModelParam,
});

export const WORKER_CONFIG: ScoutConfig = {
  name: "worker",
  maxTurns: 18,
  workload: "balanced",
  buildSystemPrompt: buildWorkerSystemPrompt,
  buildUserPrompt: buildWorkerUserPrompt,
  createTools: (cwd) => [
    createReadTool(cwd),
    createBashTool(cwd),
    createEditTool(cwd),
    createWriteTool(cwd),
  ],
};
