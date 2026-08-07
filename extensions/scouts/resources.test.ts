import { describe, expect, it } from "bun:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

import { createScoutResourceLoader, resolveClaudeAgentSdkExtensionPath } from "./resources.ts";

describe("Claude Agent SDK scout resources", () => {
  it("resolves the provider beside the scouts package", () => {
    const extensionPath = resolveClaudeAgentSdkExtensionPath();
    expect(extensionPath).toBeDefined();
    expect(extensionPath!).toEndWith("/extensions/custom-provider-claude-agent-sdk");
  });

  it("loads the provider extension for Claude Agent SDK scouts", async () => {
    const extensionPath = resolveClaudeAgentSdkExtensionPath();
    expect(extensionPath).toBeDefined();

    const resourceLoader = await createScoutResourceLoader({
      // Package loading must not depend on the project cwd containing the
      // sibling extension tree.
      cwd: "/tmp",
      allowExtensions: true,
    });
    expect(resourceLoader).toBeInstanceOf(DefaultResourceLoader);

    const expectProviderLoaded = () => {
      const extensions = resourceLoader.getExtensions();
      expect(extensions.errors).toEqual([]);
      expect(extensions.extensions.some((extension) => extension.path.startsWith(extensionPath!))).toBe(true);
      expect(extensions.runtime.pendingProviderRegistrations.map(({ name }) => name)).toContain(
        "claude-agent-sdk",
      );
    };

    expectProviderLoaded();
    await resourceLoader.reload();
    expectProviderLoaded();
  });

  it("does not load extensions for ordinary scouts", async () => {
    const resourceLoader = await createScoutResourceLoader({ cwd: "/tmp" });

    expect(resourceLoader).toBeInstanceOf(DefaultResourceLoader);
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    expect(resourceLoader.getExtensions().extensions).toEqual([]);
  });
});
