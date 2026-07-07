import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createFactCheckTool } from "./tools/fact-check.ts";
import { SCOUT_MODEL_TARGETS } from "../models.ts";
import type { ScoutConfig } from "../types.ts";
import { createReadOnlyBashTool } from "../tools/read-only-bash.ts";
import { buildReviewerSystemPrompt, buildReviewerUserPrompt } from "./prompt.ts";

export const REVIEW_LENSES = ["hickey", "lowy", "grug", "beck", "muratori", "lamport", "ousterhout", "feathers"] as const;
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
    modelTargets: SCOUT_MODEL_TARGETS.reviewer,
    buildSystemPrompt: (timeoutMs) => buildReviewerSystemPrompt(content, timeoutMs, LENSES_DIR),
    buildUserPrompt: buildReviewerUserPrompt,
    createTools: (cwd, ctx) => [
      createReadTool(cwd),
      createReadOnlyBashTool(cwd),
      ...(ctx ? [createFactCheckTool(ctx)] : []),
    ],
  };
}
