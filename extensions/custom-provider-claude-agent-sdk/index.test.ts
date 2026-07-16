import { describe, expect, test } from "bun:test";
import claudeAgentSdkProvider, { API_ID, PROVIDER_MODELS } from "./index.js";

const SESSION_ENTRY_TYPE = "claude-agent-sdk-session";

type Handler = (event: Record<string, unknown>, ctx: Record<string, any>) => unknown;

function continuityEntry(
  id: string,
  syncedThroughEntryId: string,
  sdkSessionId = "shared-mutable-sdk-session",
  ownerPiSessionId?: string,
) {
  return {
    type: "custom",
    customType: SESSION_ENTRY_TYPE,
    id,
    parentId: null,
    data: {
      ...(ownerPiSessionId ? { ownerPiSessionId } : {}),
      sdkSessionId,
      syncedThroughEntryId,
      lastClaudeModelId: "claude-opus-5",
      reseedPending: false,
      storeBacked: false,
    },
  };
}

function legacyTreeNavigationEvent(id: string) {
  return {
    type: "custom",
    customType: "claude-agent-sdk-event",
    id,
    parentId: null,
    data: {
      event: "sdk_session_rehydrated",
      piSessionId: "legacy-tree-test",
      sdkSessionId: "shared-mutable-sdk-session",
      syncedThroughEntryId: "ancestor",
      modelId: "claude-opus-5",
      reason: "session_tree",
    },
  };
}

function createSessionManager(
  sessionId: string,
  entries: Record<string, unknown>[],
  allEntries = entries,
  header: { parentSession?: string } = {},
) {
  return {
    getBranch: () => entries,
    getEntries: () => allEntries,
    getHeader: () => header,
    getSessionId: () => sessionId,
    getLeafId: () => entries.at(-1)?.id as string | undefined,
    getSessionFile: () => `/tmp/${sessionId}.jsonl`,
  };
}

function createProviderHarness() {
  const handlers = new Map<string, Handler>();
  const appended: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry: (customType: string, data: Record<string, unknown>) => appended.push({ customType, data }),
    registerProvider: () => {},
  };
  claudeAgentSdkProvider(pi as never);
  return { handlers, appended };
}

function lastPersistedContinuity(appended: Array<{ customType: string; data: Record<string, unknown> }>) {
  for (let index = appended.length - 1; index >= 0; index -= 1) {
    if (appended[index]?.customType === SESSION_ENTRY_TYPE) return appended[index]?.data;
  }
  return undefined;
}

describe("Claude Agent SDK provider models", () => {
  test("includes Claude Opus 5", () => {
    expect(PROVIDER_MODELS.find((model) => model.id === "claude-opus-5")).toEqual({
      id: "claude-opus-5",
      name: "Claude Opus 5",
      api: API_ID,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
  });
});

describe("Claude Agent SDK branch isolation", () => {
  test("does not revive a contaminated SDK ID persisted after a legacy tree navigation", () => {
    const { handlers, appended } = createProviderHarness();
    const sessionManager = createSessionManager("legacy-tree-test", [
      continuityEntry("checkpoint", "ancestor"),
      legacyTreeNavigationEvent("tree-event"),
      continuityEntry("contaminated-turn", "later-leaf"),
    ]);
    const ctx = { sessionManager, model: { provider: "claude-agent-sdk" } };

    handlers.get("session_start")?.({ reason: "reload" }, ctx);

    expect(appended).toEqual([]);

    handlers.get("session_shutdown")?.({}, ctx);
  });

  test("rejects an SDK ID that advanced outside the selected branch", () => {
    const { handlers, appended } = createProviderHarness();
    const selectedBranch = [continuityEntry("checkpoint", "ancestor")];
    const sessionManager = createSessionManager("off-branch-test", selectedBranch, [
      ...selectedBranch,
      continuityEntry("abandoned-turn", "abandoned-leaf"),
    ]);
    const ctx = { sessionManager, model: { provider: "claude-agent-sdk" } };

    handlers.get("session_start")?.({ reason: "reload" }, ctx);

    expect(appended).toEqual([]);

    handlers.get("session_shutdown")?.({}, ctx);
  });

  test("rejects an SDK ID with only an off-branch resume event", () => {
    const { handlers, appended } = createProviderHarness();
    const selectedBranch = [continuityEntry("checkpoint", "ancestor")];
    const offBranchResume = {
      type: "custom",
      customType: "claude-agent-sdk-event",
      id: "off-branch-resume",
      parentId: null,
      data: {
        event: "sdk_session_resumed",
        sdkSessionId: "shared-mutable-sdk-session",
      },
    };
    const sessionManager = createSessionManager("event-only-test", selectedBranch, [
      ...selectedBranch,
      offBranchResume,
    ]);
    const ctx = { sessionManager, model: { provider: "claude-agent-sdk" } };

    handlers.get("session_start")?.({ reason: "reload" }, ctx);

    expect(appended).toEqual([]);

    handlers.get("session_shutdown")?.({}, ctx);
  });

  test("rejects copied continuity in a CLI-created fork", () => {
    const { handlers, appended } = createProviderHarness();
    const sessionManager = createSessionManager(
      "cli-fork-test",
      [continuityEntry("copied-checkpoint", "ancestor")],
      undefined,
      { parentSession: "/tmp/source.jsonl" },
    );
    const ctx = { sessionManager, model: { provider: "claude-agent-sdk" } };

    handlers.get("session_start")?.({ reason: "startup" }, ctx);

    expect(appended).toEqual([]);

    handlers.get("session_shutdown")?.({}, ctx);
  });

  test("accepts continuity owned by a CLI-created fork after its cold start", () => {
    const { handlers, appended } = createProviderHarness();
    const sessionManager = createSessionManager(
      "cli-fork-owned-test",
      [continuityEntry("local-checkpoint", "local-leaf", "fresh-sdk-session", "cli-fork-owned-test")],
      undefined,
      { parentSession: "/tmp/source.jsonl" },
    );
    const ctx = { sessionManager, model: { provider: "claude-agent-sdk" } };

    handlers.get("session_start")?.({ reason: "startup" }, ctx);

    expect(appended.at(-1)?.data).toMatchObject({
      event: "sdk_session_rehydrated",
      sdkSessionId: "fresh-sdk-session",
      syncedThroughEntryId: "local-leaf",
    });

    handlers.get("session_shutdown")?.({}, ctx);
  });

  test("accepts a fresh SDK ID established after a legacy tree boundary", () => {
    const { handlers, appended } = createProviderHarness();
    const sessionManager = createSessionManager("fresh-after-tree-test", [
      continuityEntry("checkpoint", "ancestor"),
      legacyTreeNavigationEvent("tree-event"),
      continuityEntry("fresh-turn", "fresh-leaf", "fresh-sdk-session"),
    ]);
    const ctx = { sessionManager, model: { provider: "claude-agent-sdk" } };

    handlers.get("session_start")?.({ reason: "reload" }, ctx);

    expect(appended.at(-1)?.data).toMatchObject({
      event: "sdk_session_rehydrated",
      sdkSessionId: "fresh-sdk-session",
      syncedThroughEntryId: "fresh-leaf",
    });

    handlers.get("session_shutdown")?.({}, ctx);
  });

  test("preserves ordinary reload continuity on an unbranched session", () => {
    const { handlers, appended } = createProviderHarness();
    const sessionManager = createSessionManager("linear-reload-test", [
      continuityEntry("checkpoint", "ancestor"),
    ]);
    const ctx = { sessionManager, model: { provider: "claude-agent-sdk" } };

    handlers.get("session_start")?.({ reason: "reload" }, ctx);

    expect(appended.at(-1)?.data).toMatchObject({
      event: "sdk_session_rehydrated",
      sdkSessionId: "shared-mutable-sdk-session",
      syncedThroughEntryId: "ancestor",
    });

    handlers.get("session_shutdown")?.({}, ctx);
  });

  test("requests a fresh compact-state preseed after tree navigation", () => {
    const { handlers, appended } = createProviderHarness();
    const sessionManager = createSessionManager("tree-test", [continuityEntry("checkpoint", "ancestor")]);
    const ctx = { sessionManager, model: { provider: "openai" } };

    handlers.get("session_start")?.({ reason: "startup" }, ctx);
    appended.splice(0);
    handlers.get("session_tree")?.({}, ctx);

    expect(lastPersistedContinuity(appended)).toMatchObject({
      sdkSessionId: null,
      syncedThroughEntryId: null,
      reseedPending: true,
      storeBacked: false,
    });

    handlers.get("session_shutdown")?.({}, ctx);
  });

  test("cancels Claude branch summarization when no safe summarizer is available", async () => {
    const { handlers } = createProviderHarness();
    const notifications: string[] = [];
    const result = await handlers.get("session_before_tree")?.({
      preparation: {
        userWantsSummary: true,
        entriesToSummarize: [{
          type: "message",
          id: "branch-user",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "summarize this", timestamp: Date.now() },
        }],
      },
      signal: new AbortController().signal,
    }, {
      model: { provider: "claude-agent-sdk" },
      modelRegistry: { find: () => undefined },
      ui: { notify: (message: string) => notifications.push(message) },
    });

    expect(result).toEqual({ cancel: true });
    expect(notifications[0]).toContain("Retry without a summary");
  });

  test("cancels Claude branch summarization when summarizer auth lookup fails", async () => {
    const { handlers } = createProviderHarness();
    const notifications: string[] = [];
    const result = await handlers.get("session_before_tree")?.({
      preparation: {
        userWantsSummary: true,
        entriesToSummarize: [{
          type: "message",
          id: "branch-user",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "summarize this", timestamp: Date.now() },
        }],
      },
      signal: new AbortController().signal,
    }, {
      model: { provider: "claude-agent-sdk" },
      modelRegistry: {
        find: () => ({ provider: "openai", id: "gpt-5.6-terra", contextWindow: 272_000 }),
        getApiKeyAndHeaders: async () => { throw new Error("credential helper failed"); },
      },
      ui: { notify: (message: string) => notifications.push(message) },
    });

    expect(result).toEqual({ cancel: true });
    expect(notifications[0]).toContain("Retry without a summary");
  });

  test("cancels Claude compaction when no safe summarizer is available", async () => {
    const { handlers } = createProviderHarness();
    const notifications: string[] = [];
    const result = await handlers.get("session_before_compact")?.({
      preparation: { tokensBefore: 100_000 },
    }, {
      model: { provider: "claude-agent-sdk" },
      modelRegistry: { find: () => undefined },
      ui: { notify: (message: string) => notifications.push(message) },
    });

    expect(result).toEqual({ cancel: true });
    expect(notifications[0]).toContain("Compaction was cancelled");
  });

  test("invalidates copied SDK continuity when forking under another provider", () => {
    const { handlers, appended } = createProviderHarness();
    const sessionManager = createSessionManager("fork-test", [continuityEntry("checkpoint", "ancestor")]);
    const ctx = { sessionManager, model: { provider: "openai" } };

    handlers.get("session_start")?.({ reason: "fork" }, ctx);

    expect(lastPersistedContinuity(appended)).toMatchObject({
      sdkSessionId: null,
      syncedThroughEntryId: null,
      reseedPending: false,
      storeBacked: false,
    });

    handlers.get("session_shutdown")?.({}, ctx);
  });
});
