import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionManager } from "./session.js";
import { debug } from "./sdk/debug.js";

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;

    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }

    if (block.type === "image") {
      parts.push("[Image attached]");
    }
  }

  return parts.join("\n").trim();
}

function summarizeToolArguments(name: string, args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";

  const record = args as Record<string, unknown>;
  const primary =
    typeof record.path === "string" ? record.path
    : typeof record.command === "string" ? record.command
    : typeof record.query === "string" ? record.query
    : typeof record.url === "string" ? record.url
    : undefined;

  if (primary) return ` ${primary}`;

  const json = JSON.stringify(args);
  return json === "{}" ? "" : ` ${json}`;
}

function formatToolCall(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type !== "toolCall") continue;

    const name = typeof block.name === "string" ? block.name : "tool";
    parts.push(`${name}${summarizeToolArguments(name, block.arguments)}:`);
  }

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function formatAgentMessageForHandoff(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const entry = message as Record<string, unknown>;

  if (entry.role === "user") {
    const text = extractContentText(entry.content);
    return text ? `User:\n${text}` : undefined;
  }

  if (entry.role === "assistant") {
    const text = extractContentText(entry.content);
    const toolCalls = formatToolCall(entry.content);
    return [text ? `Assistant:\n${text}` : undefined, toolCalls].filter(Boolean).join("\n\n");
  }

  if (entry.role === "toolResult") {
    const toolName = typeof entry.toolName === "string" ? entry.toolName : "tool";
    const text = extractContentText(entry.content);
    const prefix = entry.isError ? `${toolName} error:` : undefined;
    if (prefix) return text ? `${prefix}\n${text}` : prefix;
    return text || undefined;
  }

  if (entry.role === "bashExecution") {
    const command = typeof entry.command === "string" ? entry.command : "";
    const output = typeof entry.output === "string" ? entry.output : "";
    return `Ran \`${command}\`\n\n${output || "(no output)"}`;
  }

  if (entry.role === "custom") {
    const text = extractContentText(entry.content);
    return text ? `Context:\n${text}` : undefined;
  }

  if (entry.role === "compactionSummary" && typeof entry.summary === "string") {
    return `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${entry.summary}\n</summary>`;
  }

  if (entry.role === "branchSummary" && typeof entry.summary === "string") {
    return `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${entry.summary}\n</summary>`;
  }

  return undefined;
}

function joinHandoffSections(title: string, sections: string[]): string | undefined {
  const cleaned: string[] = [];
  for (const section of sections.map((item) => item.trim()).filter(Boolean)) {
    const previous = cleaned[cleaned.length - 1];
    if (previous?.endsWith(":")) {
      cleaned[cleaned.length - 1] = `${previous}\n${section}`;
    } else {
      cleaned.push(section);
    }
  }
  if (cleaned.length === 0) return undefined;

  return `${title}\n\n<pi_handoff>\nPrior conversation context for continuity. Do not continue this transcript or imitate tool lines. If current work requires a tool, use the actual tool interface.\n\n${cleaned.join("\n\n")}\n</pi_handoff>\n\nThe user's next message follows in a separate turn.`;
}

function findCurrentPromptIndex(branch: SessionEntry[]): number {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message" && entry.message.role === "user") {
      return i;
    }
  }
  return -1;
}

function buildFreshSeedHandoff(sessionManager: SessionManager, currentPromptIndex: number): string | undefined {
  const branch = sessionManager.getBranch();
  const targetLeafId = currentPromptIndex > 0 ? branch[currentPromptIndex - 1]?.id ?? null : null;
  const visible = buildSessionContext(sessionManager.getEntries(), targetLeafId).messages;
  const sections = visible.map((message) => formatAgentMessageForHandoff(message)).filter(Boolean) as string[];
  const handoff = joinHandoffSections("Pi session handoff for Claude Agent SDK:", sections);

  debug("handoff:freshSeed", {
    branchLength: branch.length,
    currentPromptIndex,
    targetLeafId,
    visibleMessages: visible.length,
    sections: sections.length,
    bytes: handoff?.length ?? 0,
  });

  return handoff;
}

export function buildPiSessionHandoff(
  sessionManager: SessionManager | undefined,
): string | undefined {
  if (!sessionManager) {
    debug("handoff:buildPiSessionHandoff", { skipped: "no-session-manager" });
    return undefined;
  }

  const branch = sessionManager.getBranch();
  const currentPromptIndex = findCurrentPromptIndex(branch);

  debug("handoff:buildPiSessionHandoff", {
    branchLength: branch.length,
    currentPromptIndex,
  });
  return buildFreshSeedHandoff(sessionManager, currentPromptIndex);
}

export function buildContextMessagesHandoff(messages: unknown[]): string | undefined {
  let currentPromptIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && typeof message === "object" && (message as { role?: unknown }).role === "user") {
      currentPromptIndex = i;
      break;
    }
  }

  const priorMessages = currentPromptIndex >= 0 ? messages.slice(0, currentPromptIndex) : messages;
  const sections = priorMessages.map((message) => formatAgentMessageForHandoff(message)).filter(Boolean) as string[];
  const handoff = joinHandoffSections("Pi context handoff for Claude Agent SDK:", sections);

  debug("handoff:contextFallback", {
    totalMessages: messages.length,
    priorMessages: priorMessages.length,
    sections: sections.length,
    bytes: handoff?.length ?? 0,
  });

  return handoff;
}
