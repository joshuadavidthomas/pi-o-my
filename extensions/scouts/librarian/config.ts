import { Type } from "typebox";

import type { ScoutConfig } from "../types.ts";
import { ModelParam } from "../validate.ts";
import { buildLibrarianSystemPrompt, buildLibrarianUserPrompt } from "./prompt.ts";
import { createGrepGitHubTool } from "./tools/grep-app.ts";
import { createGitHubTools } from "./tools/github.ts";
import { createWebSearchTool, createWebFetchTool } from "./tools/web.ts";

const DEFAULT_MAX_SEARCH_RESULTS = 30;

export const LibrarianParams = Type.Object({
  query: Type.String({
    description: [
      "Write a complete research brief for the Librarian subagent — not just search keywords.",
      "Include the question to answer, relevant context, constraints, known repos/docs/URLs, what evidence is needed, and what final answer would be useful.",
      "Mention any useful search terms as part of the brief, but do not reduce the prompt to search terms.",
      "Include repo/owner hints for GitHub, specific URLs, or relevant technologies when known.",
      "Do not guess unknown details; if scope is uncertain, say that explicitly and let Librarian discover it.",
      "The librarian returns concise findings with citations and evidence.",
      "Good: Research how SvelteKit remote functions handle form validation errors. Focus on current docs and examples. Return the relevant APIs, constraints, and citations.",
      "Bad: sveltekit remote functions validation",
    ].join("\n"),
  }),
  repos: Type.Optional(
    Type.Array(Type.String({ description: "Optional owner/repo filters (e.g. octocat/hello-world)" }), {
      description: "Optional explicit repository scope.",
      maxItems: 30,
    }),
  ),
  owners: Type.Optional(
    Type.Array(Type.String({ description: "Optional owner/org filters" }), {
      description: "Optional owner/org scope.",
      maxItems: 30,
    }),
  ),
  maxSearchResults: Type.Optional(
    Type.Number({
      description: `Maximum GitHub search hits per query (1-100, default ${DEFAULT_MAX_SEARCH_RESULTS})`,
      minimum: 1,
      maximum: 100,
      default: DEFAULT_MAX_SEARCH_RESULTS,
    }),
  ),
  model: ModelParam,
});

export const LIBRARIAN_CONFIG: ScoutConfig = {
  name: "librarian",
  maxTurns: 12,
  workload: "balanced",
  buildSystemPrompt: buildLibrarianSystemPrompt,
  buildUserPrompt: buildLibrarianUserPrompt,
  createTools: (_cwd) => [
    createGrepGitHubTool(),
    ...createGitHubTools(),
    createWebSearchTool(),
    createWebFetchTool(),
  ],
};
