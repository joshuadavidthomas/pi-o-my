import { describe, expect, it } from "bun:test";

import { applyTurnUpdate, PiStreamState } from "./pi-stream.ts";
import type { TurnUpdate } from "./sdk/events.ts";
import { ToolBridge } from "./tools/bridge.ts";

function createState(): PiStreamState {
  const model = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
  const stream = { push: () => {}, end: () => {} };
  return new PiStreamState(model as never, stream as never);
}

function toolCallBlockStart(index: number, id: string): TurnUpdate {
  return {
    type: "event",
    event: {
      type: "blockStarted",
      block: { kind: "toolCall", sourceBlockIndex: index, id, mcpToolName: "mcp__pi-tools__oracle", input: {} },
    },
  };
}

function toolCallEnvelope(id: string): TurnUpdate {
  return {
    type: "assistantBackfill",
    backfill: [{ type: "toolCall", id, mcpToolName: "mcp__pi-tools__oracle", input: {} }],
    stopReason: "stop",
  };
}

describe("applyTurnUpdate", () => {
  it("keeps the stream open across per-block assistant envelopes until message_stop", async () => {
    const state = createState();
    const bridge = new ToolBridge();
    const ids = ["toolu_A", "toolu_B", "toolu_C", "toolu_D"];

    expect(applyTurnUpdate({ type: "event", event: { type: "messageStarted" } }, state, bridge)).toBe(false);
    expect(applyTurnUpdate({ type: "event", event: { type: "blockStarted", block: { kind: "text", sourceBlockIndex: 0 } } }, state, bridge)).toBe(false);
    expect(applyTurnUpdate({ type: "event", event: { type: "blockFinished", sourceBlockIndex: 0 } }, state, bridge)).toBe(false);
    expect(applyTurnUpdate({ type: "assistantBackfill", backfill: [{ type: "text", text: "fanning out" }], stopReason: "stop" }, state, bridge)).toBe(false);

    for (const [i, id] of ids.entries()) {
      expect(applyTurnUpdate(toolCallBlockStart(i + 1, id), state, bridge)).toBe(false);
      expect(applyTurnUpdate({ type: "event", event: { type: "blockFinished", sourceBlockIndex: i + 1 } }, state, bridge)).toBe(false);
      // Per-block assistant envelope: must not finish the stream while
      // sibling tool_use blocks are still streaming.
      expect(applyTurnUpdate(toolCallEnvelope(id), state, bridge)).toBe(false);
      expect(state.finished).toBe(false);
    }

    expect(applyTurnUpdate({ type: "event", event: { type: "messageUpdated", stopReason: "toolUse" } }, state, bridge)).toBe(false);
    expect(applyTurnUpdate({ type: "event", event: { type: "messageFinished" } }, state, bridge)).toBe(true);

    expect(state.finished).toBe(true);
    expect(state.output.stopReason).toBe("toolUse");
    expect(state.output.content.filter((b) => b.type === "toolCall")).toHaveLength(4);

    // All four MCP calls must claim a registered id instead of erroring.
    const claims = ids.map(() => bridge.handleMcpToolCall("oracle"));
    bridge.deliverToolResults(ids.map((id) => ({
      toolCallId: id,
      content: [{ type: "text", text: `result ${id}` }],
    })));
    const results = await Promise.all(claims);
    for (const [i, result] of results.entries()) {
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: "text", text: `result ${ids[i]}` }]);
    }
  });

  it("finishes on a delayed tool_use envelope after message_stop", () => {
    const state = createState();
    const bridge = new ToolBridge();

    expect(applyTurnUpdate({ type: "event", event: { type: "messageStarted" } }, state, bridge)).toBe(false);
    expect(applyTurnUpdate({ type: "event", event: { type: "blockStarted", block: { kind: "text", sourceBlockIndex: 0 } } }, state, bridge)).toBe(false);
    expect(applyTurnUpdate({ type: "event", event: { type: "blockFinished", sourceBlockIndex: 0 } }, state, bridge)).toBe(false);
    expect(applyTurnUpdate({ type: "event", event: { type: "messageUpdated", stopReason: "toolUse" } }, state, bridge)).toBe(false);
    // message_stop with no tool call yet: stream stays open.
    expect(applyTurnUpdate({ type: "event", event: { type: "messageFinished" } }, state, bridge)).toBe(false);
    expect(state.finished).toBe(false);

    expect(applyTurnUpdate(toolCallEnvelope("toolu_late"), state, bridge)).toBe(true);
    expect(state.finished).toBe(true);
    expect(state.output.stopReason).toBe("toolUse");
  });

  it("finishes immediately in pure-backfill mode with no stream events", () => {
    const state = createState();
    const bridge = new ToolBridge();

    expect(applyTurnUpdate(toolCallEnvelope("toolu_only"), state, bridge)).toBe(true);
    expect(state.finished).toBe(true);
    expect(state.output.stopReason).toBe("toolUse");
  });
});
