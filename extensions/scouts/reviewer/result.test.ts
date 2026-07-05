import { describe, expect, it } from "bun:test";

import type { ScoutDetails } from "../types.ts";
import { hasResultText, resultText } from "./result.ts";

function result(contentText: string | undefined, summaryText: string | undefined, status: ScoutDetails["status"] = "done") {
  return {
    content: contentText === undefined ? [] : [{ type: "text" as const, text: contentText }],
    details: {
      mode: "single" as const,
      status,
      runs: [{
        runId: "rev-test",
        status,
        query: "review",
        turns: 1,
        displayItems: [],
        summaryText,
        startedAt: 1,
        endedAt: status === "running" ? undefined : 2,
      }],
    },
    isError: status === "error",
  };
}

describe("reviewer result text", () => {
  it("uses summary text when content has no usable text", () => {
    const value = result(undefined, "summary answer");

    expect(hasResultText(value)).toBe(true);
    expect(resultText(value)).toBe("summary answer");
  });

  it("prefers primary content when both content and summary are present", () => {
    const value = result("content answer", "summary answer");

    expect(resultText(value)).toBe("content answer");
  });

  it("does not treat running placeholder text as a final result", () => {
    const value = result("(searching...)", "partial", "running");

    expect(hasResultText(value)).toBe(false);
    expect(resultText(value)).toContain("status=running");
  });
});
