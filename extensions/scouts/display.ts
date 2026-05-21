// Display item extraction and formatting helpers.
//
// Shared between execute (which produces display items) and render
// (which consumes them).

import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

import type { DisplayItem, ScoutDetails } from "./types.ts";

type ToolResultLike = Pick<AgentToolResult<unknown>, "content"> | ToolResultMessage<unknown>;

export const MAX_DISPLAY_ITEMS = 120;

export function getAssistantText(message: AgentMessage | AssistantMessage | undefined): string {
  if (!message || !isAssistantMessage(message)) return "";

  const blocks: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") blocks.push(part.text);
  }
  return blocks.join("");
}

// Extract the last assistant text block from session messages
export function getLastAssistantText(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = getAssistantText(messages[i]);
    if (text) return text;
  }
  return "";
}

// Extract interleaved display items from session messages
export function extractDisplayItems(messages: readonly AgentMessage[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  const toolItemById = new Map<string, DisplayItem & { type: "tool" }>();

  for (const msg of messages) {
    if (isAssistantMessage(msg)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text.trim()) {
          items.push({ type: "text", text: part.text });
        } else if (part.type === "toolCall") {
          const item: DisplayItem & { type: "tool" } = {
            type: "tool",
            name: part.name,
            args: part.arguments,
            toolCallId: part.id,
          };
          items.push(item);
          toolItemById.set(part.id, item);
        }
      }
    } else if (isToolResultMessage(msg) && msg.toolCallId) {
      const toolItem = toolItemById.get(msg.toolCallId);
      if (toolItem) {
        const text = extractToolResultText(msg);
        if (text) toolItem.result = text;
        if (msg.isError) toolItem.isError = true;
        toolItem.isPartial = isPartialToolResult(msg);
        const nestedScout = scoutDetailsFromUnknown(getToolResultDetails(msg));
        if (nestedScout) toolItem.nestedScout = nestedScout;
      }
    }
  }
  return items;
}

// Format a tool call for inline display
export function formatToolCallParts(name: string, args: Record<string, unknown>): { label: string; summary: string } {
  switch (name) {
    case "reviewer": {
      const lens = typeof args.lens === "string"
        ? args.lens
        : Array.isArray(args.lenses) && typeof args.lenses[0] === "string"
          ? args.lenses[0]
          : undefined;
      const label = lens ? `reviewer ${lens}` : "reviewer";
      const query = typeof args.query === "string" ? args.query : "";
      return { label, summary: summarize(query) };
    }
    case "factCheck": {
      const target = typeof args.target === "string" && args.target.trim() ? args.target.trim() : "draft";
      const draft = typeof args.draft === "string" ? args.draft.trim() : "";
      const summary = draft
        ? `${target}: ${draft.split("\n")[0]}`
        : target;
      return { label: "factCheck", summary: summarize(summary) };
    }
    case "bash": {
      const cmd = summarize(((args.command as string) || ""));
      return { label: "bash", summary: cmd };
    }
    case "read": {
      const readPath = shortenPath((args.path || "") as string);
      const offset = args.offset ? `:${args.offset}` : "";
      const limit = args.limit ? `-${Number(args.offset ?? 1) + Number(args.limit) - 1}` : "";
      return { label: "read", summary: readPath + offset + limit };
    }
    default: {
      const previewKeys = ["command", "path", "pattern", "query", "url", "task"];
      for (const key of previewKeys) {
        if (args[key] && typeof args[key] === "string") {
          const val = summarize(args[key] as string);
          return { label: name, summary: val };
        }
      }
      const s = JSON.stringify(args);
      return { label: name, summary: s };
    }
  }
}

// Shorten text for display
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

// Clean tool result text for display (strip budget lines, optionally truncate)
export function cleanToolResult(raw: string, maxLines?: number): string {
  const cleaned = raw.replace(/\n*\[turn budget\][^\n]*/g, "").trimEnd();
  if (maxLines === undefined) return cleaned;

  const lines = cleaned.split("\n");
  return lines.length > maxLines
    ? lines.slice(0, maxLines).join("\n") + `\n… (${lines.length - maxLines} more lines)`
    : cleaned;
}

// Path shortening utilities
function shortenPath(p: string): string {
  const cwd = process.cwd();
  if (cwd && p.startsWith(cwd + "/")) return "./" + p.slice(cwd.length + 1);
  if (p === cwd) return ".";
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function summarize(s: string): string {
  return shortenPaths(s.replace(/\s+/g, " ").trim());
}

function shortenPaths(s: string): string {
  const cwd = process.cwd();
  const home = process.env.HOME || "";
  let result = s;
  if (cwd) result = result.replaceAll(cwd, ".");
  if (home) result = result.replaceAll(home, "~");
  return result;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return typeof message === "object" && message !== null && "role" in message && message.role === "assistant";
}

function isToolResultMessage(message: AgentMessage): message is ToolResultMessage<unknown> {
  return typeof message === "object" && message !== null && "role" in message && message.role === "toolResult";
}

function isPartialToolResult(message: ToolResultMessage<unknown>): boolean {
  return "isPartial" in message && message.isPartial === true;
}

function getToolResultDetails(message: ToolResultMessage<unknown>): unknown {
  return "details" in message ? message.details : undefined;
}

export function scoutDetailsFromUnknown(value: unknown): ScoutDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Partial<ScoutDetails>;
  if ((details.mode === "single" || details.mode === "parallel") && Array.isArray(details.runs)) {
    return details as ScoutDetails;
  }
  return undefined;
}

// Extract text content from a tool result message
export function extractToolResultText(tr: ToolResultLike): string | undefined {
  const texts = tr.content
    .filter((content): content is TextContent => content.type === "text")
    .map((content) => content.text);
  return texts.length > 0 ? texts.join("\n") : undefined;
}
