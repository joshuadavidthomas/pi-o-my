import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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

function contentText(content: unknown, location: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error(`Unsupported ${location} content`);
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") throw new Error(`Unsupported ${location} block`);
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    throw new Error(`Unsupported ${location} block: ${String(block.type)}`);
  }
  return parts.join("\n");
}

function formatRetainedMessage(message: Record<string, unknown>, index: number): string | undefined {
  if (message.role === "user") return `User:\n${contentText(message.content, `user message ${index}`)}`;
  if (message.role === "branchSummary" && typeof message.summary === "string") {
    return `Branch summary:\n${message.summary}`;
  }
  if (message.role === "toolResult") {
    if (typeof message.toolCallId !== "string") throw new Error(`Tool result at ${index} is missing toolCallId`);
    const label = message.isError ? "Tool error" : "Tool result";
    return `${label} (${message.toolCallId}):\n${contentText(message.content, `tool result ${index}`)}`;
  }
  if (message.role !== "assistant") throw new Error(`Unsupported Pi transcript role: ${String(message.role)}`);
  if (!Array.isArray(message.content)) throw new Error(`Unsupported assistant content at ${index}`);

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
  return parts.join("\n\n");
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
  if (summaryIndex < 0) throw new Error("Native compact reseed requires a Pi compaction summary");
  const summaryText = compactionSummaryText(messages[summaryIndex]);
  if (summaryText === undefined) throw new Error("Pi compaction summary is missing summary text");

  const retained = messages.slice(summaryIndex + 1).map((raw, offset) => {
    if (!raw || typeof raw !== "object") throw new Error(`Unsupported Pi transcript message at ${summaryIndex + offset + 1}`);
    return formatRetainedMessage(raw as Record<string, unknown>, summaryIndex + offset + 1);
  }).filter(Boolean);
  const compactContent = [
    "This session is being continued from a previous conversation that ran out of context.",
    `Summary:\n${summaryText}`,
    retained.length > 0 ? `Retained recent messages:\n${retained.join("\n\n")}` : undefined,
    "Continue the conversation from this compacted state.",
  ].filter(Boolean).join("\n\n");

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
