import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSupportedImageMediaType, type PromptImageMediaType } from "./sdk/prompt.js";

const CLI_VERSION = "2.1.141";
const COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const stores = new Map<string, DurableSessionStore>();

const projectKeyFor = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
const safeId = (value: string) => /^[a-zA-Z0-9_-]+$/.test(value);

export class DurableSessionStore implements SessionStore {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  private path(projectKey: string, sessionId: string): string {
    if (!safeId(projectKey) || !safeId(sessionId)) throw new Error("Invalid Claude transcript store key");
    // The SDK derives projectKey from the process cwd. Pi sessions can be
    // reopened from another cwd, so the extension-owned root already provides
    // project isolation and the durable identity is the Claude session ID.
    return join(this.root, `${sessionId}.jsonl`);
  }

  async append(key: { projectKey: string; sessionId: string; subpath?: string }, entries: SessionStoreEntry[]): Promise<void> {
    if (key.subpath) throw new Error("Claude transcript subpaths are not supported");
    const path = this.path(key.projectKey, key.sessionId);
    const previous = this.queues.get(path) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const current = (await this.load(key)) ?? [];
      const seen = new Set(current.flatMap((entry) => typeof entry.uuid === "string" ? [entry.uuid] : []));
      const merged = [...current];
      for (const entry of entries) {
        if (entry.uuid && seen.has(entry.uuid)) continue;
        merged.push(entry);
        if (entry.uuid) seen.add(entry.uuid);
      }
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${merged.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
      await rename(temporary, path);
    });
    this.queues.set(path, operation);
    try { await operation; } finally { if (this.queues.get(path) === operation) this.queues.delete(path); }
  }

  async load(key: { projectKey: string; sessionId: string; subpath?: string }): Promise<SessionStoreEntry[] | null> {
    if (key.subpath) return null;
    const path = this.path(key.projectKey, key.sessionId);
    try {
      const text = await readFile(path, "utf8");
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionStoreEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`Unable to load Claude transcript ${key.sessionId}`, { cause: error });
    }
  }

  async delete(key: { projectKey: string; sessionId: string; subpath?: string }): Promise<void> {
    if (key.subpath) return;
    await rm(this.path(key.projectKey, key.sessionId), { force: true });
  }
}

export function storeForPiSession(piSessionId: string): DurableSessionStore {
  if (!safeId(piSessionId)) throw new Error("Invalid Pi session ID for Claude transcript store");
  let store = stores.get(piSessionId);
  if (!store) {
    store = new DurableSessionStore(join(getAgentDir(), "state", "claude-agent-sdk", "sessions", piSessionId));
    stores.set(piSessionId, store);
  }
  return store;
}

function envelope(sessionId: string, cwd: string, parentUuid: string | null, uuid: string) {
  return {
    parentUuid,
    isSidechain: false,
    uuid,
    timestamp: new Date().toISOString(),
    userType: "external",
    entrypoint: "sdk-ts",
    cwd,
    sessionId,
    version: CLI_VERSION,
    gitBranch: "HEAD",
  };
}

type CompactContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: PromptImageMediaType; data: string } };

function contentBlocks(content: unknown, location: string): CompactContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw new Error(`Unsupported ${location} content`);
  const parts: CompactContentBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") throw new Error(`Unsupported ${location} block`);
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      const previous = parts.at(-1);
      if (previous?.type === "text") previous.text += `\n${block.text}`;
      else parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      if (!isSupportedImageMediaType(block.mimeType)) {
        throw new Error(`Unsupported ${location} image MIME type: ${block.mimeType}`);
      }
      parts.push({
        type: "image",
        source: { type: "base64", media_type: block.mimeType, data: block.data },
      });
      continue;
    }
    throw new Error(`Unsupported ${location} block: ${String(block.type)}`);
  }
  return parts;
}

function prefixContent(prefix: string, blocks: CompactContentBlock[]): CompactContentBlock[] {
  const [first, ...rest] = blocks;
  if (first?.type === "text") return [{ type: "text", text: `${prefix}\n${first.text}` }, ...rest];
  return [{ type: "text", text: prefix }, ...blocks];
}

function formatRetainedMessage(message: Record<string, unknown>, index: number): CompactContentBlock[] | undefined {
  if (message.role === "user") {
    return prefixContent("User:", contentBlocks(message.content, `user message ${index}`));
  }
  if (message.role === "branchSummary" && typeof message.summary === "string") {
    return [{ type: "text", text: `Branch summary:\n${message.summary}` }];
  }
  if (message.role === "toolResult") {
    if (typeof message.toolCallId !== "string") throw new Error(`Tool result at ${index} is missing toolCallId`);
    const label = message.isError ? "Tool error" : "Tool result";
    return prefixContent(
      `${label} (${message.toolCallId}):`,
      contentBlocks(message.content, `tool result ${index}`),
    );
  }
  if (message.role === "bashExecution") {
    if (message.excludeFromContext === true) return undefined;
    const command = typeof message.command === "string" ? message.command : "";
    const output = typeof message.output === "string" ? message.output : "";
    return [{ type: "text", text: `User shell command:\n${command}\n\nShell output:\n${output || "(no output)"}` }];
  }
  if (message.role === "custom") {
    return prefixContent("Context:", contentBlocks(message.content, `custom message ${index}`));
  }
  if (message.role !== "assistant") throw new Error(`Unsupported Pi transcript role: ${String(message.role)}`);
  if (!Array.isArray(message.content)) throw new Error(`Unsupported assistant content at ${index}`);
  // Pi excludes failed assistant messages when it builds provider context. Do
  // the same for the materialized Claude transcript: aborted turns are often
  // empty, while API failures may contain diagnostic text such as "Prompt is
  // too long" that is not part of the conversation to continue.
  if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;

  const parts: string[] = [];
  for (const raw of message.content) {
    if (!raw || typeof raw !== "object") throw new Error(`Unsupported assistant block at ${index}`);
    const block = raw as Record<string, unknown>;
    if (block.type === "thinking") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(`Assistant:\n${block.text}`);
      continue;
    }
    if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
      parts.push(`Assistant tool call (${block.id}): ${block.name}(${JSON.stringify(block.arguments ?? {})})`);
      continue;
    }
    throw new Error(`Unsupported assistant block: ${String(block.type)}`);
  }
  if (parts.length === 0) throw new Error(`Assistant message ${index} has no compactable content`);
  return [{ type: "text", text: parts.join("\n\n") }];
}

function contentText(content: unknown, location: string): string {
  const blocks = contentBlocks(content, location);
  if (blocks.some((block) => block.type !== "text")) throw new Error(`Unsupported ${location} block: image`);
  return blocks.map((block) => block.type === "text" ? block.text : "").join("\n");
}

function compactionSummaryText(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const message = raw as Record<string, unknown>;
  if (message.role === "compactionSummary" && typeof message.summary === "string") return message.summary;
  if (message.role !== "user") return undefined;
  try {
    const text = contentText(message.content, "compaction summary");
    if (!text.startsWith(COMPACTION_SUMMARY_PREFIX) || !text.endsWith(COMPACTION_SUMMARY_SUFFIX)) return undefined;
    return text.slice(COMPACTION_SUMMARY_PREFIX.length, -COMPACTION_SUMMARY_SUFFIX.length);
  } catch {
    return undefined;
  }
}

export function encodePiMessages(messages: unknown[], sessionId: string, cwd: string): SessionStoreEntry[] {
  const summaryIndex = messages.findIndex((raw) => compactionSummaryText(raw) !== undefined);
  const hasPiSummary = summaryIndex >= 0;
  const summaryText = hasPiSummary ? compactionSummaryText(messages[summaryIndex]) : undefined;
  if (hasPiSummary && summaryText === undefined) throw new Error("Pi compaction summary is missing summary text");

  const messagesToEncode = hasPiSummary ? messages.slice(summaryIndex + 1) : messages;
  const encodedMessages = messagesToEncode.map((raw, offset) => {
    const originalIndex = hasPiSummary ? summaryIndex + offset + 1 : offset;
    if (!raw || typeof raw !== "object") throw new Error(`Unsupported Pi transcript message at ${originalIndex}`);
    return formatRetainedMessage(raw as Record<string, unknown>, originalIndex);
  }).filter((blocks): blocks is CompactContentBlock[] => blocks !== undefined);

  const compactBlocks: CompactContentBlock[] = [];
  const appendText = (text: string) => {
    const previous = compactBlocks.at(-1);
    if (previous?.type === "text") {
      previous.text += text;
    } else {
      compactBlocks.push({ type: "text", text });
    }
  };
  if (hasPiSummary) {
    appendText("This session is being continued from a previous conversation that ran out of context.");
    appendText(`\n\nSummary:\n${summaryText}`);
  } else {
    appendText("This session is being continued from a selected Pi conversation branch.");
  }
  if (encodedMessages.length > 0) {
    appendText(hasPiSummary ? "\n\nRetained recent messages:" : "\n\nSelected branch messages:");
    for (const [index, blocks] of encodedMessages.entries()) {
      appendText(index === 0 ? "\n" : "\n\n");
      for (const block of blocks) {
        if (block.type === "text") appendText(block.text);
        else compactBlocks.push(block);
      }
    }
  }
  appendText(hasPiSummary
    ? "\n\nContinue the conversation from this compacted state."
    : "\n\nContinue the conversation from this selected branch.");
  const compactContent = compactBlocks.some((block) => block.type === "image")
    ? compactBlocks
    : compactBlocks.map((block) => block.type === "text" ? block.text : "").join("");

  const logicalParentUuid = crypto.randomUUID();
  const boundaryUuid = crypto.randomUUID();
  const summaryUuid = crypto.randomUUID();
  const boundary = {
    ...envelope(sessionId, cwd, null, boundaryUuid),
    logicalParentUuid,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    level: "info",
    compactMetadata: {
      trigger: "manual",
      preTokens: 0,
      postTokens: 0,
      cumulativeDroppedTokens: 0,
      durationMs: 0,
      preCompactDiscoveredTools: [],
      preservedSegment: { headUuid: logicalParentUuid, anchorUuid: logicalParentUuid, tailUuid: logicalParentUuid },
      preservedMessages: { anchorUuid: logicalParentUuid, uuids: [logicalParentUuid], allUuids: [logicalParentUuid] },
    },
  } as SessionStoreEntry;
  const summary = {
    ...envelope(sessionId, cwd, boundaryUuid, summaryUuid),
    promptId: crypto.randomUUID(),
    type: "user",
    message: { role: "user", content: compactContent },
    isVisibleInTranscriptOnly: true,
    isCompactSummary: true,
    session_id: sessionId,
  } as SessionStoreEntry;
  return [boundary, summary];
}

export async function seedPiMessages(piSessionId: string, messages: unknown[], cwd: string) {
  const sessionId = crypto.randomUUID();
  const store = storeForPiSession(piSessionId);
  await store.append({ projectKey: projectKeyFor(cwd), sessionId }, encodePiMessages(messages, sessionId, cwd));
  return { sessionId, store };
}
