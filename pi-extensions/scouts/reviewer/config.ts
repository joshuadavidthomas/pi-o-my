import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashTool, createReadTool, type ExtensionContext } from "@mariozechner/pi-coding-agent";

import { createFactCheckTool } from "./tools/fact-check.ts";
import type { ScoutConfig } from "../types.ts";
import { buildSpecialistSystemPrompt, buildSpecialistUserPrompt } from "../specialist/prompt.ts";

export type ReviewLens = "hickey" | "lowy" | "grug";

const REVIEWER_DIR = dirname(fileURLToPath(import.meta.url));
const LENSES_DIR = join(REVIEWER_DIR, "lenses");

function promptPath(lens: ReviewLens): string {
  return join(LENSES_DIR, `${lens}.md`);
}

function promptContent(lens: ReviewLens): string {
  return readFileSync(promptPath(lens), "utf8");
}

export function buildReviewerConfig(lens: ReviewLens): ScoutConfig {
  const content = promptContent(lens);

  return {
    name: `reviewer:${lens}`,
    maxTurns: 24,
    workload: "balanced",
    buildSystemPrompt: (maxTurns) => buildSpecialistSystemPrompt(content, maxTurns, LENSES_DIR),
    buildUserPrompt: buildSpecialistUserPrompt,
    createTools: (cwd, ctx) => [
      createReadTool(cwd),
      createBashTool(cwd),
      ...(ctx ? [createFactCheckTool(ctx)] : []),
    ],
  };
}
