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

  it("requires an explicit Pi compaction summary", () => {
    expect(() => encodePiMessages([
      { role: "user", content: "ordinary cold history" },
    ], crypto.randomUUID(), "/tmp/project")).toThrow("requires a Pi compaction summary");
  });

  it("fails rather than losing retained images or unsupported roles", () => {
    const id = crypto.randomUUID();
    expect(() => encodePiMessages([
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: [{ type: "image", data: "abc", mimeType: "image/png" }] },
    ], id, "/tmp/project")).toThrow("Unsupported user message 1 block: image");
    expect(() => encodePiMessages([
      { role: "compactionSummary", summary: "summary" },
      { role: "custom", content: "unknown" },
    ], id, "/tmp/project")).toThrow("Unsupported Pi transcript role: custom");
  });
});
