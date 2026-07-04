import {
  calculateCost,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { debug } from "./sdk/debug.js";
import type {
  AssistantBackfill,
  FinishedStopReason,
  TurnBlockDelta,
  TurnBlockStart,
  TurnEvent,
  TurnResult,
  TurnUpdate,
  TurnUsage,
} from "./sdk/events.js";
import type { ToolBridge } from "./tools/bridge.js";
import { stripMcpToolName } from "./tools/names.js";
//
// Throttle JSON.parse on streaming tool input. Anthropic emits input_json_delta
// chunks at high frequency; reparsing the entire accumulated buffer on every
// delta is O(n²) in tool input size and dominates CPU on large Edit/Write
// payloads. Live consumers see the raw delta immediately; the structured
// arguments lag by at most this interval, then settle to exact on block_stop.
const TOOL_INPUT_PARSE_THROTTLE_MS = 50;

interface StreamDelta {
  sourceBlockIndex: number;
  delta: string;
}

interface StreamSignature {
  sourceBlockIndex: number;
  signature: string;
}

interface StreamToolCallStart {
  sourceBlockIndex: number;
  id: string;
  name: string;
  args: ToolCall["arguments"];
}

type ActiveBlock =
  | { type: "text"; contentIndex: number }
  | { type: "thinking"; contentIndex: number }
  | { type: "toolCall"; contentIndex: number; partialJson: string; lastParseAt: number };

export class PiStreamState {
  readonly output: AssistantMessage;

  private activeBlocks = new Map<number, ActiveBlock>();
  private started = false;
  private isFinished = false;
  private streamEventsReceived = false;
  private messageStopSeen = false;
  private pendingFinishedStopReason: FinishedStopReason = "stop";
  private readonly turnStartedAt = performance.now();
  private firstDeltaLogged = false;

  constructor(readonly model: Model<Api>, readonly stream: AssistantMessageEventStream) {
    this.output = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  get finished() {
    return this.isFinished;
  }

  markStreamingContentReceived() {
    this.streamEventsReceived = true;
  }

  acceptsAssistantBackfill() {
    return !this.streamEventsReceived;
  }

  markMessageStopSeen() {
    this.messageStopSeen = true;
  }

  hasSeenMessageStop() {
    return this.messageStopSeen;
  }

  finishToolUseIfPresent() {
    if (!this.hasToolCall()) return false;

    this.finish("toolUse");
    return true;
  }

  hasToolCall() {
    return this.output.content.some((block) => block.type === "toolCall");
  }

  start() {
    if (this.started) return;

    this.started = true;
    this.stream.push({ type: "start", partial: this.output });
  }

  finish(reason: FinishedStopReason) {
    if (this.isFinished) return;

    this.start();
    this.isFinished = true;
    this.output.stopReason = reason;
    this.stream.push({ type: "done", reason, message: this.output });
    this.stream.end();
    debug("time:turnTotal", {
      ms: Number((performance.now() - this.turnStartedAt).toFixed(2)),
      stopReason: reason,
    });
  }

  fail(message: string, aborted: boolean) {
    if (this.isFinished) {
      debug("stream:fail", { skipped: "already-finished", aborted });
      return;
    }

    debug("stream:fail", {
      aborted,
      message,
      ms: Number((performance.now() - this.turnStartedAt).toFixed(2)),
      contentBlocks: this.output.content.length,
    });
    this.start();
    this.isFinished = true;
    this.output.stopReason = aborted ? "aborted" : "error";
    this.output.errorMessage = message;
    this.stream.push({ type: "error", reason: this.output.stopReason, error: this.output });
    this.stream.end();
  }

  beginMessage(usage?: TurnUsage) {
    this.activeBlocks.clear();
    if (usage) this.applyUsage(usage);
  }

  applyUsage(usage: TurnUsage | undefined) {
    if (!usage) return;

    this.output.usage.input = Math.max(this.output.usage.input, usage.inputTokens ?? 0);
    this.output.usage.output = Math.max(this.output.usage.output, usage.outputTokens ?? 0);
    this.output.usage.cacheRead = Math.max(this.output.usage.cacheRead, usage.cacheReadTokens ?? 0);
    this.output.usage.cacheWrite = Math.max(this.output.usage.cacheWrite, usage.cacheWriteTokens ?? 0);
    this.output.usage.totalTokens =
      this.output.usage.input
      + this.output.usage.output
      + this.output.usage.cacheRead
      + this.output.usage.cacheWrite;
    calculateCost(this.model, this.output.usage);
  }

  setStopReason(reason: FinishedStopReason) {
    this.output.stopReason = reason;
    this.pendingFinishedStopReason = reason;
  }

  hasMeaningfulStopReason(): boolean {
    return this.pendingFinishedStopReason !== "stop";
  }

  finishWithPendingStopReason() {
    if (this.isFinished) return;
    this.finish(this.pendingFinishedStopReason);
  }

  backfillText(text: string) {
    const alreadyPresent = this.output.content.some((existing) => existing.type === "text" && existing.text === text);
    if (!alreadyPresent) {
      this.output.content.push({ type: "text", text });
    }
  }

  backfillThinking(thinking: string, signature: string) {
    if (this.output.content.length > 0) return;

    this.output.content.push({
      type: "thinking",
      thinking,
      thinkingSignature: signature,
    } as ThinkingContent);
  }

  backfillToolCall(id: string, name: string, args: ToolCall["arguments"]): boolean {
    const existingIndex = this.output.content.findIndex((b) => b.type === "toolCall" && b.id === id);
    const existing = existingIndex >= 0 ? this.output.content[existingIndex] : undefined;
    if (existing && existing.type === "toolCall") {
      const existingKeys = existing.arguments ? Object.keys(existing.arguments) : [];
      const incomingKeys = args && typeof args === "object" ? Object.keys(args) : [];

      // Claude Code's preset emits tool_use as content_block_start with
      // input: {} and surfaces the real args only via the assistant message
      // backfill — input_json_delta never fires. Merge backfill args into the
      // streaming-side block when it would otherwise leave args empty, then
      // re-emit toolcall_end so the host re-renders the inline label with the
      // real arguments instead of staying stuck on the empty `{}` it saw at
      // content_block_start.
      if (existingKeys.length === 0 && incomingKeys.length > 0) {
        existing.arguments = args;
        debug("stream:backfillToolCall", {
          id,
          name,
          outcome: "merged-into-existing",
          argsKeys: incomingKeys,
          argsBytes: JSON.stringify(args ?? {}).length,
        });
        this.stream.push({
          type: "toolcall_end",
          contentIndex: existingIndex,
          toolCall: existing,
          partial: this.output,
        });
        return false;
      }

      debug("stream:backfillToolCall", {
        id,
        name,
        outcome: "skipped-already-populated",
        existingArgsKeys: existingKeys,
        incomingArgsKeys: incomingKeys,
        incomingArgsBytes: JSON.stringify(args ?? {}).length,
      });
      return false;
    }

    debug("stream:backfillToolCall", {
      id,
      name,
      outcome: "added",
      argsKeys: args && typeof args === "object" ? Object.keys(args) : [],
      argsBytes: JSON.stringify(args ?? {}).length,
    });
    this.output.content.push({
      type: "toolCall",
      id,
      name,
      arguments: args,
    });
    return true;
  }

  beginTextBlock(sourceBlockIndex: number) {
    this.start();
    this.output.content.push({ type: "text", text: "" });
    const contentIndex = this.output.content.length - 1;
    this.activeBlocks.set(sourceBlockIndex, { type: "text", contentIndex });
    this.stream.push({ type: "text_start", contentIndex, partial: this.output });
  }

  appendTextDelta({ sourceBlockIndex, delta }: StreamDelta) {
    const active = this.activeBlocks.get(sourceBlockIndex);
    if (active?.type !== "text") return;

    const block = this.output.content[active.contentIndex];
    if (block?.type !== "text") return;

    this.markFirstDelta("text");
    block.text += delta;
    this.stream.push({ type: "text_delta", contentIndex: active.contentIndex, delta, partial: this.output });
  }

  beginThinkingBlock(sourceBlockIndex: number) {
    this.start();
    this.output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" } as ThinkingContent);
    const contentIndex = this.output.content.length - 1;
    this.activeBlocks.set(sourceBlockIndex, { type: "thinking", contentIndex });
    this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
  }

  appendThinkingDelta({ sourceBlockIndex, delta }: StreamDelta) {
    const active = this.activeBlocks.get(sourceBlockIndex);
    if (active?.type !== "thinking") return;

    const block = this.output.content[active.contentIndex];
    if (block?.type !== "thinking") return;

    this.markFirstDelta("thinking");
    block.thinking += delta;
    this.stream.push({ type: "thinking_delta", contentIndex: active.contentIndex, delta, partial: this.output });
  }

  appendThinkingSignature({ sourceBlockIndex, signature }: StreamSignature) {
    const active = this.activeBlocks.get(sourceBlockIndex);
    if (active?.type !== "thinking") return;

    const block = this.output.content[active.contentIndex];
    if (block?.type === "thinking") {
      block.thinkingSignature = `${block.thinkingSignature ?? ""}${signature}`;
    }
  }

  beginToolCall({ sourceBlockIndex, id, name, args }: StreamToolCallStart) {
    this.start();
    this.output.content.push({ type: "toolCall", id, name, arguments: args });
    const contentIndex = this.output.content.length - 1;
    this.activeBlocks.set(sourceBlockIndex, { type: "toolCall", contentIndex, partialJson: "", lastParseAt: 0 });
    debug("stream:beginToolCall", {
      sourceBlockIndex,
      id,
      name,
      initialArgsKeys: args && typeof args === "object" ? Object.keys(args) : [],
      initialArgsBytes: JSON.stringify(args ?? {}).length,
    });
    this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
  }

  appendToolCallJson({ sourceBlockIndex, delta }: StreamDelta) {
    const active = this.activeBlocks.get(sourceBlockIndex);
    if (active?.type !== "toolCall") return;

    const block = this.output.content[active.contentIndex];
    if (block?.type !== "toolCall") return;

    this.markFirstDelta("toolCall");
    active.partialJson += delta;
    const now = Date.now();
    if (now - active.lastParseAt >= TOOL_INPUT_PARSE_THROTTLE_MS) {
      block.arguments = parseToolArguments(active.partialJson, block.arguments);
      active.lastParseAt = now;
    }
    this.stream.push({ type: "toolcall_delta", contentIndex: active.contentIndex, delta, partial: this.output });
  }

  private markFirstDelta(kind: string) {
    if (this.firstDeltaLogged) return;
    this.firstDeltaLogged = true;
    debug("time:firstDelta", {
      ms: Number((performance.now() - this.turnStartedAt).toFixed(2)),
      kind,
    });
  }

  finishContentBlock(sourceBlockIndex: number) {
    const active = this.activeBlocks.get(sourceBlockIndex);
    if (!active) return;

    const block = this.output.content[active.contentIndex];
    this.activeBlocks.delete(sourceBlockIndex);

    if (block?.type === "text") {
      this.stream.push({ type: "text_end", contentIndex: active.contentIndex, content: block.text, partial: this.output });
    } else if (block?.type === "thinking") {
      this.stream.push({ type: "thinking_end", contentIndex: active.contentIndex, content: block.thinking, partial: this.output });
    } else if (block?.type === "toolCall" && active.type === "toolCall") {
      block.arguments = parseToolArguments(active.partialJson, block.arguments);
      debug("stream:finishToolCall", {
        id: block.id,
        name: block.name,
        partialJsonBytes: active.partialJson.length,
        partialJsonPreview: active.partialJson.slice(0, 400),
        finalArgsKeys: block.arguments ? Object.keys(block.arguments) : [],
        finalArgsBytes: JSON.stringify(block.arguments ?? {}).length,
      });
      this.stream.push({ type: "toolcall_end", contentIndex: active.contentIndex, toolCall: block, partial: this.output });
    }
  }
}

export function applyTurnUpdate(update: TurnUpdate, state: PiStreamState, toolBridge: ToolBridge): boolean {
  switch (update.type) {
    case "event":
      state.markStreamingContentReceived();
      return applyTurnEvent(update.event, state, toolBridge);
    case "assistantBackfill":
      return applyAssistantBackfill(update.backfill, update.stopReason, update.usage, state, toolBridge);
    case "result":
      return applyTurnResult(update.result, state);
  }
}

function applyAssistantBackfill(
  backfill: AssistantBackfill[],
  stopReason: FinishedStopReason,
  usage: TurnUsage | undefined,
  state: PiStreamState,
  toolBridge: ToolBridge,
): boolean {
  // The live SDK stream emits assistant messages with stop_reason: null.
  // The authoritative stop_reason arrives via stream_event: message_delta.
  // Don't let the backfill's null→"stop" overwrite a meaningful stop reason
  // already set by stream events.
  if (stopReason !== "stop" || !state.hasMeaningfulStopReason()) {
    state.setStopReason(stopReason);
  }
  state.applyUsage(usage);

  if (backfill.length > 0) {
    if (state.acceptsAssistantBackfill()) {
      toolBridge.beginMessage();
      for (const item of backfill) {
        applyAssistantBackfillItem(item, state, toolBridge);
      }
    } else {
      // Claude Code can emit streamed thinking/text and then later surface the
      // final tool_use only on assistant backfill. Do not drop those delayed
      // tool calls just because earlier stream events arrived.
      for (const item of backfill) {
        if (item.type === "toolCall") {
          applyAssistantBackfillItem(item, state, toolBridge);
        }
      }
      // The SDK surfaces one assistant envelope per content block while the
      // stream is still emitting sibling blocks. Finishing on the first
      // tool-call envelope would drop parallel tool calls that follow (their
      // ids never register with the bridge, so the SDK's MCP calls fail).
      // Only finish from backfill once message_stop has confirmed the
      // logical message is complete.
      if (!state.hasSeenMessageStop()) return false;
    }
    if (state.finishToolUseIfPresent()) return true;
  }

  return false;
}

function applyTurnResult(result: TurnResult, state: PiStreamState): boolean {
  if (state.finished) {
    // Stream was already finished by the assistant message path. Apply any
    // final usage tweak from result and detach.
    return true;
  }

  if (result.type === "error") {
    state.output.errorMessage = result.message;
    if (result.text) {
      state.backfillText(result.text);
    }
    state.fail(result.message, false);
    return true;
  }

  const hasText = state.output.content.some((block) => block.type === "text" && block.text.trim().length > 0);
  if (!hasText && result.text) {
    state.backfillText(result.text);
  }

  if (result.stopReason === "toolUse" && !state.hasToolCall()) {
    state.setStopReason("toolUse");
    return false;
  }

  state.finish(result.stopReason);
  return true;
}

function applyTurnEvent(event: TurnEvent, state: PiStreamState, toolBridge: ToolBridge): boolean {
  switch (event.type) {
    case "messageStarted":
      state.beginMessage(event.usage);
      toolBridge.beginMessage();
      return false;
    case "blockStarted":
      applyBlockStart(event.block, state, toolBridge);
      return false;
    case "blockDelta":
      applyBlockDelta(event.sourceBlockIndex, event.delta, state);
      return false;
    case "blockFinished":
      state.finishContentBlock(event.sourceBlockIndex);
      return false;
    case "messageUpdated":
      state.setStopReason(event.stopReason);
      state.applyUsage(event.usage);
      return false;
    case "messageFinished":
      state.markMessageStopSeen();
      return state.finishToolUseIfPresent();
  }
}

function applyBlockStart(block: TurnBlockStart, state: PiStreamState, toolBridge: ToolBridge) {
  switch (block.kind) {
    case "text":
      state.beginTextBlock(block.sourceBlockIndex);
      return;
    case "thinking":
      state.beginThinkingBlock(block.sourceBlockIndex);
      return;
    case "toolCall": {
      const toolCall = {
        sourceBlockIndex: block.sourceBlockIndex,
        id: block.id,
        name: stripMcpToolName(block.mcpToolName),
        args: block.input as ToolCall["arguments"],
      };
      state.beginToolCall(toolCall);
      toolBridge.register(toolCall.id);
    }
  }
}

function applyBlockDelta(sourceBlockIndex: number, delta: TurnBlockDelta, state: PiStreamState) {
  switch (delta.kind) {
    case "text":
      state.appendTextDelta({ sourceBlockIndex, delta: delta.text });
      return;
    case "thinking":
      state.appendThinkingDelta({ sourceBlockIndex, delta: delta.thinking });
      return;
    case "thinkingSignature":
      state.appendThinkingSignature({ sourceBlockIndex, signature: delta.signature });
      return;
    case "toolInputJson":
      state.appendToolCallJson({ sourceBlockIndex, delta: delta.partialJson });
  }
}

function applyAssistantBackfillItem(item: AssistantBackfill, state: PiStreamState, toolBridge: ToolBridge) {
  switch (item.type) {
    case "text":
      state.backfillText(item.text);
      return;
    case "thinking":
      state.backfillThinking(item.thinking, item.signature);
      return;
    case "toolCall": {
      const name = stripMcpToolName(item.mcpToolName);
      if (state.backfillToolCall(item.id, name, item.input as ToolCall["arguments"])) {
        toolBridge.register(item.id);
      }
    }
  }
}

function parseToolArguments(partialJson: string, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!partialJson) return fallback;
  try {
    return JSON.parse(partialJson) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}
