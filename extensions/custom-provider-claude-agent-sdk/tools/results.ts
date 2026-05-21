import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "@earendil-works/pi-ai";

export interface PiMcpResult extends CallToolResult {
  toolCallId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createMcpTextResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

function toolResultContentToMcpContent(content: unknown): CallToolResult["content"] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: "" }];

  const blocks: CallToolResult["content"] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;

    if (item.type === "text" && typeof item.text === "string") {
      blocks.push({ type: "text", text: item.text });
      continue;
    }

    if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      blocks.push({ type: "image", data: item.data, mimeType: item.mimeType });
    }
  }

  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

export function extractToolResults(context: Context): PiMcpResult[] {
  const results: PiMcpResult[] = [];

  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];

    if (message.role === "assistant") break;

    if (message.role === "toolResult") {
      results.unshift({
        content: toolResultContentToMcpContent(message.content),
        isError: message.isError,
        toolCallId: message.toolCallId,
      });
    }
  }

  return results;
}
