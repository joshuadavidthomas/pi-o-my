import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";

import { createGrepGitHubTool } from "../librarian/tools/grep-app.ts";
import {
  createFindRepoFilesTool,
  createListRepoDirectoryTool,
  createReadRepoFileTool,
  createSearchGitHubTool,
  createSearchReposTool,
} from "../librarian/tools/github.ts";
import { createWebFetchTool, createWebSearchTool } from "../librarian/tools/web.ts";
import { createReadOnlyBashTool } from "../tools/read-only-bash.ts";

export type AgentToolPoolName =
  | "read"
  | "bash"
  | "github_search"
  | "github_grep"
  | "github_read_file"
  | "github_list_dir"
  | "github_find_files"
  | "github_search_repos"
  | "web_search"
  | "web_fetch";

export interface AgentToolPoolMember {
  name: AgentToolPoolName;
  kind: "builtin" | "custom";
  createTool: (cwd: string, ctx?: ExtensionContext) => unknown;
}

export interface AgentToolPoolResolution {
  toolNames: AgentToolPoolName[];
  tools: AgentToolPoolMember[];
  warnings: string[];
}

export const AGENT_BASE_TOOL_POOL_NAMES = ["read", "bash"] as const satisfies readonly AgentToolPoolName[];

export const AGENT_TOOL_POOL = [
  {
    name: "read",
    kind: "builtin",
    createTool: (cwd: string) => createReadTool(cwd),
  },
  {
    name: "bash",
    kind: "custom",
    createTool: (cwd: string) => createReadOnlyBashTool(cwd),
  },
  {
    name: "github_search",
    kind: "custom",
    createTool: () => createSearchGitHubTool(),
  },
  {
    name: "github_grep",
    kind: "custom",
    createTool: () => createGrepGitHubTool(),
  },
  {
    name: "github_read_file",
    kind: "custom",
    createTool: () => createReadRepoFileTool(),
  },
  {
    name: "github_list_dir",
    kind: "custom",
    createTool: () => createListRepoDirectoryTool(),
  },
  {
    name: "github_find_files",
    kind: "custom",
    createTool: () => createFindRepoFilesTool(),
  },
  {
    name: "github_search_repos",
    kind: "custom",
    createTool: () => createSearchReposTool(),
  },
  {
    name: "web_search",
    kind: "custom",
    createTool: () => createWebSearchTool(),
  },
  {
    name: "web_fetch",
    kind: "custom",
    createTool: () => createWebFetchTool(),
  },
] as const satisfies readonly AgentToolPoolMember[];

export const AGENT_TOOL_POOL_NAMES = AGENT_TOOL_POOL.map((tool) => tool.name) as AgentToolPoolName[];

const TOOL_POOL_BY_NAME = new Map<AgentToolPoolName, AgentToolPoolMember>(
  AGENT_TOOL_POOL.map((tool) => [tool.name, tool]),
);

const TOOL_ALIASES: Record<string, AgentToolPoolName> = {
  read: "read",
  bash: "bash",
  grepgithub: "github_grep",
  findrepofiles: "github_find_files",
  listrepodirectory: "github_list_dir",
  readrepofile: "github_read_file",
  searchgithub: "github_search",
  searchrepos: "github_search_repos",
  webfetch: "web_fetch",
  websearch: "web_search",
};

const MUTATING_TOOL_NAMES = new Set(["edit", "write"]);

function normalizeToolName(input: string): AgentToolPoolName | undefined {
  const lower = input.toLowerCase();
  return TOOL_ALIASES[lower] ?? (TOOL_POOL_BY_NAME.has(lower as AgentToolPoolName) ? lower as AgentToolPoolName : undefined);
}

export function resolveAgentToolPool(requestedToolNames: readonly string[]): AgentToolPoolResolution {
  const toolNames: AgentToolPoolName[] = [];
  const warnings: string[] = [];

  for (const rawName of requestedToolNames) {
    const requested = rawName.trim();
    if (!requested) continue;

    const lower = requested.toLowerCase();
    if (MUTATING_TOOL_NAMES.has(lower)) {
      warnings.push(`Tool "${requested}" cannot be granted through the agent tool pool; use the mutation parameter to grant write access. Ignoring.`);
      continue;
    }

    const normalized = normalizeToolName(requested);
    if (!normalized) {
      warnings.push(`Tool "${requested}" is not in the scouts agent tool pool. Ignoring.`);
      continue;
    }

    if (!toolNames.includes(normalized)) toolNames.push(normalized);
  }

  return {
    toolNames,
    tools: toolNames.map((name) => TOOL_POOL_BY_NAME.get(name)!),
    warnings,
  };
}
