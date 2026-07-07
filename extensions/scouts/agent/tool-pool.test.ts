import { describe, expect, it } from "bun:test";

import { AGENT_TOOL_POOL, AGENT_TOOL_POOL_NAMES, resolveAgentToolPool } from "./tool-pool.ts";

describe("resolveAgentToolPool", () => {
  it("resolves canonical pool names case-insensitively", () => {
    const result = resolveAgentToolPool([
      "READ",
      "bash",
      "WEB_SEARCH",
      "web_fetch",
      "GITHUB_SEARCH",
      "GITHUB_GREP",
      "github_read_file",
      "github_list_dir",
      "github_find_files",
      "github_search_repos",
    ]);

    expect(result.toolNames).toEqual([
      "read",
      "bash",
      "web_search",
      "web_fetch",
      "github_search",
      "github_grep",
      "github_read_file",
      "github_list_dir",
      "github_find_files",
      "github_search_repos",
    ]);
    expect(result.tools.map((tool) => tool.name)).toEqual(result.toolNames);
    expect(result.warnings).toEqual([]);
  });

  it("normalizes Claude Code-style aliases and underlying custom tool names", () => {
    const result = resolveAgentToolPool([
      "Read",
      "Bash",
      "WebFetch",
      "WebSearch",
      "searchGitHub",
      "grepGitHub",
      "readRepoFile",
      "listRepoDirectory",
      "findRepoFiles",
      "searchRepos",
    ]);

    expect(result.toolNames).toEqual([
      "read",
      "bash",
      "web_fetch",
      "web_search",
      "github_search",
      "github_grep",
      "github_read_file",
      "github_list_dir",
      "github_find_files",
      "github_search_repos",
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("warns and ignores unknown names without aliasing Grep to bash", () => {
    const result = resolveAgentToolPool(["read", "Grep", "Nope"]);

    expect(result.toolNames).toEqual(["read"]);
    expect(result.warnings).toEqual([
      'Tool "Grep" is not in the scouts agent tool pool. Ignoring.',
      'Tool "Nope" is not in the scouts agent tool pool. Ignoring.',
    ]);
  });

  it("strips edit and write even when explicitly requested", () => {
    const result = resolveAgentToolPool(["Edit", "read", "Write", "write"]);

    expect(result.toolNames).toEqual(["read"]);
    expect(result.warnings).toEqual([
      'Tool "Edit" cannot be granted through the agent tool pool; use the mutation parameter to grant write access. Ignoring.',
      'Tool "Write" cannot be granted through the agent tool pool; use the mutation parameter to grant write access. Ignoring.',
      'Tool "write" cannot be granted through the agent tool pool; use the mutation parameter to grant write access. Ignoring.',
    ]);
  });

  it("exposes only the custom tools that exist in the scouts extension", () => {
    expect(AGENT_TOOL_POOL_NAMES).toEqual([
      "read",
      "bash",
      "github_search",
      "github_grep",
      "github_read_file",
      "github_list_dir",
      "github_find_files",
      "github_search_repos",
      "web_search",
      "web_fetch",
    ]);
  });

  it("maps canonical GitHub pool names to the librarian custom tool implementations", () => {
    const implementationNames = new Map(
      AGENT_TOOL_POOL.map((tool) => [tool.name, (tool.createTool("/tmp") as { name: string }).name]),
    );

    expect(implementationNames.get("github_search")).toBe("searchGitHub");
    expect(implementationNames.get("github_grep")).toBe("grepGitHub");
    expect(implementationNames.get("github_read_file")).toBe("readRepoFile");
    expect(implementationNames.get("github_list_dir")).toBe("listRepoDirectory");
    expect(implementationNames.get("github_find_files")).toBe("findRepoFiles");
    expect(implementationNames.get("github_search_repos")).toBe("searchRepos");
    expect(implementationNames.get("web_search")).toBe("webSearch");
    expect(implementationNames.get("web_fetch")).toBe("webFetch");
  });
});
