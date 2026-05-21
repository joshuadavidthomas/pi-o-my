// Dedicated GitHub tools for the librarian scout.
//
// Purpose-built replacements for the bash+gh recipe approach.
// Each tool wraps `gh` CLI calls behind a clean interface so the
// small model never has to compose pipelines or remember API quirks.

import { execFile } from "node:child_process";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

// gh CLI helper

interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface GitHubSearchHit {
  path?: string;
  repository?: {
    nameWithOwner?: string;
    fullName?: string;
    name?: string;
  };
  textMatches?: Array<{ fragment?: string }>;
}

interface GitHubRepositorySearchResult {
  fullName?: string;
  description?: string;
  language?: string;
  stargazersCount?: number;
}

function execGh(
  args: string[],
  signal?: AbortSignal,
): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const child = execFile(
      "gh",
      args,
      { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(new Error("Aborted"));
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: error ? (error as NodeJS.ErrnoException).code ? Number((error as NodeJS.ErrnoException).code) || 1 : 1 : 0,
        });
      },
    );

    if (signal) {
      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => signal.removeEventListener("abort", onAbort));
    }
  });
}

function toolError(text: string): never {
  throw new Error(text);
}

function toolOk(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

// Resolve the default branch for a repo (cached per-repo within a session).
const branchCache = new Map<string, string>();

async function resolveRef(
  repo: string,
  ref: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (ref) return ref;

  const cached = branchCache.get(repo);
  if (cached) return cached;

  const result = await execGh(
    ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
    signal,
  );

  const branch = result.stdout.trim() || "main";
  branchCache.set(repo, branch);
  return branch;
}

// Normalize repo input: accept "owner/repo" or "https://github.com/owner/repo"
function normalizeRepo(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  const urlMatch = trimmed.match(/github\.com\/([^/]+\/[^/]+)/);
  if (urlMatch) return urlMatch[1];
  return trimmed;
}

// readGitHub

const readGitHubSchema = Type.Object({
  repository: Type.String({
    description: "Repository in owner/repo format (e.g. 'facebook/react').",
  }),
  path: Type.String({
    description: "Path to the file to read.",
  }),
  ref: Type.Optional(
    Type.String({
      description: "Branch, tag, or commit SHA. Defaults to the repo's default branch.",
    }),
  ),
  readRange: Type.Optional(
    Type.Array(Type.Number(), {
      minItems: 2,
      maxItems: 2,
      description: "Optional [startLine, endLine] to read only specific lines (1-indexed).",
    }),
  ),
});

export function createReadRepoFileTool(): AgentTool<typeof readGitHubSchema> {
  return {
    name: "readRepoFile",
    label: "readRepoFile",
    description:
      "Read the contents of a file from a GitHub repository. Returns file content with line numbers. Use readRange for specific lines of large files. Max file size ~1MB.",
    parameters: readGitHubSchema,

    async execute(_toolCallId, params, signal) {
      const repo = normalizeRepo(params.repository);
      const ref = await resolveRef(repo, params.ref, signal);

      const result = await execGh(
        [
          "api", `repos/${repo}/contents/${params.path}?ref=${ref}`,
          "--jq", '{content: .content, encoding: .encoding, size: .size}',
        ],
        signal,
      );

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (msg.includes("404") || msg.includes("Not Found")) {
          return toolError(`File not found: ${repo}/${params.path} (ref: ${ref})`);
        }
        return toolError(`Failed to read ${repo}/${params.path}: ${msg}`);
      }

      let parsed: { content?: string; encoding?: string; size?: number };
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return toolError(`Failed to parse API response for ${repo}/${params.path}`);
      }

      if (parsed.encoding !== "base64" || !parsed.content) {
        return toolError(
          `File too large for direct read (${repo}/${params.path}). ` +
            "Try reading a specific range or use searchGitHub to find relevant sections.",
        );
      }

      const contentB64 = parsed.content.replace(/\n/g, "");
      const decoded = Buffer.from(contentB64, "base64").toString("utf-8");
      const allLines = decoded.split("\n");
      const totalLines = allLines.length;

      let startLine = 1;
      let endLine = totalLines;

      if (params.readRange) {
        startLine = Math.max(1, params.readRange[0]);
        endLine = Math.min(totalLines, params.readRange[1]);
      }

      const sliced = allLines.slice(startLine - 1, endLine);
      const numbered = sliced
        .map((line, i) => `${startLine + i}\t${line}`)
        .join("\n");

      const rangeNote =
        params.readRange
          ? ` (showing lines ${startLine}-${endLine} of ${totalLines})`
          : ` (${totalLines} lines)`;

      const url = `https://github.com/${repo}/blob/${ref}/${params.path}`;
      const header = `${url}${rangeNote}`;

      return toolOk(`${header}\n\n${numbered}`, {
        repo,
        path: params.path,
        ref,
        totalLines,
        startLine,
        endLine,
      });
    },
  };
}

// searchGitHub

const searchGitHubSchema = Type.Object({
  pattern: Type.String({
    description:
      "Search pattern for code. Supports GitHub search operators (AND, OR, NOT) and qualifiers (language:, path:, extension:). Max 256 characters.",
  }),
  repository: Type.Optional(
    Type.String({
      description: "Scope search to a specific repository (owner/repo format).",
    }),
  ),
  path: Type.Optional(
    Type.String({
      description: "Limit search to a specific directory or path pattern.",
    }),
  ),
  language: Type.Optional(
    Type.String({
      description: "Filter by programming language (e.g. 'TypeScript', 'Python').",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default: 30, max: 100).",
      minimum: 1,
      maximum: 100,
    }),
  ),
});

export function createSearchGitHubTool(): AgentTool<typeof searchGitHubSchema> {
  return {
    name: "searchGitHub",
    label: "searchGitHub",
    description:
      "Search for code across GitHub repositories. Groups results by file with surrounding context and line numbers. Supports GitHub search operators (AND, OR, NOT) and qualifiers (language:, path:, extension:).",
    parameters: searchGitHubSchema,

    async execute(_toolCallId, params, signal) {
      const limit = params.limit ?? 30;

      let query = params.pattern;
      if (params.path) query += ` path:${params.path}`;
      if (params.language) query += ` language:${params.language}`;

      const args = [
        "search", "code", query,
        "--json", "path,repository,textMatches",
        "--limit", String(limit),
      ];

      if (params.repository) {
        args.push("--repo", normalizeRepo(params.repository));
      }

      const result = await execGh(args, signal);

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        return toolError(`Search failed: ${msg}`);
      }

      let hits: GitHubSearchHit[];
      try {
        hits = JSON.parse(result.stdout);
      } catch {
        return toolError(`Failed to parse search results: ${result.stdout.slice(0, 200)}`);
      }

      if (hits.length === 0) {
        return toolOk(`No results found for: ${params.pattern}`);
      }

      const sections: string[] = [];
      sections.push(`Found ${hits.length} result(s) for: ${params.pattern}\n`);

      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        const repoName = hit.repository?.nameWithOwner ?? hit.repository?.fullName ?? hit.repository?.name ?? "unknown";
        const filePath = hit.path ?? "unknown";

        const header = `[${i + 1}] ${repoName}:${filePath}`;

        const matches: string[] = [];
        if (Array.isArray(hit.textMatches)) {
          for (const tm of hit.textMatches) {
            if (tm.fragment) {
              matches.push(tm.fragment.trim());
            }
          }
        }

        if (matches.length > 0) {
          sections.push(`${header}\n${matches.join("\n...\n")}`);
        } else {
          sections.push(header);
        }
      }

      return toolOk(sections.join("\n\n"), { resultCount: hits.length });
    },
  };
}

// listDirectory

const listDirectorySchema = Type.Object({
  repository: Type.String({
    description: "Repository in owner/repo format.",
  }),
  path: Type.Optional(
    Type.String({
      description: "Path to directory. Defaults to repository root.",
    }),
  ),
  ref: Type.Optional(
    Type.String({
      description: "Branch, tag, or commit SHA. Defaults to the repo's default branch.",
    }),
  ),
});

export function createListRepoDirectoryTool(): AgentTool<typeof listDirectorySchema> {
  return {
    name: "listRepoDirectory",
    label: "listRepoDirectory",
    description:
      "List the contents of a directory in a GitHub repository. Returns files and directories (directories have trailing /).",
    parameters: listDirectorySchema,

    async execute(_toolCallId, params, signal) {
      const repo = normalizeRepo(params.repository);
      const ref = await resolveRef(repo, params.ref, signal);
      const dirPath = params.path || "";
      const apiPath = dirPath
        ? `repos/${repo}/contents/${dirPath}?ref=${ref}`
        : `repos/${repo}/contents?ref=${ref}`;

      const result = await execGh(
        ["api", apiPath, "--jq", '.[] | [.type, .name, .size] | @tsv'],
        signal,
      );

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (msg.includes("404")) {
          return toolError(`Directory not found: ${repo}/${dirPath} (ref: ${ref})`);
        }
        return toolError(`Failed to list directory: ${msg}`);
      }

      const entries = result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [type, name, size] = line.split("\t");
          if (type === "dir") return `${name}/`;
          const sizeKb = size ? ` (${formatSize(Number(size))})` : "";
          return `${name}${sizeKb}`;
        });

      const url = dirPath
        ? `https://github.com/${repo}/tree/${ref}/${dirPath}`
        : `https://github.com/${repo}/tree/${ref}`;

      const header = `${url} (${entries.length} entries)`;
      return toolOk(`${header}\n\n${entries.join("\n")}`, {
        repo,
        path: dirPath,
        ref,
        entryCount: entries.length,
      });
    },
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// globGitHub

const globGitHubSchema = Type.Object({
  repository: Type.String({
    description: "Repository in owner/repo format.",
  }),
  filePattern: Type.String({
    description:
      'Glob pattern to match files (e.g. "**/*.ts", "src/**/*.test.js", "*.config.*").',
  }),
  ref: Type.Optional(
    Type.String({
      description: "Branch, tag, or commit SHA. Defaults to the repo's default branch.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default: 100).",
      minimum: 1,
      maximum: 1000,
    }),
  ),
});

function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 3;
      } else {
        regex += ".*";
        i += 2;
      }
    } else if (ch === "*") {
      regex += "[^/]*";
      i++;
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(ch!)) {
      regex += "\\" + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }

  return new RegExp(`^${regex}$`);
}

export function createFindRepoFilesTool(): AgentTool<typeof globGitHubSchema> {
  return {
    name: "findRepoFiles",
    label: "findRepoFiles",
    description: "Find files matching a glob pattern in a GitHub repository.",
    parameters: globGitHubSchema,

    async execute(_toolCallId, params, signal) {
      const repo = normalizeRepo(params.repository);
      const ref = await resolveRef(repo, params.ref, signal);
      const limit = params.limit ?? 100;

      const result = await execGh(
        [
          "api",
          `repos/${repo}/git/trees/${ref}?recursive=1`,
          "--jq",
          '.tree[] | select(.type=="blob") | .path',
        ],
        signal,
      );

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        return toolError(`Failed to get file tree: ${msg}`);
      }

      const allPaths = result.stdout.trim().split("\n").filter(Boolean);
      const pattern = globToRegex(params.filePattern);
      const matches = allPaths.filter((p) => pattern.test(p));
      const truncated = matches.slice(0, limit);

      const header =
        matches.length > limit
          ? `Found ${matches.length} files matching "${params.filePattern}" (showing first ${limit})`
          : `Found ${matches.length} file(s) matching "${params.filePattern}"`;

      if (truncated.length === 0) {
        return toolOk(`No files matching "${params.filePattern}" in ${repo} (ref: ${ref}).`);
      }

      return toolOk(`${header}\n\n${truncated.join("\n")}`, {
        repo,
        ref,
        matchCount: matches.length,
        totalFiles: allPaths.length,
      });
    },
  };
}

// listRepositories

const listRepositoriesSchema = Type.Object({
  pattern: Type.Optional(
    Type.String({
      description: "Search pattern for repository names or descriptions.",
    }),
  ),
  organization: Type.Optional(
    Type.String({
      description: "Filter by organization or user (e.g. 'facebook', 'microsoft').",
    }),
  ),
  language: Type.Optional(
    Type.String({
      description: "Filter by primary language (e.g. 'TypeScript', 'Rust').",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default: 30, max: 100).",
      minimum: 1,
      maximum: 100,
    }),
  ),
});

export function createSearchReposTool(): AgentTool<typeof listRepositoriesSchema> {
  return {
    name: "searchRepos",
    label: "searchRepos",
    description:
      "Search for and list GitHub repositories. Useful for discovering repos by name, organization, or language.",
    parameters: listRepositoriesSchema,

    async execute(_toolCallId, params, signal) {
      const limit = params.limit ?? 30;

      const queryParts: string[] = [];
      if (params.pattern) queryParts.push(params.pattern);
      if (params.organization) queryParts.push(`org:${params.organization}`);
      if (params.language) queryParts.push(`language:${params.language}`);

      if (queryParts.length === 0) {
        return toolError(
          "Provide at least one of: pattern, organization, or language to search repositories.",
        );
      }

      const result = await execGh(
        [
          "search", "repos", queryParts.join(" "),
          "--json", "fullName,description,language,stargazersCount,updatedAt",
          "--limit", String(limit),
        ],
        signal,
      );

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        return toolError(`Repository search failed: ${msg}`);
      }

      let repos: GitHubRepositorySearchResult[];
      try {
        repos = JSON.parse(result.stdout);
      } catch {
        return toolError(`Failed to parse results: ${result.stdout.slice(0, 200)}`);
      }

      if (repos.length === 0) {
        return toolOk("No repositories found matching the criteria.");
      }

      const lines = repos.map((r) => {
        const stars = r.stargazersCount ? ` ⭐${r.stargazersCount}` : "";
        const lang = r.language ? ` [${r.language}]` : "";
        const desc = r.description ? ` — ${r.description}` : "";
        return `${r.fullName}${lang}${stars}${desc}`;
      });

      return toolOk(
        `Found ${repos.length} repository(ies)\n\n${lines.join("\n")}`,
        { resultCount: repos.length },
      );
    },
  };
}

// Factory to create all GitHub tools at once
export function createGitHubTools() {
  return [
    createReadRepoFileTool(),
    createSearchGitHubTool(),
    createListRepoDirectoryTool(),
    createFindRepoFilesTool(),
    createSearchReposTool(),
  ];
}
