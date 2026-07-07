import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { loadScoutUserConfig, ScoutUserConfigError } from "./user-config.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-scout-config-test-"));
}

function writeConfig(path: string, content: string): void {
  mkdirSync(join(path, ".pi"), { recursive: true });
  writeFileSync(join(path, ".pi", "scouts.jsonc"), content, "utf8");
}

describe("loadScoutUserConfig", () => {
  it("loads JSONC comments and trailing commas", () => {
    const root = tempDir();
    writeConfig(root, `{
      // scout config
      "scouts": {
        "agent": {
          "models": [
            { "model": "anthropic/claude-opus-4-8", "thinkingLevel": "off" },
          ],
        },
      },
    }`);

    const config = loadScoutUserConfig(root, tempDir());

    expect(config.modelTargetsByScout.agent).toEqual([
      { model: "anthropic/claude-opus-4-8", thinkingLevel: "off" },
    ]);
  });

  it("applies global then shallowest-to-nearest project overrides scout-by-scout", () => {
    const home = tempDir();
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "scouts.jsonc"), JSON.stringify({
      scouts: {
        agent: { models: [{ model: "anthropic/global-agent", thinkingLevel: "high" }] },
        reviewer: { models: [{ model: "anthropic/global-reviewer", thinkingLevel: "low" }] },
      },
    }), "utf8");

    const root = tempDir();
    const child = join(root, "child");
    mkdirSync(child, { recursive: true });
    writeConfig(root, JSON.stringify({
      scouts: {
        agent: { models: [{ model: "anthropic/root-agent", thinkingLevel: "high" }] },
      },
    }));
    writeConfig(child, JSON.stringify({
      scouts: {
        agent: { models: [{ model: "anthropic/child-agent", thinkingLevel: "medium" }] },
      },
    }));

    const config = loadScoutUserConfig(child, home);

    expect(config.modelTargetsByScout.agent).toEqual([{ model: "anthropic/child-agent", thinkingLevel: "medium" }]);
    expect(config.modelTargetsByScout.reviewer).toEqual([{ model: "anthropic/global-reviewer", thinkingLevel: "low" }]);
  });

  it("rejects invalid config with a clear error", () => {
    const root = tempDir();
    writeConfig(root, JSON.stringify({
      scouts: {
        agent: { models: [{ model: "anthropic/claude-opus-4-8", thinkingLevel: "extreme" }] },
      },
    }));

    expect(() => loadScoutUserConfig(root, tempDir())).toThrow(ScoutUserConfigError);
    expect(() => loadScoutUserConfig(root, tempDir())).toThrow("Invalid thinkingLevel");
  });

  it("rejects unknown scout names and empty model arrays", () => {
    const unknown = tempDir();
    writeConfig(unknown, JSON.stringify({ scouts: { nope: { models: [{ model: "sonnet" }] } } }));
    expect(() => loadScoutUserConfig(unknown, tempDir())).toThrow('unknown scout "nope"');

    const empty = tempDir();
    writeConfig(empty, JSON.stringify({ scouts: { agent: { models: [] } } }));
    expect(() => loadScoutUserConfig(empty, tempDir())).toThrow("models must be a non-empty array");
  });
});
