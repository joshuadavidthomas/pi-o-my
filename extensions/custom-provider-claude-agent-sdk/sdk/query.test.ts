import { describe, expect, it } from "bun:test";

import { PiStreamState } from "../pi-stream.ts";
import { ClaudeSession } from "../session.ts";
import { streamClaudeAgentSdk } from "./query.ts";
import { SdkInputQueue } from "./queue.ts";

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

describe("streamClaudeAgentSdk tool continuation", () => {
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
