import { describe, expect, it } from "bun:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { resolveFirstAvailableModelTarget, resolveModelTarget } from "./models.ts";

const credentials = new InMemoryCredentialStore();
await credentials.modify("anthropic", async () => ({ type: "api_key", key: "test-anthropic" }));
await credentials.modify("claude-agent-sdk", async () => ({ type: "api_key", key: "test-claude-agent-sdk" }));
await credentials.modify("openai-codex", async () => ({ type: "api_key", key: "test-openai-codex" }));

const runtime = await ModelRuntime.create({
  credentials,
  modelsPath: null,
  refreshOnCreate: false,
});
const registry = new ModelRegistry(runtime);
registry.registerProvider("anthropic", {
  baseUrl: "https://anthropic.test",
  apiKey: "test-anthropic",
  api: "anthropic-messages",
  models: [
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: 64000,
    },
    {
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
      contextWindow: 200000,
      maxTokens: 64000,
    },
  ],
});
registry.registerProvider("openai-codex", {
  baseUrl: "https://openai-codex.test",
  apiKey: "test-openai-codex",
  api: "openai-responses",
  models: [
    {
      id: "gpt-5.4",
      name: "GPT 5.4 (Codex)",
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
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5 (Claude Agent SDK)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: 64000,
    },
    {
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8 (Claude Agent SDK)",
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

describe("ordered scout model target resolution", () => {
  it("uses the first available target in order", () => {
    const currentModel = getCurrentModel("anthropic", "claude-sonnet-5");

    const result = resolveFirstAvailableModelTarget(registry, currentModel, [
      { model: "anthropic/not-real", thinkingLevel: "high" },
      { model: "claude-agent-sdk/claude-haiku-4-5", thinkingLevel: "low" },
      { model: "anthropic/claude-opus-4-8", thinkingLevel: "high" },
    ]);

    expect(result?.model.provider).toBe("claude-agent-sdk");
    expect(result?.model.id).toBe("claude-haiku-4-5");
    expect(result?.thinkingLevel).toBe("low");
  });

  it("falls back to the next target when a provider-qualified target is unavailable", () => {
    const currentModel = getCurrentModel("anthropic", "claude-sonnet-5");

    const result = resolveFirstAvailableModelTarget(registry, currentModel, [
      { model: "missing-provider/claude-opus-4-8", thinkingLevel: "high" },
      { model: "anthropic/claude-opus-4-8", thinkingLevel: "high" },
    ]);

    expect(result?.model.provider).toBe("anthropic");
    expect(result?.model.id).toBe("claude-opus-4-8");
  });

  it("resolves explicit aliases", () => {
    const currentModel = getCurrentModel("anthropic", "claude-sonnet-5");

    const result = resolveModelTarget(registry, currentModel, { model: "sonnet" });

    expect(result?.model.provider).toBe("anthropic");
    expect(result?.model.id).toBe("claude-sonnet-5");
  });

  it("keeps provider-qualified exact overrides on the requested provider", () => {
    const currentModel = getCurrentModel("claude-agent-sdk", "claude-sonnet-5");

    const result = resolveModelTarget(registry, currentModel, { model: "anthropic/claude-opus-4-8" });

    expect(result?.model.provider).toBe("anthropic");
    expect(result?.model.id).toBe("claude-opus-4-8");
  });

  it("does not use substring matches for exact target strings", () => {
    const currentModel = getCurrentModel("openai-codex", "gpt-5.4");

    const result = resolveModelTarget(registry, currentModel, { model: "gpt-5" });

    expect(result).toBeNull();
  });
});
