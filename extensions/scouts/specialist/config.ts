import { readFileSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";

import { SCOUT_MODEL_TARGETS } from "../models.ts";
import { loadScoutSkills } from "../resources.ts";
import type { ScoutConfig } from "../types.ts";
import { buildSpecialistSystemPrompt, buildSpecialistUserPrompt } from "./prompt.ts";

export type SpecialistTool = "read" | "bash" | "write" | "edit";

export const SpecialistParams = Type.Object({
  skill: Type.String({
    description: [
      "Name of the skill to load as domain expertise.",
      "The specialist becomes an expert in this skill and applies it to the task.",
      "Skill names are listed in the <available_skills> section of your system prompt. If the name doesn't match, the error response lists installed skills.",
    ].join("\n"),
  }),
  task: Type.String({
    description: [
      "The task for the specialist to execute using the loaded skill.",
      "Be specific about what you want analyzed, reviewed, created, or investigated.",
    ].join("\n"),
  }),
  tools: Type.Optional(
    Type.Array(
      Type.String({ enum: ["read", "bash", "write", "edit"] }),
      { description: "Tools the specialist can use. Defaults to [\"read\", \"bash\"]. Add \"write\" and \"edit\" for tasks that need to modify files." },
    ),
  ),
});

const DEFAULT_TOOLS: SpecialistTool[] = ["read", "bash"];

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    return parseYaml(match[1]) ?? {};
  } catch {
    return {};
  }
}

export async function buildSpecialistConfig(
  skillName: string,
  cwd: string,
  options?: { configName?: string; tools?: SpecialistTool[] },
): Promise<ScoutConfig | { error: string }> {
  const trimmed = skillName.trim();

  if (!trimmed) {
    return { error: "Specialist requires a skill name." };
  }

  const allSkills = await loadScoutSkills(cwd);
  const match = allSkills.find((s) => s.name === trimmed);

  if (!match) {
    const names = allSkills.map((s) => s.name);
    const suggestion = names.length > 0 ? ` Available: ${names.join(", ")}` : "";
    return { error: `Skill not found: ${trimmed}.${suggestion}` };
  }

  let content: string;
  try {
    content = readFileSync(match.filePath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to read ${match.filePath}: ${message}` };
  }

  const fm = parseFrontmatter(content);
  const configName = options?.configName ?? `specialist:${trimmed}`;
  const tools = options?.tools ?? DEFAULT_TOOLS;

  const frontmatterModel = fm.model as string | undefined;

  return {
    name: configName,
    configuredModel: frontmatterModel,
    modelTargets: SCOUT_MODEL_TARGETS.specialist,
    defaultThinkingLevel: (fm["thinking-level"] as ThinkingLevel) || undefined,
    buildSystemPrompt: (timeoutMs) => buildSpecialistSystemPrompt(content, timeoutMs, match.baseDir),
    buildUserPrompt: buildSpecialistUserPrompt,
    createTools: (runtimeCwd) => {
      const toolBuilders: Record<SpecialistTool, () => any> = {
        read: () => createReadTool(runtimeCwd),
        bash: () => createBashTool(runtimeCwd),
        write: () => createWriteTool(runtimeCwd),
        edit: () => createEditTool(runtimeCwd),
      };
      return tools.map((t) => toolBuilders[t]());
    },
  };
}
