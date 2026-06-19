import { describe, expect, it } from "bun:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { resolveWorkloadModel, type ScoutWorkload } from "./models.ts";

const authStorage = AuthStorage.inMemory({
  openai: { type: "api_key", key: "test-openai" },
  "openai-codex": { type: "api_key", key: "test-openai-codex" },
  anthropic: { type: "api_key", key: "test-anthropic" },
  google: { type: "api_key", key: "test-google" },
  "github-copilot": { type: "api_key", key: "test-github-copilot" },
});

const registry = ModelRegistry.inMemory(authStorage);
registry.registerProvider("openai-codex", {
  baseUrl: "https://openai-codex.test",
  apiKey: "test-openai-codex",
  api: "openai-responses",
  models: [
    {
      id: "gpt-5.4-mini",
      name: "GPT 5.4 mini (Codex)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.3125 },
      contextWindow: 400000,
      maxTokens: 128000,
    },
    {
      id: "gpt-5.4",
      name: "GPT 5.4 (Codex)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.5625 },
      contextWindow: 400000,
      maxTokens: 128000,
    },
    {
      id: "gpt-5.2-codex",
      name: "GPT 5.2 Codex",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.5625 },
      contextWindow: 400000,
      maxTokens: 128000,
    },
    {
      id: "gpt-5.5",
      name: "GPT 5.5 (Codex)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.5625 },
      contextWindow: 400000,
      maxTokens: 128000,
    },
  ],
});
registry.registerProvider("claude-agent-sdk", {
  baseUrl: "https://claude-agent-sdk.test",
  apiKey: "test-claude-agent-sdk",
  api: "anthropic-messages",
  models: [
    {
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5 (Claude Agent SDK)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      contextWindow: 200000,
      maxTokens: 64000,
    },
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6 (Claude Agent SDK)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: 64000,
    },
    {
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7 (Claude Agent SDK)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
      contextWindow: 200000,
      maxTokens: 64000,
    },
  ],
});

function getCurrentModel(provider: string, modelId: string, modelRegistry: ModelRegistry = registry): Model<Api> {
  const model = modelRegistry.find(provider, modelId);
  expect(model).toBeDefined();
  return model!;
}

function resolveForMainSession(
  currentModel: Model<Api>,
  workload: ScoutWorkload,
  modelRegistry: ModelRegistry = registry,
) {
  return resolveWorkloadModel(modelRegistry, currentModel, {
    provider: currentModel.provider,
    workload,
  });
}

describe("scout model selection from a main session", () => {
  it("github-copilot main session resolves a single route-local model for each scout workload", () => {
    const currentModel = getCurrentModel("github-copilot", "gpt-5.4");

    const fast = resolveForMainSession(currentModel, "fast");
    const balanced = resolveForMainSession(currentModel, "balanced");
    const deep = resolveForMainSession(currentModel, "deep");

    expect(fast).not.toBeNull();
    expect(fast?.model.provider).toBe("github-copilot");
    expect(fast?.model.id).toBe("gpt-5-mini");
    expect(fast?.thinkingLevel).toBe("low");

    expect(balanced).not.toBeNull();
    expect(balanced?.model.provider).toBe("github-copilot");
    expect(balanced?.model.id).toBe("gpt-5.4-mini");
    expect(balanced?.thinkingLevel).toBe("low");

    expect(deep).not.toBeNull();
    expect(deep?.model.provider).toBe("github-copilot");
    expect(deep?.model.id).toBe("gpt-5.4");
    expect(deep?.thinkingLevel).toBe("xhigh");
  });

  it("anthropic main session prefers claude-agent-sdk for anthropic-family workload defaults", () => {
    const currentModel = getCurrentModel("anthropic", "claude-sonnet-4-6");

    const fast = resolveForMainSession(currentModel, "fast");
    const balanced = resolveForMainSession(currentModel, "balanced");
    const deep = resolveForMainSession(currentModel, "deep");

    expect(fast?.model.provider).toBe("claude-agent-sdk");
    expect(fast?.model.id).toBe("claude-haiku-4-5");

    expect(balanced?.model.provider).toBe("claude-agent-sdk");
    expect(balanced?.model.id).toBe("claude-sonnet-4-6");

    expect(deep?.model.provider).toBe("claude-agent-sdk");
    expect(deep?.model.id).toBe("claude-opus-4-7");
  });

  it("claude-agent-sdk main session keeps using claude-agent-sdk workload mappings", () => {
    const currentModel = getCurrentModel("claude-agent-sdk", "claude-sonnet-4-6");

    const fast = resolveForMainSession(currentModel, "fast");
    const balanced = resolveForMainSession(currentModel, "balanced");
    const deep = resolveForMainSession(currentModel, "deep");

    expect(fast?.model.provider).toBe("claude-agent-sdk");
    expect(fast?.model.id).toBe("claude-haiku-4-5");

    expect(balanced?.model.provider).toBe("claude-agent-sdk");
    expect(balanced?.model.id).toBe("claude-sonnet-4-6");

    expect(deep?.model.provider).toBe("claude-agent-sdk");
    expect(deep?.model.id).toBe("claude-opus-4-7");
  });

  it("openai-codex main session uses codex-local realizations instead of jumping providers", () => {
    const currentModel = getCurrentModel("openai-codex", "gpt-5.4");

    const fast = resolveForMainSession(currentModel, "fast");
    const balanced = resolveForMainSession(currentModel, "balanced");
    const deep = resolveForMainSession(currentModel, "deep");

    expect(fast?.model.provider).toBe("openai-codex");
    expect(fast?.model.id).toBe("gpt-5.4-mini");

    expect(balanced?.model.provider).toBe("openai-codex");
    expect(balanced?.model.id).toBe("gpt-5.5");
    expect(balanced?.thinkingLevel).toBe("medium");

    expect(deep?.model.provider).toBe("openai-codex");
    expect(deep?.model.id).toBe("gpt-5.5");
    expect(deep?.thinkingLevel).toBe("high");
  });

  it("google main session resolves the first profile its own route can actually satisfy", () => {
    const currentModel = getCurrentModel("google", "gemini-2.5-pro");

    const fast = resolveForMainSession(currentModel, "fast");
    const balanced = resolveForMainSession(currentModel, "balanced");
    const deep = resolveForMainSession(currentModel, "deep");

    expect(fast?.model.provider).toBe("google");
    expect(fast?.model.id).toBe("gemini-2.5-flash");

    expect(balanced?.model.provider).toBe("google");
    expect(balanced?.model.id).toBe("gemini-2.5-pro");

    expect(deep?.model.provider).toBe("google");
    expect(deep?.model.id).toBe("gemini-3.1-pro-preview");
  });

  it("uses claude-agent-sdk first when the chosen provider falls back to anthropic-family defaults", () => {
    const currentModel = getCurrentModel("mistral", "devstral-medium-latest");

    const fast = resolveForMainSession(currentModel, "fast");
    const balanced = resolveForMainSession(currentModel, "balanced");
    const deep = resolveForMainSession(currentModel, "deep");

    expect(fast?.model.provider).toBe("claude-agent-sdk");
    expect(fast?.model.id).toBe("claude-haiku-4-5");

    expect(balanced?.model.provider).toBe("claude-agent-sdk");
    expect(balanced?.model.id).toBe("claude-sonnet-4-6");

    expect(deep?.model.provider).toBe("claude-agent-sdk");
    expect(deep?.model.id).toBe("claude-opus-4-7");
  });

  it("falls back to anthropic when claude-agent-sdk is not installed or not available", () => {
    const registryWithoutClaudeAgentSdk = ModelRegistry.inMemory(authStorage);
    const currentModel = getCurrentModel("anthropic", "claude-sonnet-4-6", registryWithoutClaudeAgentSdk);

    const fast = resolveForMainSession(currentModel, "fast", registryWithoutClaudeAgentSdk);
    const balanced = resolveForMainSession(currentModel, "balanced", registryWithoutClaudeAgentSdk);
    const deep = resolveForMainSession(currentModel, "deep", registryWithoutClaudeAgentSdk);

    expect(fast?.model.provider).toBe("anthropic");
    expect(fast?.model.id).toBe("claude-haiku-4-5");

    expect(balanced?.model.provider).toBe("anthropic");
    expect(balanced?.model.id).toBe("claude-sonnet-4-6");

    expect(deep?.model.provider).toBe("anthropic");
    expect(deep?.model.id).toBe("claude-opus-4-7");
  });

  it("oracle deep workload stays in the current model family", () => {
    const anthropic = resolveForMainSession(getCurrentModel("anthropic", "claude-opus-4-7"), "deep");
    const openai = resolveForMainSession(getCurrentModel("openai", "gpt-5.4"), "deep");
    const google = resolveForMainSession(getCurrentModel("google", "gemini-2.5-pro"), "deep");

    expect(anthropic?.model.provider).toBe("claude-agent-sdk");
    expect(anthropic?.model.id).toBe("claude-opus-4-7");

    expect(openai?.model.provider).toBe("openai-codex");
    expect(openai?.model.id).toBe("gpt-5.5");

    expect(google?.model.provider).toBe("google");
    expect(google?.model.id).toBe("gemini-3.1-pro-preview");
  });

  it("resolves bare Claude family aliases to current model IDs", () => {
    const currentModel = getCurrentModel("anthropic", "claude-sonnet-4-6");

    const result = resolveWorkloadModel(registry, currentModel, {
      provider: currentModel.provider,
      workload: "deep",
      explicitModelId: "sonnet",
    });

    expect(result).not.toBeNull();
    expect(result?.model.id).toBe("claude-sonnet-4-6");
    expect(result?.model.provider).toBe("anthropic");
  });

  it("lets an explicit override bypass the main-session provider choice", () => {
    const currentModel = getCurrentModel("anthropic", "claude-sonnet-4-6");

    const result = resolveWorkloadModel(registry, currentModel, {
      provider: currentModel.provider,
      workload: "deep",
      explicitModelId: "openai-codex/gpt-5.2-codex",
    });

    expect(result).not.toBeNull();
    expect(result?.model.provider).toBe("openai-codex");
    expect(result?.model.id).toBe("gpt-5.2-codex");
    expect(result?.thinkingLevel).toBeUndefined();
  });

  it("keeps an explicit anthropic provider override exact instead of rerouting it to claude-agent-sdk", () => {
    const currentModel = getCurrentModel("openai", "gpt-5.4");

    const result = resolveWorkloadModel(registry, currentModel, {
      provider: currentModel.provider,
      workload: "deep",
      explicitModelId: "anthropic/claude-opus-4-7",
    });

    expect(result).not.toBeNull();
    expect(result?.model.provider).toBe("anthropic");
    expect(result?.model.id).toBe("claude-opus-4-7");
    expect(result?.thinkingLevel).toBeUndefined();
  });
});
