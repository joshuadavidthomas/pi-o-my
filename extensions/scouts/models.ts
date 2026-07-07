// Scout model selection.
//
// Scouts use fixed ordered model target lists. The first available target wins.

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type ScoutName = "agent" | "reviewer" | "fact-check";

export interface ScoutModelTarget {
  model: string;
  thinkingLevel?: ThinkingLevel;
}

interface ParsedModelTarget {
  provider?: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

export interface ResolvedScoutModel {
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  target: ScoutModelTarget;
}

export const SCOUT_MODEL_TARGETS = {
  agent: [
    { model: "openai-codex/gpt-5.5", thinkingLevel: "medium" },
    { model: "openai/gpt-5.5", thinkingLevel: "medium" },
    { model: "claude-agent-sdk/claude-opus-4-8", thinkingLevel: "high" },
    { model: "anthropic/claude-opus-4-8", thinkingLevel: "high" },
    { model: "claude-agent-sdk/claude-sonnet-5", thinkingLevel: "medium" },
    { model: "anthropic/claude-sonnet-5", thinkingLevel: "medium" },
  ],
  reviewer: [
    { model: "openai-codex/gpt-5.5", thinkingLevel: "medium" },
    { model: "openai/gpt-5.5", thinkingLevel: "medium" },
    { model: "claude-agent-sdk/claude-opus-4-8", thinkingLevel: "high" },
    { model: "anthropic/claude-opus-4-8", thinkingLevel: "high" },
  ],
  "fact-check": [
    { model: "openai-codex/gpt-5.5", thinkingLevel: "low" },
    { model: "openai/gpt-5.5", thinkingLevel: "low" },
    { model: "claude-agent-sdk/claude-haiku-4-5", thinkingLevel: "low" },
    { model: "anthropic/claude-haiku-4-5", thinkingLevel: "low" },
  ],
} satisfies Record<ScoutName, ScoutModelTarget[]>;

export const VALID_SCOUT_NAMES = Object.keys(SCOUT_MODEL_TARGETS) as ScoutName[];
export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ThinkingLevel[];

export function defaultModelTargetsForScout(scoutName: string): ScoutModelTarget[] {
  const baseName = scoutName.split(":", 1)[0] as ScoutName;
  return SCOUT_MODEL_TARGETS[baseName] ?? SCOUT_MODEL_TARGETS.agent;
}

export function parseModelTarget(model: string | undefined, thinkingLevel?: ThinkingLevel): ScoutModelTarget | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;

  const aliases: Record<string, string> = {
    haiku: "claude-haiku-4-5",
    sonnet: "claude-sonnet-5",
    opus: "claude-opus-4-8",
  };

  return {
    model: aliases[trimmed.toLowerCase()] ?? trimmed,
    thinkingLevel,
  };
}

function parseTarget(target: ScoutModelTarget): ParsedModelTarget | null {
  const parsed = parseModelTarget(target.model, target.thinkingLevel);
  if (!parsed) return null;

  const needle = parsed.model.toLowerCase();
  const slashIdx = needle.indexOf("/");
  if (slashIdx === -1) {
    return { modelId: needle, thinkingLevel: parsed.thinkingLevel };
  }

  const provider = needle.slice(0, slashIdx).trim();
  const modelId = needle.slice(slashIdx + 1).trim();
  if (!provider || !modelId) return null;

  return { provider, modelId, thinkingLevel: parsed.thinkingLevel };
}

export function resolveModelTarget(
  modelRegistry: ModelRegistry,
  currentModel: Model<Api> | undefined,
  target: ScoutModelTarget,
): ResolvedScoutModel | null {
  const parsed = parseTarget(target);
  if (!parsed) return null;

  const currentProvider = currentModel?.provider?.toLowerCase();
  const available = modelRegistry.getAvailable();
  const scopedModels = parsed.provider
    ? available.filter((candidate) => candidate.provider.toLowerCase() === parsed.provider)
    : available;
  const matches = scopedModels.filter((candidate) => candidate.id.toLowerCase() === parsed.modelId);

  const model = !parsed.provider && currentProvider
    ? matches.find((candidate) => candidate.provider.toLowerCase() === currentProvider) ?? matches[0]
    : matches[0];

  if (!model) return null;

  return {
    model,
    thinkingLevel: parsed.thinkingLevel,
    target,
  };
}

export function resolveFirstAvailableModelTarget(
  modelRegistry: ModelRegistry,
  currentModel: Model<Api> | undefined,
  targets: ScoutModelTarget[],
): ResolvedScoutModel | null {
  for (const target of targets) {
    const resolved = resolveModelTarget(modelRegistry, currentModel, target);
    if (resolved) return resolved;
  }
  return null;
}

export function formatModelTarget(target: ScoutModelTarget): string {
  return target.thinkingLevel ? `${target.model} (thinking: ${target.thinkingLevel})` : target.model;
}
