import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { debug } from "./debug.js";

export type SdkUserMessage = SDKUserMessage;

function summarize(message: SDKUserMessage): { shouldQuery: boolean | undefined; contentBytes: number } {
  let bytes = 0;
  try {
    bytes = JSON.stringify(message.message?.content ?? "").length;
  } catch {
    // Ignore JSON serialization errors.
  }
  return { shouldQuery: message.shouldQuery, contentBytes: bytes };
}

export class SdkInputQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = [];
  private waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage): boolean {
    if (this.closed) {
      debug("queue:push", { accepted: false, reason: "queue-closed", ...summarize(message) });
      return false;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      debug("queue:push", { accepted: true, deliveredImmediately: true, ...summarize(message) });
      waiter({ value: message, done: false });
      return true;
    }

    this.pending.push(message);
    debug("queue:push", { accepted: true, queued: true, pendingDepth: this.pending.length, ...summarize(message) });
    return true;
  }

  close() {
    if (this.closed) return;

    debug("queue:close", { pendingDepth: this.pending.length, waitersDropped: this.waiters.length });
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.pending.shift();
        if (message) {
          debug("queue:deliver", { source: "pending", remaining: this.pending.length, ...summarize(message) });
          return Promise.resolve({ value: message, done: false });
        }
        if (this.closed) {
          debug("queue:deliver", { source: "closed-end" });
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
