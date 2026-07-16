import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableSessionStore, encodePiMessages } from "./native-reseed.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("DurableSessionStore", () => {
  it("persists ordered entries across instances and deduplicates UUIDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-native-store-"));
    temporaryDirectories.push(root);
    const key = { projectKey: "-tmp-project", sessionId: crypto.randomUUID() };
    const first = new DurableSessionStore(root);
    const entry = { type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: "hello" } };
    await first.append(key, [entry, { type: "mode", mode: "normal" }]);
    await first.append(key, [entry, { type: "mode", mode: "normal" }]);

    const loaded = await new DurableSessionStore(root).load({ ...key, projectKey: "-another-cwd" });
    expect(loaded).toEqual([entry, { type: "mode", mode: "normal" }, { type: "mode", mode: "normal" }]);
  });

  it("rejects path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-native-store-"));
    temporaryDirectories.push(root);
    expect(new DurableSessionStore(root).load({ projectKey: "../escape", sessionId: "session" })).rejects.toThrow(
      "Invalid Claude transcript store key",
    );
  });
});

describe("encodePiMessages", () => {
  it("encodes Pi summary and retained history as Claude compacted state", () => {
    const entries = encodePiMessages([
      { role: "compactionSummary", summary: "Keep this exact summary." },
      { role: "user", content: "inspect it" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "Reading." },
        { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.ts" } },
      ] },
      { role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ], crypto.randomUUID(), "/tmp/project");

    expect(entries.map((entry) => `${entry.type}:${entry.subtype ?? ""}`)).toEqual([
      "system:compact_boundary",
      "user:",
    ]);
    const encoded = JSON.stringify(entries);
    expect(encoded).toContain("Keep this exact summary.");
    expect(encoded).toContain("Retained recent messages");
    expect(encoded).toContain("Assistant tool call (toolu_1): read");
    expect(encoded).toContain("Tool result (toolu_1)");
    expect(encoded).not.toContain("private");
    expect(entries[1]?.parentUuid).toBe(entries[0]?.uuid);
    expect((entries[1] as { isCompactSummary?: boolean }).isCompactSummary).toBeTrue();
  });

  it("recognizes Pi's provider-facing compaction summary user message", () => {
    const entries = encodePiMessages([
      {
        role: "user",
        content: [{
          type: "text",
          text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nProvider-facing summary.\n</summary>",
        }],
      },
      { role: "assistant", content: [{ type: "text", text: "retained answer" }] },
    ], crypto.randomUUID(), "/tmp/project");

    expect(JSON.stringify(entries)).toContain("Provider-facing summary.");
    expect(JSON.stringify(entries)).toContain("retained answer");
  });

  it("omits aborted and failed assistant messages from retained history", () => {
    const entries = encodePiMessages([
      { role: "compactionSummary", summary: "Resume from here." },
      { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Operation aborted" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Prompt is too long" }],
        stopReason: "error",
        errorMessage: "Prompt is too long",
      },
      { role: "user", content: "keep going" },
    ], crypto.randomUUID(), "/tmp/project");

    const encoded = JSON.stringify(entries);
    expect(encoded).toContain("Resume from here.");
    expect(encoded).toContain("keep going");
    expect(encoded).not.toContain("Operation aborted");
    expect(encoded).not.toContain("Prompt is too long");
  });

  it("encodes an ordinary selected branch as Claude compacted state", () => {
    const entries = encodePiMessages([
      { role: "user", content: "ordinary branch prompt" },
      { role: "assistant", content: [{ type: "text", text: "ordinary branch answer" }] },
      { role: "custom", content: "extension context" },
      { role: "bashExecution", command: "pwd", output: "/tmp/project" },
    ], crypto.randomUUID(), "/tmp/project");

    const encoded = JSON.stringify(entries);
    expect(encoded).toContain("This session is being continued from a selected Pi conversation branch.");
    expect(encoded).toContain("Selected branch messages:");
    expect(encoded).not.toContain("ran out of context");
    expect(encoded).toContain("ordinary branch prompt");
    expect(encoded).toContain("ordinary branch answer");
    expect(encoded).toContain("extension context");
    expect(encoded).toContain("User shell command");
    expect((entries[1] as { isCompactSummary?: boolean }).isCompactSummary).toBeTrue();
  });

  it("keeps text-only compact formatting stable across adjacent text blocks", () => {
    const entries = encodePiMessages([
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
    ], crypto.randomUUID(), "/tmp/project");

    expect((entries[1] as { message?: { content?: unknown } }).message?.content).toBe(
      "This session is being continued from a previous conversation that ran out of context.\n\n" +
      "Summary:\nsummary\n\n" +
      "Retained recent messages:\nUser:\nfirst\nsecond\n\n" +
      "Continue the conversation from this compacted state.",
    );
  });

  it("preserves retained user and tool-result images in Claude compacted state", () => {
    const entries = encodePiMessages([
      { role: "compactionSummary", summary: "summary" },
      {
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          { type: "image", data: "user-image", mimeType: "image/png" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "toolu_image",
        toolName: "read",
        content: [{ type: "image", data: "tool-image", mimeType: "image/jpeg" }],
        isError: false,
      },
    ], crypto.randomUUID(), "/tmp/project");

    const content = (entries[1] as { message?: { content?: unknown } }).message?.content;
    expect(content).toEqual([
      { type: "text", text: expect.stringContaining("User:\ninspect this") },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "user-image" },
      },
      { type: "text", text: expect.stringContaining("Tool result (toolu_image):") },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "tool-image" },
      },
      { type: "text", text: expect.stringContaining("Continue the conversation") },
    ]);
  });

  it("rejects retained image MIME types Claude cannot accept", () => {
    expect(() => encodePiMessages([
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: [{ type: "image", data: "svg", mimeType: "image/svg+xml" }] },
    ], crypto.randomUUID(), "/tmp/project")).toThrow(
      "Unsupported user message 1 image MIME type: image/svg+xml",
    );
  });

  it("still rejects unsupported retained roles", () => {
    expect(() => encodePiMessages([
      { role: "compactionSummary", summary: "summary" },
      { role: "unknown", content: "unknown" },
    ], crypto.randomUUID(), "/tmp/project")).toThrow("Unsupported Pi transcript role: unknown");
  });
});
