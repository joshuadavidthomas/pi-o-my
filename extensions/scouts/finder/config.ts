import { Type } from "typebox";

import { createReadTool } from "@earendil-works/pi-coding-agent";

import { SCOUT_MODEL_TARGETS } from "../models.ts";
import { createReadOnlyBashTool } from "../tools/read-only-bash.ts";
import type { ScoutConfig } from "../types.ts";
import { buildFinderSystemPrompt, buildFinderUserPrompt } from "./prompt.ts";

export const FinderParams = Type.Object({
  query: Type.String({
    description: [
      "Describe what to find in the workspace (code + personal files).",
      "Include: (1) specific goal, (2) optional scope hints if known (paths/directories), (3) search hints (keywords/identifiers/filenames/extensions/metadata clues), (4) desired output type (paths, line ranges, directory structure, metadata), (5) what counts as 'found'.",
      "Finder uses read-only shell commands (rg/fd/grep/ls/stat) plus read.",
      "Examples:",
      "- Code: 'Find where user authentication is implemented. Search under src/auth and src/api for login/auth/authenticate, and return entrypoint + token handling with line ranges.'",
      "- Personal: 'In ~/Documents and ~/Desktop, find my latest trip itinerary PDF and list the top candidate paths with evidence.'",
    ].join("\n"),
  }),
});

export const FINDER_CONFIG: ScoutConfig = {
  name: "finder",
  modelTargets: SCOUT_MODEL_TARGETS.finder,
  buildSystemPrompt: buildFinderSystemPrompt,
  buildUserPrompt: buildFinderUserPrompt,
  createTools: (cwd) => [
    createReadOnlyBashTool(cwd),
    createReadTool(cwd),
  ],
};
