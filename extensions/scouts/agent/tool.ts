import { readFileSync } from "node:fs";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { executeScout, resumeScout } from "../execute.ts";
import { defaultModelTargetsForScout, parseModelTarget } from "../models.ts";
import { ScoutCall, ScoutResult } from "../render.ts";
import { loadScoutSkills } from "../resources.ts";
import { getSuspendedRun } from "../runs.ts";
import { trackScoutToolCall } from "../state.ts";
import type { ScoutConfig, ScoutDetails } from "../types.ts";
import type { AgentDefinition } from "./definitions.ts";
import { loadAgentDefinitions } from "./definitions.ts";
import { buildImplementationSystemPrompt, buildImplementationUserPrompt, implementationThinkingLevel } from "./implementation.ts";
import { acquireSharedMutationLock, sharedMutationBusyError } from "./mutation.ts";
import { AGENT_BASE_TOOL_POOL_NAMES, resolveAgentToolPool, type AgentToolPoolName } from "./tool-pool.ts";

export const AGENT_EFFORTS = ["quick", "standard", "thorough"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export const SHIPPED_AGENT_DEFINITION_SUMMARIES = [
  { name: "finder", description: "Read-only workspace scout for locating and citing exact files, symbols, and evidence." },
  { name: "librarian", description: "External research scout for GitHub code search, documentation, and web evidence." },
  { name: "oracle", description: "Read-only senior engineering advisor for deep code analysis and architecture tracing." },
  { name: "reviewer-beck", description: "Judges change economics, tidy-first sequencing, feedback, and reviewable steps." },
  { name: "reviewer-feathers", description: "Judges legacy-code change safety, characterization, seams, and behavior preservation." },
  { name: "reviewer-grug", description: "Judges maintainability through cave-walk cost, fake crystals, and smallest boring fixes." },
  { name: "reviewer-hickey", description: "Judges structural simplicity, complecting, fragmentation, and reasoning load." },
  { name: "reviewer-lamport", description: "Judges state-space models, transitions, invariants, and progress claims." },
  { name: "reviewer-lowy", description: "Judges volatility-based decomposition, information hiding, and change boundaries." },
  { name: "reviewer-muratori", description: "Judges semantic compression, actual work visibility, and performance-aware structure." },
  { name: "reviewer-ousterhout", description: "Judges change complexity, deep modules, information hiding, and interface depth." },
] as const;

const SHIPPED_AGENT_DEFINITION_DESCRIPTION = SHIPPED_AGENT_DEFINITION_SUMMARIES
  .map((definition) => `- ${definition.name}: ${definition.description}`)
  .join("\n");

export const AgentMutationParams = Type.Object({
  isolation: Type.String({
    enum: ["shared"],
    description: "Mutation isolation mode. shared edits the live checkout under the single shared-checkout mutation lock. Omit mutation for read-only agent runs.",
  }),
  allowedPaths: Type.Optional(
    Type.Array(Type.String({ description: "Path or directory the agent is allowed or expected to modify." }), {
      description: "Optional intended edit scope. If supplied, the agent should not modify files outside these paths unless the task is impossible without doing so.",
      maxItems: 100,
    }),
  ),
  verificationCommands: Type.Optional(
    Type.Array(Type.String({ description: "Command to run after edits, from the repository root unless the command itself changes directory." }), {
      description: "Optional verification commands to run after implementing the change.",
      maxItems: 20,
    }),
  ),
});

export const AgentParams = Type.Object({
  name: Type.Optional(Type.String({
    description: "Short display name for this agent run. Used in the nested scout title and run configuration name. Required unless resume is set.",
  })),
  task: Type.Optional(Type.String({
    description: "Complete brief for the agent. Required unless resume is set. When resume is set, this is an optional follow-up steering note for the suspended run and other parameters are ignored.",
  })),
  subagent_type: Type.Optional(Type.String({
    description: `Optional loaded agent definition name. Shipped definitions are:\n${SHIPPED_AGENT_DEFINITION_DESCRIPTION}\nDefinitions also load from ~/.pi/agent/agents/*.md and .pi/agents/*.md; project/user names are reported in the error if the requested name is unknown. Definition frontmatter provides defaults: tools union with the base/call-site non-mutating pool, skills append before call-site skills with duplicates removed, and frontmatter model is overridden by call-site model. A definition with an explicit tools list must include both Edit and Write to permit mutation.`,
  })),
  role: Type.Optional(Type.String({
    description: "Additional system-prompt layer for this run. Applied after definition and skills so call-site instructions win conflicts with definition content. The final agent system frame is appended after definition, skills, and role; that frame owns timeout and output-protocol rules and is not overridden by role.",
  })),
  skills: Type.Optional(Type.Array(Type.String({ description: "Installed skill name to inject as expertise." }), {
    description: "Optional installed skills to load in array order. Definition skills load first, then these call-site skills, de-duplicated by first occurrence, then role.",
    maxItems: 20,
  })),
  tools: Type.Optional(Type.Array(Type.String({ description: "Tool-pool name: read, bash, github_search, github_grep, github_read_file, github_list_dir, github_find_files, github_search_repos, web_search, or web_fetch. edit/write are granted only by mutation." }), {
    description: "Optional non-mutating tool-pool selection. Omitted means the base pool [read, bash]. When a definition also selects tools, the definition and call-site selections are unioned with the base/call-site pool as applicable.",
    maxItems: 20,
  })),
  effort: Type.Optional(Type.String({
    enum: [...AGENT_EFFORTS],
    description: "Reasoning effort for this agent: quick uses low thinking, standard uses medium thinking, thorough uses high thinking.",
    default: "standard",
  })),
  model: Type.Optional(Type.String({
    description: "Optional explicit model target. Parsed like other scouts, so aliases such as haiku/sonnet/opus are accepted. Overrides a definition frontmatter model; the frontmatter model is only a default.",
  })),
  mutation: Type.Optional(AgentMutationParams),
  resume: Type.Optional(Type.String({
    description: "Resume a suspended agent run by runId. When set, task is a follow-up steering note and other parameters are ignored; the original run configuration, tools, and model are reused with a fresh time budget.",
  })),
});

export interface AgentSkillPrompt {
  name: string;
  content: string;
  baseDir?: string;
}

export interface BuildAgentScoutConfigOptions {
  definitions: Map<string, AgentDefinition>;
  skills?: readonly AgentSkillPrompt[];
}

export type BuildAgentScoutConfigResult =
  | {
    config: ScoutConfig;
    toolNames: string[];
    skillNames: string[];
    warnings: string[];
    mutationIsolation?: "shared";
  }
  | { error: string };

type AgentMutation = {
  isolation: "shared";
  allowedPaths?: string[];
  verificationCommands?: string[];
};

type AgentToolRunners = {
  executeScout: typeof executeScout;
  resumeScout: typeof resumeScout;
  loadDefinitions: typeof loadAgentDefinitions;
  loadSkills: typeof loadAgentSkillPromptsForParams;
};

const DEFAULT_RUNNERS: AgentToolRunners = {
  executeScout,
  resumeScout,
  loadDefinitions: loadAgentDefinitions,
  loadSkills: loadAgentSkillPromptsForParams,
};

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

function agentMutation(value: unknown): AgentMutation | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "Invalid mutation: expected an object with isolation." };
  }

  const raw = value as Record<string, unknown>;
  if (raw.isolation !== "shared") {
    return { error: "Invalid mutation.isolation: expected shared." };
  }

  return {
    isolation: raw.isolation,
    allowedPaths: stringList(raw.allowedPaths),
    verificationCommands: stringList(raw.verificationCommands),
  };
}

function availableDefinitionList(definitions: Map<string, AgentDefinition>): string {
  const lines = [...definitions.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((definition) => `- ${definition.name}${definition.description ? `: ${definition.description}` : ""}`);

  return lines.length > 0 ? lines.join("\n") : "(no agent definitions are available)";
}

function mergeSkillNames(definition: AgentDefinition | undefined, callSiteSkills: readonly string[]): string[] {
  const result: string[] = [];
  for (const name of [...(definition?.skills ?? []), ...callSiteSkills]) {
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

function selectDefinition(params: Record<string, unknown>, definitions: Map<string, AgentDefinition>): AgentDefinition | undefined | { error: string } {
  const subagentType = trimmedString(params.subagent_type);
  if (!subagentType) return undefined;

  const definition = definitions.get(subagentType);
  if (definition) return definition;

  return {
    error: `Unknown subagent_type: ${subagentType}. Available subagent_type values:\n${availableDefinitionList(definitions)}`,
  };
}

function formatSkillPrompt(skill: AgentSkillPrompt): string {
  const baseDirHint = skill.baseDir
    ? `\nSkill base directory: ${skill.baseDir}\nWhen the skill references \`{baseDir}\`, resolve it to this path. When it references relative paths, resolve them against this directory.`
    : "";

  return `## Skill: ${skill.name}${baseDirHint}\n\n${skill.content.trim()}`.trim();
}

function buildAgentFrame(timeoutMs: number): string {
  const timeoutMinutes = Math.round(timeoutMs / 60_000);

  return `You are an agent subtask running inside a coding assistant.

Your job is to complete the user's task with the tools available to you. The orchestrator only receives your final assistant message, so include the useful result directly in that final message.

Guidelines:
- Stay focused on the requested task and do not perform unrelated work.
- Use tools to verify important claims when the workspace or external evidence matters.
- Be concise but complete in your final answer: summarize what you found or did, cite important files/commands when relevant, and call out unresolved issues.

Timeout: ${timeoutMinutes} minutes. Keep working until the task is complete, blocked, or the timeout is reached. Near the deadline, a steering message may warn you to wrap up. If substantial work legitimately remains, summarize progress so far and end with an exact final line of the form: MORE TIME NEEDED: <one line describing what remains>.`.trim();
}

function buildSystemPrompt(parts: string[], timeoutMs: number, mutation: AgentMutation | undefined): string {
  const frame = mutation ? buildImplementationSystemPrompt(timeoutMs) : buildAgentFrame(timeoutMs);
  return [...parts, frame].filter((part) => part.trim()).join("\n\n");
}

function createAgentTools(toolNames: readonly AgentToolPoolName[], mutation: AgentMutation | undefined) {
  const pool = resolveAgentToolPool(toolNames);
  return (cwd: string, ctx?: ExtensionContext) => {
    const tools = pool.tools.map((tool) => {
      if (mutation && tool.name === "bash") return createBashTool(cwd);
      return tool.createTool(cwd, ctx);
    });

    if (mutation) {
      tools.push(createEditTool(cwd), createWriteTool(cwd));
    }

    return tools;
  };
}

function configuredModelFor(params: Record<string, unknown>, definition: AgentDefinition | undefined): string | undefined {
  const explicit = trimmedString(params.model);
  const fallback = definition?.model;
  const parsed = parseModelTarget(explicit ?? fallback);
  return parsed?.model;
}

function agentEffort(params: Record<string, unknown>): AgentEffort {
  return params.effort === "quick" || params.effort === "thorough" ? params.effort : "standard";
}

export function buildAgentScoutConfig(
  params: Record<string, unknown>,
  options: BuildAgentScoutConfigOptions,
): BuildAgentScoutConfigResult {
  const name = trimmedString(params.name);
  const task = trimmedString(params.task);

  if (!name) return { error: "Missing required parameter: name" };
  if (!task) return { error: "Missing required parameter: task" };

  const selectedDefinition = selectDefinition(params, options.definitions);
  if (selectedDefinition && "error" in selectedDefinition) return selectedDefinition;
  const definition = selectedDefinition;

  const mutationResult = agentMutation(params.mutation);
  if (mutationResult && "error" in mutationResult) return mutationResult;
  const mutation = mutationResult;
  if (mutation && definition?.tools !== undefined && !definition.allowsMutation) {
    return {
      error: `Agent definition "${definition.name}" does not allow mutation. Add both Edit and Write to its tools list, or omit subagent_type for an inline mutating agent.`,
    };
  }

  const callSiteSkills = stringList(params.skills);
  const skillNames = mergeSkillNames(definition, callSiteSkills);
  const skillsByName = new Map((options.skills ?? []).map((skill) => [skill.name, skill]));
  const skillPrompts: string[] = [];
  for (const skillName of skillNames) {
    const skill = skillsByName.get(skillName);
    if (!skill) {
      const available = [...skillsByName.keys()].sort();
      const suggestion = available.length > 0 ? ` Available: ${available.join(", ")}` : "";
      return { error: `Skill not found: ${skillName}.${suggestion}` };
    }
    skillPrompts.push(formatSkillPrompt(skill));
  }

  const requestedToolNames = [...(definition?.tools ?? []), ...stringList(params.tools)];
  const toolSelection = requestedToolNames.length > 0 ? requestedToolNames : [...AGENT_BASE_TOOL_POOL_NAMES];
  const toolResolution = resolveAgentToolPool(toolSelection);
  const effort = agentEffort(params);
  const systemParts = [
    definition?.systemPrompt ?? "",
    ...skillPrompts,
    trimmedString(params.role) ?? "",
  ];

  const config: ScoutConfig = {
    name: `agent:${name}`,
    isMutatingWorker: mutation?.isolation === "shared",
    configuredModel: configuredModelFor(params, definition),
    modelTargets: defaultModelTargetsForScout("agent"),
    thinkingLevelForParams: (): ThinkingLevel => implementationThinkingLevel(effort),
    buildSystemPrompt: (timeoutMs) => buildSystemPrompt(systemParts, timeoutMs, mutation),
    buildUserPrompt: () => mutation
      ? buildImplementationUserPrompt({
        task,
        effort,
        allowedPaths: mutation.allowedPaths,
        verificationCommands: mutation.verificationCommands,
      })
      : task,
    createTools: createAgentTools(toolResolution.toolNames, mutation),
  };

  return {
    config,
    toolNames: mutation ? [...toolResolution.toolNames, "edit", "write"] : toolResolution.toolNames,
    skillNames,
    warnings: toolResolution.warnings,
    ...(mutation?.isolation === "shared" ? { mutationIsolation: "shared" as const } : {}),
  };
}

async function loadAgentSkillPromptsForParams(
  cwd: string,
  params: Record<string, unknown>,
  definitions: Map<string, AgentDefinition>,
): Promise<readonly AgentSkillPrompt[] | { error: string }> {
  const selectedDefinition = selectDefinition(params, definitions);
  if (selectedDefinition && "error" in selectedDefinition) return selectedDefinition;
  const definition = selectedDefinition;
  const skillNames = mergeSkillNames(definition, stringList(params.skills));
  if (skillNames.length === 0) return [];

  const allSkills = await loadScoutSkills(cwd);
  const skillsByName = new Map(allSkills.map((skill) => [skill.name, skill]));
  const result: AgentSkillPrompt[] = [];

  for (const skillName of skillNames) {
    const skill = skillsByName.get(skillName);
    if (!skill) {
      const names = allSkills.map((s) => s.name).sort();
      const suggestion = names.length > 0 ? ` Available: ${names.join(", ")}` : "";
      return { error: `Skill not found: ${skillName}.${suggestion}` };
    }

    try {
      result.push({
        name: skill.name,
        content: readFileSync(skill.filePath, "utf-8"),
        baseDir: skill.baseDir,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Failed to read ${skill.filePath}: ${message}` };
    }
  }

  return result;
}

function resumeRunId(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const rawResume = (params as { resume?: unknown }).resume;
  if (rawResume === undefined) return undefined;
  return typeof rawResume === "string" ? rawResume.trim() : "";
}

class AgentToolCallError extends Error {}

function failAgentToolCall(message: string): never {
  throw new AgentToolCallError(message);
}

function errorResultText(result: { content: Array<{ type: "text"; text: string }> }): string {
  return result.content[0]?.text ?? "Agent tool call failed.";
}

function validateAgentParams(params: Record<string, unknown>): string | null {
  const resume = resumeRunId(params);
  if (resume !== undefined) {
    if (!resume) return "Invalid parameters: expected `resume` to be a non-empty string.";
    return null;
  }

  if (!trimmedString(params.name)) return "Missing required parameter: name";
  if (!trimmedString(params.task)) return "Missing required parameter: task";
  return null;
}

export async function executeAgentToolCall(
  toolCallId: string | undefined,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: Parameters<ToolDefinition<typeof AgentParams, ScoutDetails>["execute"]>[3],
  ctx: ExtensionContext,
  runners: AgentToolRunners = DEFAULT_RUNNERS,
) {
  const validationError = validateAgentParams(params);
  if (validationError) failAgentToolCall(validationError);

  const resume = resumeRunId(params);
  const resumeLockRequired = resume ? getSuspendedRun(resume)?.isMutatingWorker === true : false;
  const finishTracking = trackScoutToolCall(toolCallId);
  const releaseResumeLock = resumeLockRequired ? acquireSharedMutationLock(toolCallId || "agent") : undefined;
  if (resumeLockRequired && !releaseResumeLock) {
    finishTracking();
    failAgentToolCall(errorResultText(sharedMutationBusyError(trimmedString(params.task) ?? "")));
  }

  try {
    if (resume) return await runners.resumeScout(resume, params.task, signal, onUpdate);

    const loadedDefinitions = runners.loadDefinitions(ctx.cwd);
    const loadedSkills = await runners.loadSkills(ctx.cwd, params, loadedDefinitions.definitions);
    if ("error" in loadedSkills) failAgentToolCall(loadedSkills.error);

    const built = buildAgentScoutConfig(params, {
      definitions: loadedDefinitions.definitions,
      skills: loadedSkills,
    });
    if ("error" in built) failAgentToolCall(built.error);

    const releaseMutationLock = built.mutationIsolation === "shared" ? acquireSharedMutationLock(toolCallId || "agent") : undefined;
    if (built.mutationIsolation === "shared" && !releaseMutationLock) {
      failAgentToolCall(errorResultText(sharedMutationBusyError(trimmedString(params.task) ?? "")));
    }

    try {
      return await runners.executeScout(
        built.config,
        { ...params, query: trimmedString(params.task) ?? "" },
        signal,
        onUpdate,
        ctx,
      );
    } finally {
      releaseMutationLock?.();
    }
  } catch (error) {
    if (error instanceof AgentToolCallError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent setup failed: ${message}`);
  } finally {
    releaseResumeLock?.();
    finishTracking();
  }
}

export const AGENT_TOOL: ToolDefinition<typeof AgentParams, ScoutDetails> = {
  name: "agent",
  label: "Agent",
  description: [
    "Dynamic scout subagent. Use for one in-process child run: pick a loaded definition with subagent_type (for example finder, oracle, librarian, or reviewer-*), add inline role/skills/tools/model, or opt into bounded mutation with mutation.",
    "Read-only by default with the base pool [read, bash]. The tools parameter selects only from the non-mutating pool: read, bash, github_search, github_grep, github_read_file, github_list_dir, github_find_files, github_search_repos, web_search, web_fetch. edit/write require mutation, and a selected definition with an explicit tools list must also include both Edit and Write.",
    "mutation.isolation=shared edits the live checkout under the fail-fast single shared-checkout mutation lock. Omit mutation for read-only agent runs. Mutation cannot expand a selected definition's explicit tool allowlist.",
    `Shipped subagent_type values:\n${SHIPPED_AGENT_DEFINITION_DESCRIPTION}`,
    "Definitions are also loaded from ~/.pi/agent/agents/*.md and .pi/agents/*.md. This static registration cannot enumerate project-specific definition names in the schema; if subagent_type is unknown, the error lists available names and descriptions.",
    "Precedence: definition frontmatter tools union with the base/call-site pool; definition skills append before call-site skills with duplicates removed; definition frontmatter model is a default and call-site model overrides it. Definition body, skills, and role are followed by the final agent system frame, which owns timeout/output-protocol rules.",
  ].join("\n"),
  parameters: AgentParams,

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executeAgentToolCall(toolCallId, params as Record<string, unknown>, signal, onUpdate, ctx);
  },

  renderCall(args, theme, context) {
    const p = args as { name?: string; subagent_type?: string };
    const suffix = p?.subagent_type ? p.subagent_type : p?.name ? p.name : undefined;
    return new ScoutCall("agent", { theme, executionStarted: context.executionStarted, titleSuffix: suffix });
  },

  renderResult(result, options, theme, context) {
    const p = context.args as { name?: string; subagent_type?: string };
    const suffix = p?.subagent_type ? p.subagent_type : p?.name;
    const component = context.lastComponent instanceof ScoutResult
      ? context.lastComponent
      : new ScoutResult(result, options, theme, "agent", suffix);
    component.update(result, options, theme, context.invalidate);
    return component;
  },
};
