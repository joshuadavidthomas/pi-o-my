// Scout model selection.
//
// This file holds both the low-level model lookup helpers and the scout
// workload mapping that turns provider + workload into one selected model.

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type ScoutWorkload = "fast" | "balanced" | "deep";

export interface ModelTarget {
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  provider?: string;
}

export interface WorkloadModelPolicy {
  targetsByProvider: Record<string, Partial<Record<ScoutWorkload, ModelTarget>>>;
  fallbackByWorkload: Record<ScoutWorkload, ModelTarget>;
}

export interface ResolveWorkloadModelPlan {
  explicitModelId?: string;
  provider: string;
  workload: ScoutWorkload;
  policy?: WorkloadModelPolicy;
}

export interface ResolvedWorkloadModel {
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
}

function findMatchingModels(models: Model<Api>[], needle: string): Model<Api>[] {
  const exactMatches = models.filter((model) => model.id.toLowerCase() === needle);
  if (exactMatches.length > 0) return exactMatches;

  return models.filter((model) => model.id.toLowerCase().includes(needle));
}

function parseModelTarget(modelId: string | undefined): ModelTarget | null {
  const trimmedModelId = modelId?.trim();
  if (!trimmedModelId) return null;

  const needle = trimmedModelId.toLowerCase();
  const aliasTargets: Record<string, ModelTarget> = {
    haiku: { modelId: "claude-haiku-4-5" },
    sonnet: { modelId: "claude-sonnet-4-6" },
    opus: { modelId: "claude-opus-4-7" },
  };
  const aliasTarget = aliasTargets[needle];
  if (aliasTarget) return aliasTarget;

  const slashIdx = needle.indexOf("/");
  if (slashIdx === -1) {
    return { modelId: needle };
  }

  const provider = needle.slice(0, slashIdx).trim();
  const scopedModelId = needle.slice(slashIdx + 1).trim();
  if (!provider || !scopedModelId) return null;

  return {
    provider,
    modelId: scopedModelId,
  };
}

// Infer a model's family from its ID prefix. Used by cross-family diversity
// resolution. Extend when new families appear — unrecognized IDs return
// undefined and skip diversity resolution entirely.
function inferFamily(modelId: string): string | undefined {
  const id = modelId.toLowerCase();
  if (id.startsWith("claude-")) return "anthropic";
  if (id.startsWith("gpt-")) return "openai";
  if (id.startsWith("gemini-")) return "google";
  if (id.startsWith("glm-")) return "zai";
  return undefined;
}

// Maps a current model family to one or more partner families for cross-family
// second opinions. When multiple partners are listed, one is chosen at random
// per scout invocation.
export const ORACLE_FAMILY_PARTNERS: Record<string, string[]> = {
  anthropic: ["openai"],
  openai: ["anthropic"],
  google: ["openai", "anthropic"],
  zai: ["openai"],
};

// Family-level provider preference. Internal policy-driven scout resolution uses
// this order when it wants a model family; explicit user-qualified overrides
// like `anthropic/claude-opus-4-6` still stay exact.
export const PRIMARY_PROVIDERS_BY_FAMILY: Record<string, string[]> = {
  anthropic: ["claude-agent-sdk", "anthropic"],
  openai: ["openai-codex", "openai", "github-copilot"],
};

export const DEFAULT_WORKLOAD_MODEL_POLICY: WorkloadModelPolicy = {
  targetsByProvider: {
    openai: {
      fast: { modelId: "gpt-5.4-mini", thinkingLevel: "low" },
      balanced: { modelId: "gpt-5.5", thinkingLevel: "medium" },
      deep: { modelId: "gpt-5.5", thinkingLevel: "high" },
    },
    "openai-codex": {
      fast: { modelId: "gpt-5.4-mini", thinkingLevel: "low" },
      balanced: { modelId: "gpt-5.5", thinkingLevel: "medium" },
      deep: { modelId: "gpt-5.5", thinkingLevel: "high" },
    },
    anthropic: {
      fast: { modelId: "claude-haiku-4-5", thinkingLevel: "low" },
      balanced: { modelId: "claude-sonnet-4-6", thinkingLevel: "medium" },
      deep: { modelId: "claude-opus-4-7", thinkingLevel: "high" },
    },
    "claude-agent-sdk": {
      fast: { modelId: "claude-haiku-4-5", thinkingLevel: "low" },
      balanced: { modelId: "claude-sonnet-4-6", thinkingLevel: "medium" },
      deep: { modelId: "claude-opus-4-7", thinkingLevel: "high" },
    },
    google: {
      fast: { modelId: "gemini-2.5-flash", thinkingLevel: "low" },
      balanced: { modelId: "gemini-2.5-pro", thinkingLevel: "medium" },
      deep: { modelId: "gemini-3.1-pro-preview", thinkingLevel: "high" },
    },
    "github-copilot": {
      fast: { modelId: "gpt-5-mini", thinkingLevel: "low" },
      balanced: { modelId: "gpt-5.4-mini", thinkingLevel: "low" },
      deep: { modelId: "gpt-5.4", thinkingLevel: "xhigh" },
    },
    zai: {
      fast: { modelId: "glm-4.7-flash", thinkingLevel: "low" },
      balanced: { modelId: "glm-5-turbo", thinkingLevel: "medium" },
      deep: { modelId: "glm-5.1", thinkingLevel: "high" },
    },
  },
  fallbackByWorkload: {
    fast: { provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "low" },
    balanced: { provider: "anthropic", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" },
    deep: { provider: "anthropic", modelId: "claude-opus-4-7", thinkingLevel: "high" },
  },
};

function resolveTarget(
  modelRegistry: ModelRegistry,
  currentModel: Model<Api> | undefined,
  target: ModelTarget,
): ResolvedWorkloadModel | null {
  const available = modelRegistry.getAvailable();
  const currentProvider = currentModel?.provider?.toLowerCase();

  // Provider-qualified targets are scoped to that provider exactly.
  const scopedModels = target.provider
    ? available.filter((candidate) => candidate.provider.toLowerCase() === target.provider)
    : available;

  const matches = findMatchingModels(scopedModels, target.modelId);

  // Unqualified targets search globally, then prefer the current provider as a tie-break.
  let orderedMatches = matches;
  if (!target.provider && currentProvider) {
    const preferred: Model<Api>[] = [];
    const others: Model<Api>[] = [];

    for (const candidate of matches) {
      if (candidate.provider.toLowerCase() === currentProvider) {
        preferred.push(candidate);
      } else {
        others.push(candidate);
      }
    }

    orderedMatches = [...preferred, ...others];
  }

  const model = orderedMatches[0];
  if (!model) return null;

  return {
    model,
    thinkingLevel: target.thinkingLevel,
  };
}

function hasAvailableProvider(modelRegistry: ModelRegistry, provider: string): boolean {
  const normalizedProvider = provider.toLowerCase();
  return modelRegistry.getAvailable().some((model) => model.provider.toLowerCase() === normalizedProvider);
}

function resolvePreferredProviderTarget(
  modelRegistry: ModelRegistry,
  currentModel: Model<Api> | undefined,
  target: ModelTarget,
  provider: string,
): ResolvedWorkloadModel | null {
  const providers = PRIMARY_PROVIDERS_BY_FAMILY[provider] ?? [provider];

  for (const candidateProvider of providers) {
    if (!hasAvailableProvider(modelRegistry, candidateProvider)) continue;

    const match = resolveTarget(modelRegistry, currentModel, {
      ...target,
      provider: candidateProvider,
    });
    if (match) return match;
  }

  return null;
}

// Resolve a model from a partner family for cross-family diversity.
// Prefers the current session's provider when it can serve the partner family
// (keeps auth/billing lane), otherwise uses the partner family's native
// provider entry. Returns null when nothing matches — callers are expected to
// fall back to in-family workload resolution.
export function resolveDiversityModel(
  modelRegistry: ModelRegistry,
  currentModel: Model<Api> | undefined,
  workload: ScoutWorkload,
  partners: Record<string, string[]>,
  policy: WorkloadModelPolicy = DEFAULT_WORKLOAD_MODEL_POLICY,
): ResolvedWorkloadModel | null {
  if (!currentModel) return null;

  const currentFamily = inferFamily(currentModel.id);
  if (!currentFamily) return null;

  const candidates = partners[currentFamily];
  if (!candidates?.length) return null;

  const partnerFamily = candidates[Math.floor(Math.random() * candidates.length)]!;

  const currentProvider = currentModel.provider.toLowerCase();
  const sameProviderTarget = policy.targetsByProvider[currentProvider]?.[workload];
  if (sameProviderTarget && inferFamily(sameProviderTarget.modelId) === partnerFamily) {
    const match = resolveTarget(modelRegistry, currentModel, {
      ...sameProviderTarget,
      provider: currentProvider,
    });
    if (match) return match;
  }

  const crossProviderTarget = policy.targetsByProvider[partnerFamily]?.[workload];
  if (crossProviderTarget) {
    const match = resolvePreferredProviderTarget(
      modelRegistry,
      currentModel,
      crossProviderTarget,
      partnerFamily,
    );
    if (match) return match;
  }

  return null;
}

export function resolveWorkloadModel(
  modelRegistry: ModelRegistry,
  currentModel: Model<Api> | undefined,
  plan: ResolveWorkloadModelPlan,
): ResolvedWorkloadModel | null {
  const policy = plan.policy ?? DEFAULT_WORKLOAD_MODEL_POLICY;
  const explicitModelId = plan.explicitModelId?.trim();
  const provider = plan.provider.trim().toLowerCase();

  if (explicitModelId) {
    const explicitTarget = parseModelTarget(explicitModelId);
    if (!explicitTarget) return null;

    return resolveTarget(modelRegistry, currentModel, explicitTarget);
  }

  const target = policy.targetsByProvider[provider]?.[plan.workload];
  if (target) {
    const selectedModel = resolvePreferredProviderTarget(modelRegistry, currentModel, target, provider);
    if (selectedModel) return selectedModel;
  }

  const fallback = policy.fallbackByWorkload[plan.workload];
  const fallbackMatch = fallback.provider
    ? resolvePreferredProviderTarget(modelRegistry, currentModel, fallback, fallback.provider)
    : resolveTarget(modelRegistry, currentModel, fallback);

  if (!fallbackMatch) return null;

  return fallbackMatch;
}
