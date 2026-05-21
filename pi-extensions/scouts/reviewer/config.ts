import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadTool, type ExtensionContext } from "@mariozechner/pi-coding-agent";

import { createFactCheckTool } from "./tools/fact-check.ts";
import type { ScoutConfig } from "../types.ts";
import { buildSpecialistSystemPrompt, buildSpecialistUserPrompt } from "../specialist/prompt.ts";
import { createReadOnlyBashTool } from "../tools/read-only-bash.ts";

export const REVIEW_LENSES = ["hickey", "lowy", "grug", "beck", "muratori"] as const;
export type ReviewLens = (typeof REVIEW_LENSES)[number];

export function isReviewLens(value: unknown): value is ReviewLens {
  return typeof value === "string" && (REVIEW_LENSES as readonly string[]).includes(value);
}

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
      createReadOnlyBashTool(cwd),
      ...(ctx ? [createFactCheckTool(ctx)] : []),
    ],
  };
}
