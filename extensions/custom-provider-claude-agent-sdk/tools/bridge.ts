import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { debug } from "../sdk/debug.js";
import { createMcpTextResult, type PiMcpResult } from "./results.js";

interface PendingToolCall {
  resolve: (result: CallToolResult) => void;
}

export class ToolBridge {
  private streamedIds: string[] = [];
  private nextClaimIndex = 0;
  private pendingToolCalls = new Map<string, PendingToolCall>();
  private pendingResults = new Map<string, CallToolResult>();

  beginMessage() {
    debug("bridge:beginMessage", { discardedStreamedIds: this.streamedIds.length });
    this.streamedIds = [];
    this.nextClaimIndex = 0;
  }

  register(toolCallId: string) {
    if (!this.streamedIds.includes(toolCallId)) {
      this.streamedIds.push(toolCallId);
      debug("bridge:register", { toolCallId, streamedIdsCount: this.streamedIds.length });
    }
  }

  handleMcpToolCall(toolName: string): Promise<CallToolResult> {
    const toolCallId = this.streamedIds[this.nextClaimIndex++];
    if (!toolCallId) {
      debug("bridge:handleMcpToolCall", { toolName, outcome: "no-claimable-id", claimIndex: this.nextClaimIndex - 1 });
      return Promise.resolve(createMcpTextResult(`Tool ${toolName} was called before Pi received a matching tool call id.`, true));
    }

    const queued = this.pendingResults.get(toolCallId);
    if (queued) {
      debug("bridge:handleMcpToolCall", { toolName, toolCallId, outcome: "queued-result-immediate" });
      this.pendingResults.delete(toolCallId);
      return Promise.resolve(queued);
    }

    debug("bridge:handleMcpToolCall", { toolName, toolCallId, outcome: "awaiting-result" });
    return new Promise<CallToolResult>((resolve) => {
      this.pendingToolCalls.set(toolCallId, { resolve });
    });
  }

  deliverToolResults(results: PiMcpResult[]) {
    let resolvedPending = 0;
    let queuedFuture = 0;
    for (const result of results) {
      const toolCallId = result.toolCallId;
      if (!toolCallId) continue;

      const pending = this.pendingToolCalls.get(toolCallId);
      if (pending) {
        this.pendingToolCalls.delete(toolCallId);
        pending.resolve(result);
        resolvedPending += 1;
      } else {
        this.pendingResults.set(toolCallId, result);
        queuedFuture += 1;
      }
    }
    debug("bridge:deliverToolResults", {
      total: results.length,
      resolvedPending,
      queuedFuture,
      stillPending: this.pendingToolCalls.size,
      queuedResults: this.pendingResults.size,
    });
  }

  resolvePendingToolCalls(result: CallToolResult) {
    if (this.pendingToolCalls.size === 0) return;
    debug("bridge:resolvePendingToolCalls", { count: this.pendingToolCalls.size });
    for (const pending of this.pendingToolCalls.values()) {
      pending.resolve(result);
    }
    this.pendingToolCalls.clear();
  }

  resolvePendingWithError(message: string) {
    if (this.pendingToolCalls.size > 0) {
      debug("bridge:resolvePendingWithError", { count: this.pendingToolCalls.size, message });
    }
    this.resolvePendingToolCalls(createMcpTextResult(message, true));
  }

  clearQueuedResults() {
    if (this.pendingResults.size > 0) {
      debug("bridge:clearQueuedResults", { count: this.pendingResults.size });
    }
    this.pendingResults.clear();
  }
}
