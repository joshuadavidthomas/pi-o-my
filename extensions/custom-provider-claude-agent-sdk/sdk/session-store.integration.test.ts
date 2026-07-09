import { afterAll, describe, expect, it } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-session-store-"));
  temporaryDirectories.push(directory);

  const source = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  await mkdir(directory, { recursive: true });
  for (const filename of [".credentials.json", "settings.json"]) {
    try {
      await copyFile(join(source, filename), join(directory, filename));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return directory;
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
