import { Type } from "typebox";
import { createBashTool, createReadTool } from "@earendil-works/pi-coding-agent";

import type { ScoutConfig } from "../types.ts";
import { ModelParam } from "../validate.ts";
import { buildValidatorSystemPrompt, buildValidatorUserPrompt } from "./prompt.ts";

export const ValidatorParams = Type.Object({
  query: Type.String({
    description: [
      "Describe what to validate and what counts as success.",
      "Include the relevant feature/change, expected checks, important constraints, and how failures should be summarized.",
      "Use validator for noisy builds, tests, linters, typecheckers, repro commands, and log-heavy verification so the main context stays clean.",
      "Validator does not edit files. For fixes, use worker or the main agent after reviewing validator output.",
      "Example: 'Validate the scout extension after adding worker and validator. Run typecheck and relevant tests. Summarize failures with file references.'",
    ].join("\n"),
  }),
  commands: Type.Optional(
    Type.Array(Type.String({ description: "Exact command to run, from the repository root unless the command itself changes directory." }), {
      description: "Optional commands to run first, in order. If omitted, validator may inspect project scripts and infer likely checks.",
      maxItems: 20,
    }),
  ),
  model: ModelParam,
});

export const VALIDATOR_CONFIG: ScoutConfig = {
  name: "validator",
  maxTurns: 10,
  workload: "fast",
  buildSystemPrompt: buildValidatorSystemPrompt,
  buildUserPrompt: buildValidatorUserPrompt,
  createTools: (cwd) => [
    createReadTool(cwd),
    createBashTool(cwd),
  ],
};
