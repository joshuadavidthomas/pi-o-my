import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { encodePiMessages } from "../native-reseed.js";
import {
  InMemorySessionStore,
  query,
  type Options,
  type SDKMessage,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

const runIntegration = process.env.PI_CLAUDE_AGENT_SDK_RUN_INTEGRATION === "1";
const integration = runIntegration ? describe : describe.skip;
const temporaryDirectories: string[] = [];

// SessionStore keys use the same project-directory encoding as
// ~/.claude/projects rather than the literal cwd.
const projectKeyFor = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

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
    version: "2.1.141",
    gitBranch: "HEAD",
  };
}

async function createConfigDirectory(): Promise<string> {
  // SessionStore keeps probe transcripts out of ~/.claude/projects. Reuse the
  // real config directory so OAuth refresh-token rotation is persisted there;
  // copying credentials into disposable directories can invalidate the source
  // refresh token without updating it.
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function assistantEntry(
  sessionId: string,
  cwd: string,
  parentUuid: string,
  uuid: string,
  content: Array<Record<string, unknown>>,
): SessionStoreEntry {
  return {
    ...envelope(sessionId, cwd, parentUuid, uuid),
    type: "assistant",
    requestId: `req_${uuid}`,
    message: {
      model: "claude-fable-5",
      id: `msg_${uuid}`,
      type: "message",
      role: "assistant",
      content,
      stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
  };
}

function userEntry(
  sessionId: string,
  cwd: string,
  parentUuid: string | null,
  uuid: string,
  content: string | Array<Record<string, unknown>>,
): SessionStoreEntry {
  return {
    ...envelope(sessionId, cwd, parentUuid, uuid),
    type: "user",
    message: { role: "user", content },
  };
}

function compactBoundaryEntry(
  sessionId: string,
  cwd: string,
  logicalParentUuid: string,
  uuid: string,
  preservedUuids: string[],
): SessionStoreEntry {
  return {
    ...envelope(sessionId, cwd, null, uuid),
    logicalParentUuid,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    level: "info",
    compactMetadata: {
      trigger: "manual",
      preTokens: 100_000,
      postTokens: 1_000,
      cumulativeDroppedTokens: 99_000,
      durationMs: 1,
      preCompactDiscoveredTools: [],
      preservedSegment: {
        headUuid: preservedUuids[0],
        anchorUuid: preservedUuids[0],
        tailUuid: preservedUuids.at(-1),
      },
      preservedMessages: {
        anchorUuid: preservedUuids[0],
        uuids: preservedUuids,
        allUuids: preservedUuids,
      },
    },
  } as SessionStoreEntry;
}

async function runResume(
  sessionId: string,
  store: InMemorySessionStore,
  cwd: string,
  configDirectory: string,
  prompt: string,
): Promise<{ text: string; toolUses: number }> {
  const { ANTHROPIC_API_KEY: _stripped, ...inherited } = process.env;
  const options: Options = {
    resume: sessionId,
    sessionStore: store,
    cwd,
    model: "claude-fable-5",
    tools: [],
    allowedTools: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: true,
    env: {
      ...inherited,
      CLAUDE_CONFIG_DIR: configDirectory,
      DISABLE_AUTO_COMPACT: "1",
    },
  };

  let text = "";
  let toolUses = 0;
  const conversation = query({ prompt, options });
  try {
    for await (const message of conversation as AsyncIterable<SDKMessage>) {
      if (message.type !== "assistant") continue;
      for (const block of message.message.content) {
        if (block.type === "text") text += block.text;
        if (block.type === "tool_use") toolUses += 1;
      }
    }
  } finally {
    conversation.close();
  }
  return { text, toolUses };
}

integration("native SessionStore transcript resume", () => {
  afterAll(async () => {
    await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("resumes native assistant text and can resume the mirrored session again", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-claude-reseed-cwd-"));
    temporaryDirectories.push(cwd);
    const configDirectory = await createConfigDirectory();
    const store = new InMemorySessionStore();
    const sessionId = crypto.randomUUID();
    const userUuid = crypto.randomUUID();
    const assistantUuid = crypto.randomUUID();

    await store.append(
      { projectKey: projectKeyFor(cwd), sessionId },
      [
        userEntry(sessionId, cwd, null, userUuid, "Remember the project codename supplied by the assistant."),
        assistantEntry(sessionId, cwd, userUuid, assistantUuid, [
          { type: "text", text: "The project codename is NATIVE-ORCHID-731." },
        ]),
      ],
    );

    const first = await runResume(
      sessionId,
      store,
      cwd,
      configDirectory,
      "Reply with only the project codename from the conversation history.",
    );
    expect(first.text).toContain("NATIVE-ORCHID-731");

    const mirrored = await store.load({ projectKey: projectKeyFor(cwd), sessionId });
    expect(mirrored?.length).toBeGreaterThan(2);

    const second = await runResume(
      sessionId,
      store,
      cwd,
      configDirectory,
      "Reply with only that same project codename again.",
    );
    expect(second.text).toContain("NATIVE-ORCHID-731");
  }, 120_000);

  it("resumes Claude-style compacted state with retained narration and completed tool history", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-claude-compact-state-cwd-"));
    temporaryDirectories.push(cwd);
    const configDirectory = await createConfigDirectory();
    const store = new InMemorySessionStore();
    const sessionId = crypto.randomUUID();
    const oldTailUuid = crypto.randomUUID();
    const boundaryUuid = crypto.randomUUID();
    const summaryUuid = crypto.randomUUID();
    const preservedUuids = [oldTailUuid];

    const summary = {
      ...userEntry(
        sessionId,
        cwd,
        boundaryUuid,
        summaryUuid,
        "This session is being continued from an earlier conversation.\n\nSummary:\nThe project is testing compacted context continuity.\n\nRetained recent messages:\nUser: Use the completed lookup to remember the codename.\nAssistant: I will use the completed historical lookup.\nAssistant tool call: lookup({ key: codename })\nTool result: Historical result: COMPACT-CEDAR-583\nAssistant: The completed lookup returned COMPACT-CEDAR-583.\n\nContinue from that state.",
      ),
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
    } as SessionStoreEntry;

    await store.append(
      { projectKey: projectKeyFor(cwd), sessionId },
      [
        compactBoundaryEntry(sessionId, cwd, oldTailUuid, boundaryUuid, preservedUuids),
        summary,
      ],
    );

    const result = await runResume(
      sessionId,
      store,
      cwd,
      configDirectory,
      "Reply with only the codename from the retained completed lookup. Do not call tools.",
    );
    expect(result.text).toContain("COMPACT-CEDAR-583");
    expect(result.toolUses).toBe(0);
  }, 120_000);

  it("accepts production compact-state encoding with a retained image", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-claude-image-compact-cwd-"));
    temporaryDirectories.push(cwd);
    const configDirectory = await createConfigDirectory();
    const store = new InMemorySessionStore();
    const sessionId = crypto.randomUUID();
    const imageData = (await readFile(new URL("../../../assets/pi-o-my.png", import.meta.url))).toString("base64");
    const entries = encodePiMessages([
      { role: "compactionSummary", summary: "The image resume probe codename is IMAGE-CEDAR-214." },
      {
        role: "toolResult",
        toolCallId: "toolu_image_probe",
        toolName: "read",
        content: [{
          type: "image",
          mimeType: "image/png",
          data: imageData,
        }],
        isError: false,
      },
    ], sessionId, cwd);

    await store.append({ projectKey: projectKeyFor(cwd), sessionId }, entries);
    const result = await runResume(
      sessionId,
      store,
      cwd,
      configDirectory,
      "Reply with only the image resume probe codename from the compacted history.",
    );

    expect(result.text).toContain("IMAGE-CEDAR-214");
  }, 120_000);

  it("accepts selected-branch compact-state encoding with completed tool history", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-claude-tree-state-cwd-"));
    temporaryDirectories.push(cwd);
    const configDirectory = await createConfigDirectory();
    const store = new InMemorySessionStore();
    const sessionId = crypto.randomUUID();
    const entries = encodePiMessages([
      { role: "user", content: "Use the completed lookup to remember the selected branch codename." },
      { role: "assistant", content: [
        { type: "text", text: "I will use the completed lookup from this branch." },
        { type: "toolCall", id: "toolu_tree_compact", name: "lookup", arguments: { key: "codename" } },
      ] },
      { role: "toolResult", toolCallId: "toolu_tree_compact", toolName: "lookup", content: [
        { type: "text", text: "Historical result: TREE-MAPLE-816" },
      ] },
      { role: "assistant", content: [{ type: "text", text: "The completed lookup returned TREE-MAPLE-816." }] },
    ], sessionId, cwd);
    await store.append({ projectKey: projectKeyFor(cwd), sessionId }, entries);

    const result = await runResume(
      sessionId,
      store,
      cwd,
      configDirectory,
      "Reply with only the codename from the selected branch. Do not call tools.",
    );
    expect(result.text).toContain("TREE-MAPLE-816");
    expect(result.toolUses).toBe(0);
  }, 120_000);

  it("accepts production compact-state encoding and resumes it twice", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-claude-production-compact-cwd-"));
    temporaryDirectories.push(cwd);
    const configDirectory = await createConfigDirectory();
    const store = new InMemorySessionStore();
    const sessionId = crypto.randomUUID();
    const entries = encodePiMessages([
      {
        role: "user",
        content: [{
          type: "text",
          text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nThe project continuity probe is active.\n</summary>",
        }],
      },
      { role: "user", content: "Use the completed lookup to remember the codename." },
      { role: "assistant", content: [
        { type: "text", text: "I will use the completed historical lookup." },
        { type: "toolCall", id: "toolu_production_compact", name: "lookup", arguments: { key: "codename" } },
      ] },
      { role: "toolResult", toolCallId: "toolu_production_compact", toolName: "lookup", content: [
        { type: "text", text: "Historical result: PRODUCTION-PINE-427" },
      ] },
      { role: "assistant", content: [{ type: "text", text: "The completed lookup returned PRODUCTION-PINE-427." }] },
    ], sessionId, cwd);
    await store.append({ projectKey: projectKeyFor(cwd), sessionId }, entries);

    const first = await runResume(
      sessionId,
      store,
      cwd,
      configDirectory,
      "Reply with only the codename from the compacted completed lookup. Do not call tools.",
    );
    expect(first.text).toContain("PRODUCTION-PINE-427");
    expect(first.toolUses).toBe(0);

    const second = await runResume(
      sessionId,
      store,
      cwd,
      configDirectory,
      "Reply with only that same codename again.",
    );
    expect(second.text).toContain("PRODUCTION-PINE-427");
  }, 120_000);

  it("resumes completed historical tool use without replaying it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-claude-reseed-tool-cwd-"));
    temporaryDirectories.push(cwd);
    const configDirectory = await createConfigDirectory();
    const store = new InMemorySessionStore();
    const sessionId = crypto.randomUUID();
    const userUuid = crypto.randomUUID();
    const assistantUuid = crypto.randomUUID();
    const resultUuid = crypto.randomUUID();
    const finalUuid = crypto.randomUUID();
    const toolUseId = "toolu_historical_native_probe";

    await store.append(
      { projectKey: projectKeyFor(cwd), sessionId },
      [
        userEntry(sessionId, cwd, null, userUuid, "Read the inert historical probe result."),
        assistantEntry(sessionId, cwd, userUuid, assistantUuid, [
          {
            type: "tool_use",
            id: toolUseId,
            name: "mcp__pi_native_reseed_probe__lookup",
            input: { key: "codename" },
            caller: { type: "direct" },
          },
        ]),
        {
          ...userEntry(sessionId, cwd, assistantUuid, resultUuid, [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: [{ type: "text", text: "Historical result: TOOL-ASTER-942" }],
            },
          ]),
          sourceToolAssistantUUID: assistantUuid,
        },
        assistantEntry(sessionId, cwd, resultUuid, finalUuid, [
          { type: "text", text: "The completed historical result says TOOL-ASTER-942." },
        ]),
      ],
    );

    const result = await runResume(
      sessionId,
      store,
      cwd,
      configDirectory,
      "Reply with only the codename found by the completed historical tool call. Do not call tools.",
    );
    expect(result.text).toContain("TOOL-ASTER-942");
    expect(result.toolUses).toBe(0);
  }, 120_000);
});
