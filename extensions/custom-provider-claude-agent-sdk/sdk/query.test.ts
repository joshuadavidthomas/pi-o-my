import { afterEach, describe, expect, it, mock } from "bun:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { PiStreamState } from "../pi-stream.ts";
import { ClaudeSession } from "../session.ts";
import { SdkInputQueue } from "./queue.ts";

interface QueryCall {
  prompt: AsyncIterable<SDKUserMessage> | string;
  options?: Record<string, unknown>;
}

const queryCalls: QueryCall[] = [];
const fakeQueries: Array<{ close: () => void }> = [];
const fakeSessionStore = { append: mock(async () => {}), load: mock(async () => null) };
const seededCalls: Array<{ piSessionId: string; messages: unknown[]; cwd: string }> = [];

function createFakeQuery() {
  let closed = false;
  const waiters: Array<(result: IteratorResult<unknown>) => void> = [];

  const close = () => {
    if (closed) return;
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  };

  const fakeQuery = {
    close,
    setMcpServers: mock(async () => {}),
    setModel: mock(async () => {}),
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve));
      },
    }),
  };
  fakeQueries.push(fakeQuery);
  return fakeQuery;
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: mock((call: QueryCall) => {
    queryCalls.push(call);
    return createFakeQuery();
  }),
}));
mock.module("../native-reseed.js", () => ({
  seedPiMessages: mock(async (piSessionId: string, messages: unknown[], cwd: string) => {
    seededCalls.push({ piSessionId, messages, cwd });
    return { sessionId: "seeded-sdk-session", store: fakeSessionStore };
  }),
  storeForPiSession: mock(() => fakeSessionStore),
}));

const { streamClaudeAgentSdk } = await import("./query.ts");

const model = {
  api: "claude-agent-sdk",
  provider: "claude-agent-sdk",
  id: "test-model",
  contextWindow: 200_000,
} as never;

const nullStream = () => ({ push: () => {}, end: () => {} }) as never;

// A session mid-turn: the assistant issued a tool call, the SDK subprocess is
// blocked awaiting the MCP result, and pi is about to come back with the
// tool results.
function sessionAwaitingToolResult(toolCallId: string) {
  const session = new ClaudeSession("pi-session");
  const turn = session.beginTurn(new PiStreamState(model, nullStream()));
  turn.toolBridge.register(toolCallId);
  const pendingMcp = turn.toolBridge.handleMcpToolCall("read");
  const state = turn.streamState();
  if (!state) throw new Error("expected attached stream state");
  state.finish("toolUse");
  turn.detachStreamState(state);
  return { session, turn, pendingMcp };
}

function toolResultContext(toolCallId: string) {
  return {
    systemPrompt: "",
    messages: [
      {
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: Date.now(),
      },
    ],
    tools: [],
  } as never;
}

function compactedToolResultContext() {
  return {
    systemPrompt: "",
    messages: [
      {
        role: "compactionSummary",
        summary: "User asked us to inspect post-compaction stalls.",
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll read the provider query router." },
          { type: "toolCall", id: "toolu_compacted", name: "read", arguments: { path: "sdk/query.ts" } },
        ],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "toolu_compacted",
        toolName: "read",
        content: [{ type: "text", text: "TOOL RESULT FROM COMPACTION" }],
        isError: false,
        timestamp: Date.now(),
      },
    ],
    tools: [],
  } as never;
}

function staleLookingToolResultContext() {
  return {
    systemPrompt: "",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll inspect the stale-looking file." },
          { type: "toolCall", id: "toolu_stale", name: "read", arguments: { path: "stale.txt" } },
        ],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "toolu_stale",
        toolName: "read",
        content: [{ type: "text", text: "STALE LOOKING TOOL RESULT" }],
        isError: false,
        timestamp: Date.now(),
      },
    ],
    tools: [],
  } as never;
}

function freshTurnContext() {
  return {
    systemPrompt: "",
    messages: [
      { role: "user", content: "old prompt", timestamp: Date.now() },
      { role: "assistant", content: "old answer", timestamp: Date.now() },
      { role: "user", content: "latest fresh user prompt", timestamp: Date.now() },
    ],
    tools: [],
  } as never;
}

function compactedFreshTurnContext() {
  return {
    systemPrompt: "",
    messages: [
      { role: "compactionSummary", summary: "The user previously asked an old question and received an old answer.", timestamp: Date.now() },
      { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: Date.now() },
      { role: "user", content: "latest fresh user prompt", timestamp: Date.now() },
    ],
    tools: [],
  } as never;
}

async function waitForQueryCall(): Promise<QueryCall> {
  for (let i = 0; i < 100; i += 1) {
    const call = queryCalls[0];
    if (call) return call;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for SDK query call");
}

async function nextInputMessage(iterator: AsyncIterator<SDKUserMessage>): Promise<SDKUserMessage> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<IteratorResult<SDKUserMessage>>((_, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for SDK input message")), 250);
    }),
  ]);
  if (result.done) throw new Error("SDK input queue closed before yielding a message");
  return result.value;
}

afterEach(() => {
  for (const fakeQuery of fakeQueries.splice(0)) {
    fakeQuery.close();
  }
  queryCalls.splice(0);
  seededCalls.splice(0);
});

describe("streamClaudeAgentSdk tool continuation", () => {
  it("keeps compact reseed pending until Pi synchronizes the completed turn", () => {
    const session = new ClaudeSession("pi-session");
    session.requestReseed();
    session.markSeededSession("seeded-sdk-session");
    session.captureSdkSessionId("seeded-sdk-session", "claude-fable-5");
    expect(session.continuityState().reseedPending).toBeTrue();

    session.markSyncedThrough("pi-turn-entry");
    expect(session.continuityState().reseedPending).toBeFalse();
  });

  it("resumes compact-state seeded history after Pi compaction and sends only the current prompt", async () => {
    const session = new ClaudeSession("pi-session");
    session.requestReseed();

    streamClaudeAgentSdk(session, model, compactedFreshTurnContext(), { sessionId: "pi-session" } as never);

    const call = await waitForQueryCall();
    expect(call.options?.resume).toBe("seeded-sdk-session");
    expect(call.options?.sessionStore).toBe(fakeSessionStore);
    expect(call.options?.sessionId).toBeUndefined();
    expect(seededCalls).toHaveLength(1);
    expect(seededCalls[0]?.messages).toHaveLength(2);

    const iterator = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    const prompt = await nextInputMessage(iterator);
    expect(prompt.shouldQuery).toBe(true);
    expect(prompt.message.content).toBe("latest fresh user prompt");

    session.closeLiveQuery("test teardown");
  });

  it("preseeds an ordinary selected branch and sends only the current prompt", async () => {
    const session = new ClaudeSession("pi-session");
    session.requestReseed("Pi tree navigation");

    streamClaudeAgentSdk(session, model, freshTurnContext(), { sessionId: "pi-session" } as never);

    const call = await waitForQueryCall();
    expect(call.options?.resume).toBe("seeded-sdk-session");
    expect(call.options?.sessionStore).toBe(fakeSessionStore);
    expect(seededCalls).toHaveLength(1);
    expect(seededCalls[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "old prompt" }),
      expect.objectContaining({ role: "assistant", content: "old answer" }),
    ]);

    const iterator = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    const prompt = await nextInputMessage(iterator);
    expect(prompt.shouldQuery).toBe(true);
    expect(prompt.message.content).toBe("latest fresh user prompt");

    session.closeLiveQuery("test teardown");
  });

  it("starts a fresh continuation when compacted context trails tool results without an active turn", async () => {
    const session = new ClaudeSession("pi-session");
    session.requestReseed();

    streamClaudeAgentSdk(session, model, compactedToolResultContext(), {
      sessionId: "pi-session",
    } as never);

    const call = await waitForQueryCall();
    expect(typeof call.prompt).not.toBe("string");
    const iterator = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();

    expect(call.options?.resume).toBe("seeded-sdk-session");
    expect(call.options?.sessionStore).toBe(fakeSessionStore);
    expect(seededCalls[0]?.messages).toHaveLength(3);

    const prompt = await nextInputMessage(iterator);
    expect(prompt.shouldQuery).toBe(true);
    expect(prompt.message.content).toContain("Continue the interrupted work");
    expect(prompt.message.content).not.toContain("Compaction summary:");

    session.closeLiveQuery("test teardown");
  });

  it("resumes stale-looking tool-result contexts on a fresh signal by design", async () => {
    const session = new ClaudeSession("pi-session");

    streamClaudeAgentSdk(session, model, staleLookingToolResultContext(), {
      sessionId: "pi-session",
    } as never);

    const call = await waitForQueryCall();
    expect(typeof call.prompt).not.toBe("string");
    const iterator = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();

    expect(call.options?.resume).toBeUndefined();
    expect(call.options?.sessionStore).toBeUndefined();
    expect(seededCalls).toHaveLength(0);

    const handoff = await nextInputMessage(iterator);
    expect(handoff.shouldQuery).toBe(false);
    expect(handoff.message.content).toContain("STALE LOOKING TOOL RESULT");
    const prompt = await nextInputMessage(iterator);
    expect(prompt.shouldQuery).toBe(true);
    expect(prompt.message.content).toContain("Continue the interrupted work");

    session.closeLiveQuery("test teardown");
  });

  it("starts ordinary fresh turns from the latest user prompt", async () => {
    const session = new ClaudeSession("pi-session");

    streamClaudeAgentSdk(session, model, freshTurnContext(), {
      sessionId: "pi-session",
    } as never);

    const call = await waitForQueryCall();
    expect(typeof call.prompt).not.toBe("string");
    const iterator = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();

    const handoff = await nextInputMessage(iterator);
    expect(handoff.shouldQuery).toBe(false);
    expect(handoff.message.content).toContain("old prompt");

    const prompt = await nextInputMessage(iterator);
    expect(prompt.shouldQuery).toBe(true);
    expect(prompt.message.content).toBe("latest fresh user prompt");

    session.closeLiveQuery("test teardown");
  });

  it("keeps stale tool results as an aborted no-op without an active turn", async () => {
    const session = new ClaudeSession("pi-session");
    const controller = new AbortController();
    controller.abort();

    const stream = streamClaudeAgentSdk(session, model, compactedToolResultContext(), {
      sessionId: "pi-session",
      signal: controller.signal,
    } as never);

    const events: { type: string; reason?: string }[] = [];
    for await (const event of stream) events.push(event as never);

    expect(queryCalls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect(session.currentTurn()).toBeUndefined();
  });

  it("fails aborted instead of resuming the subprocess when tool results arrive post-abort", async () => {
    const { session, pendingMcp } = sessionAwaitingToolResult("toolu_1");

    const controller = new AbortController();
    controller.abort();

    const stream = streamClaudeAgentSdk(session, model, toolResultContext("toolu_1"), {
      sessionId: "pi-session",
      signal: controller.signal,
    } as never);

    const events: { type: string; reason?: string }[] = [];
    for await (const event of stream) events.push(event as never);

    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.reason).toBe("aborted");

    // The stranded MCP call resolves with an error so the subprocess (were it
    // still alive) never sees the result as a successful continuation.
    const mcpResult = await pendingMcp;
    expect(mcpResult.isError).toBe(true);

    expect(session.currentTurn()).toBeUndefined();
  });

  it("steers the live turn instead of replacing it when a user follow-up trails the tool results", async () => {
    const { session, turn, pendingMcp } = sessionAwaitingToolResult("toolu_1");
    const inputQueue = new SdkInputQueue();
    session.startLiveQuery(
      { query: { close() {} } as never, inputQueue, abort: new AbortController() },
      { modelId: "test-model" },
    );

    const context = {
      systemPrompt: "",
      messages: [
        {
          role: "toolResult",
          toolCallId: "toolu_1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
          isError: false,
          timestamp: Date.now(),
        },
        { role: "user", content: "actually, focus on the abort path", timestamp: Date.now() },
      ],
      tools: [],
    } as never;

    streamClaudeAgentSdk(session, model, context, { sessionId: "pi-session" } as never);

    // The turn survives and the tool result reaches the pending MCP call.
    expect(session.currentTurn()).toBe(turn);
    const mcpResult = await pendingMcp;
    expect(mcpResult.isError).toBeFalsy();
    expect(mcpResult.content).toEqual([{ type: "text", text: "file contents" }]);

    // The follow-up went into the live input queue as a steering message.
    const next = await inputQueue[Symbol.asyncIterator]().next();
    expect(next.done).toBe(false);
    expect(next.value?.message.content).toBe("actually, focus on the abort path");
    expect(next.value?.shouldQuery).toBe(true);

    session.closeLiveQuery("test teardown");
  });

  it("delivers tool results to the pending MCP call when not aborted", async () => {
    const { session, pendingMcp } = sessionAwaitingToolResult("toolu_1");

    streamClaudeAgentSdk(session, model, toolResultContext("toolu_1"), {
      sessionId: "pi-session",
    } as never);

    const mcpResult = await pendingMcp;
    expect(mcpResult.isError).toBeFalsy();
    expect(mcpResult.content).toEqual([{ type: "text", text: "file contents" }]);

    session.closeLiveQuery("test teardown");
  });
});
