import { describe, expect, it } from "bun:test";

import type { Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { buildJudgeTranscript, isAutoEnabled, parseJudgeOutput, resolveJudgeModel } from "../extensions/dcg.ts";

const entry = (overrides: Partial<SessionEntry> & { type: SessionEntry["type"] }): SessionEntry =>
  ({ id: "e1", parentId: null, timestamp: "2025-01-01T00:00:00Z", ...overrides }) as SessionEntry;

describe("resolveJudgeModel", () => {
  const DCG_AUTO_MODEL = "DCG_AUTO_MODEL";
  const model = (provider: string, id: string) => ({ provider, id }) as unknown as Model<any>;
  const sessionModel = model("opencode-go", "session-model");
  const registry = (models: Array<{ provider: string; id: string }>) => ({
    find: (provider: string, modelId: string) =>
      models.find((m) => m.provider === provider && m.id === modelId),
  });

  it("uses the session model when nothing is set", () => {
    expect(resolveJudgeModel({ modelRegistry: registry([]), model: sessionModel }, null)).toBe(sessionModel);
  });

  it("prefers a stored override over the session model", () => {
    const overrideModel = model("anthropic", "claude-haiku-4-5");
    const ctx = { modelRegistry: registry([overrideModel]), model: sessionModel };
    expect(resolveJudgeModel(ctx, { provider: "anthropic", modelId: "claude-haiku-4-5" })).toBe(overrideModel);
  });

  it("prefers DCG_AUTO_MODEL over a stored override", () => {
    process.env[DCG_AUTO_MODEL] = "anthropic/claude-sonnet-5";
    try {
      const envModel = model("anthropic", "claude-sonnet-5");
      const overrideModel = model("anthropic", "claude-haiku-4-5");
      const ctx = { modelRegistry: registry([envModel, overrideModel]), model: sessionModel };
      expect(resolveJudgeModel(ctx, { provider: "anthropic", modelId: "claude-haiku-4-5" })).toBe(envModel);
    } finally {
      delete process.env[DCG_AUTO_MODEL];
    }
  });

  it("falls back to the session model when the override is unknown", () => {
    const ctx = { modelRegistry: registry([]), model: sessionModel };
    expect(resolveJudgeModel(ctx, { provider: "nope", modelId: "nope" })).toBe(sessionModel);
  });

  it("ignores a malformed DCG_AUTO_MODEL value", () => {
    process.env[DCG_AUTO_MODEL] = "no-slash-here";
    try {
      expect(resolveJudgeModel({ modelRegistry: registry([]), model: sessionModel }, null)).toBe(sessionModel);
    } finally {
      delete process.env[DCG_AUTO_MODEL];
    }
  });
});

describe("isAutoEnabled", () => {
  it("is on by default", () => {
    expect(isAutoEnabled(undefined, undefined)).toBe(true);
  });

  it("turns off with the --no-dcg-auto flag", () => {
    expect(isAutoEnabled(true, undefined)).toBe(false);
  });

  it("turns off with a falsy DCG_AUTO value", () => {
    for (const value of ["0", "false", "no", "off"]) {
      expect(isAutoEnabled(undefined, value)).toBe(false);
    }
  });

  it("stays on for empty or truthy env values", () => {
    for (const value of [undefined, "", "1", "true", "yes", "on"]) {
      expect(isAutoEnabled(undefined, value)).toBe(true);
    }
  });
});

describe("parseJudgeOutput", () => {
  it("parses a clean JSON verdict", () => {
    expect(parseJudgeOutput('{"verdict": "allow", "reason": "Matches intent"}')).toEqual({
      verdict: "allow",
      reason: "Matches intent",
    });
  });

  it("parses JSON wrapped in prose or fences", () => {
    expect(parseJudgeOutput('Here is my call: {"verdict": "deny", "reason": "No intent"} trailing')).toEqual({
      verdict: "deny",
      reason: "No intent",
    });
    expect(parseJudgeOutput('```json\n{"verdict": "ask", "reason": "Unclear"}\n```')).toEqual({
      verdict: "ask",
      reason: "Unclear",
    });
  });

  it("rejects invalid verdicts", () => {
    expect(parseJudgeOutput('{"verdict": "maybe", "reason": "x"}')).toBeNull();
  });

  it("rejects non-JSON output", () => {
    expect(parseJudgeOutput("I think this is fine, run it")).toBeNull();
    expect(parseJudgeOutput("")).toBeNull();
  });

  it("accepts a missing reason as empty", () => {
    expect(parseJudgeOutput('{"verdict": "allow"}')).toEqual({ verdict: "allow", reason: "" });
  });
});

describe("buildJudgeTranscript", () => {
  it("includes user and assistant turns in order", () => {
    const entries = [
      entry({ type: "message", message: { role: "user", content: "fix the bug", timestamp: 1 } }),
      entry({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            { type: "text", text: "I'll fix it now" },
          ],
          timestamp: 2,
        },
      }),
    ];
    const transcript = buildJudgeTranscript(entries);
    expect(transcript).toContain("[user] fix the bug");
    expect(transcript).toContain("[assistant] I'll fix it now");
    expect(transcript).not.toContain("private reasoning");
  });

  it("skips tool results and bash executions", () => {
    const entries = [
      entry({
        type: "message",
        message: { role: "toolResult", toolCallId: "t1", toolName: "Bash", content: [{ type: "text", text: "rm -rf output" }], isError: false, timestamp: 1 },
      }),
      entry({ type: "message", message: { role: "user", content: "clean up", timestamp: 2 } }),
    ];
    const transcript = buildJudgeTranscript(entries);
    expect(transcript).toBe("[user] clean up");
  });

  it("includes compaction summaries as context", () => {
    const entries = [
      entry({ type: "compaction", summary: "Earlier: user asked to refactor auth", firstKeptEntryId: "e2", tokensBefore: 500 }),
    ];
    const transcript = buildJudgeTranscript(entries);
    expect(transcript).toContain("[compacted history] Earlier: user asked to refactor auth");
  });

  it("keeps only the most recent entries", () => {
    const entries = Array.from({ length: 60 }, (_, i) =>
      entry({
        id: `e${i}`,
        type: "message",
        message: { role: "user", content: `message ${i}`, timestamp: i },
      }),
    );
    const transcript = buildJudgeTranscript(entries);
    expect(transcript).not.toContain("message 0");
    expect(transcript).toContain("message 59");
  });

  it("returns an empty string when nothing qualifies", () => {
    expect(buildJudgeTranscript([])).toBe("");
  });
});
