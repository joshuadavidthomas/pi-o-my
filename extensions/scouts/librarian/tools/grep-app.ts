// grep.app search tool for the librarian scout.
//
// Calls the grep.app REST API (https://grep.app/api/search) directly —
// no MCP, no mcporter. Returns clean text with line numbers and facets.

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const GREP_APP_API = "https://grep.app/api/search";

const searchCodeSchema = Type.Object({
  query: Type.String({
    description:
      "Literal code pattern to search for (like grep). Use actual code that would appear in files, not keywords. Supports regex when useRegexp is true.",
  }),
  language: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Filter by programming language. Examples: ['TypeScript'], ['Python'], ['Rust', 'C++'].",
    }),
  ),
  repo: Type.Optional(
    Type.String({
      description:
        "Filter by repository (partial match). Examples: 'facebook/react', 'vercel/' (matches org).",
    }),
  ),
  path: Type.Optional(
    Type.String({
      description:
        "Filter by file path (partial match). Examples: 'src/components/', '.config.ts'.",
    }),
  ),
  matchCase: Type.Optional(
    Type.Boolean({ description: "Case-sensitive search. Default: false." }),
  ),
  useRegexp: Type.Optional(
    Type.Boolean({
      description:
        "Interpret query as a regular expression. Prefix with (?s) for multi-line. Default: false.",
    }),
  ),
  matchWholeWords: Type.Optional(
    Type.Boolean({ description: "Match whole words only. Default: false." }),
  ),
});

export type SearchCodeInput = Static<typeof searchCodeSchema>;

interface GrepAppHit {
  repo: string;
  branch: string;
  path: string;
  content: { snippet: string };
  total_matches: string;
}

interface GrepAppFacetBucket {
  val: string;
  count: number;
}

interface GrepAppResponse {
  time: number;
  facets: {
    repo: { buckets: GrepAppFacetBucket[] };
    lang: { buckets: GrepAppFacetBucket[] };
    path: { buckets: GrepAppFacetBucket[] };
  };
  hits: {
    total: number;
    hits: GrepAppHit[];
  };
}

// Strip HTML from grep.app snippets to produce clean, line-numbered text.
function stripSnippetHtml(html: string): string {
  const lines: string[] = [];
  const rowRe = /<tr[^>]*data-line="(\d+)"[^>]*>[\s\S]*?<\/tr>/g;
  let match: RegExpExecArray | null;

  while ((match = rowRe.exec(html)) !== null) {
    const lineNo = match[1];
    let rowHtml = match[0];

    rowHtml = rowHtml.replace(/<td><div class="lineno">\d+<\/div><\/td>/, "");
    rowHtml = rowHtml.replace(/<div class="jump"><\/div>/g, "");

    let code = rowHtml.replace(/<[^>]+>/g, "");

    code = code
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, " ");

    code = code.replace(/\s+$/, "");

    if (code || lineNo) {
      lines.push(`${lineNo}\t${code}`);
    }
  }

  if (lines.length === 0) {
    let plain = html.replace(/<[^>]+>/g, "");
    plain = plain
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ");
    return plain.trim();
  }

  return lines.join("\n");
}

function buildUrl(params: SearchCodeInput): string {
  const url = new URL(GREP_APP_API);
  url.searchParams.set("q", params.query);

  if (params.matchCase) url.searchParams.set("case", "true");
  if (params.useRegexp) url.searchParams.set("regexp", "true");
  if (params.matchWholeWords) url.searchParams.set("words", "true");
  if (params.repo) url.searchParams.set("filter[repo]", params.repo);
  if (params.path) url.searchParams.set("filter[path]", params.path);

  if (params.language && params.language.length > 0) {
    for (let i = 0; i < params.language.length; i++) {
      url.searchParams.set(`filter[lang][${i}]`, params.language[i]);
    }
  }

  return url.toString();
}

function formatFacets(facets: GrepAppResponse["facets"]): string {
  const parts: string[] = [];

  if (facets.repo?.buckets?.length > 0) {
    const repos = facets.repo.buckets
      .slice(0, 8)
      .map((b) => `${b.val} (${b.count})`)
      .join(", ");
    parts.push(`Repos: ${repos}`);
  }

  if (facets.lang?.buckets?.length > 0) {
    const langs = facets.lang.buckets
      .slice(0, 8)
      .map((b) => `${b.val} (${b.count})`)
      .join(", ");
    parts.push(`Languages: ${langs}`);
  }

  if (facets.path?.buckets?.length > 0) {
    const paths = facets.path.buckets
      .slice(0, 6)
      .map((b) => `${b.val} (${b.count})`)
      .join(", ");
    parts.push(`Paths: ${paths}`);
  }

  return parts.join("\n");
}

function formatResults(data: GrepAppResponse): string {
  const sections: string[] = [];

  sections.push(
    `Found ${data.hits.total} results in ${data.time}ms`,
  );

  const facets = formatFacets(data.facets);
  if (facets) sections.push(facets);

  const hits = data.hits.hits;
  if (hits.length === 0) {
    sections.push("No matching code found.");
    return sections.join("\n\n");
  }

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const header = `[${i + 1}] ${hit.repo}:${hit.path} (branch: ${hit.branch}, matches: ${hit.total_matches})`;
    const snippet = stripSnippetHtml(hit.content.snippet);
    sections.push(`${header}\n${snippet}`);
  }

  return sections.join("\n\n");
}

export interface SearchCodeDetails {
  totalHits: number;
  responseTimeMs: number;
  hitsReturned: number;
}

export function createGrepGitHubTool(): AgentTool<typeof searchCodeSchema, SearchCodeDetails> {
  return {
    name: "grepGitHub",
    label: "grepGitHub",
    description: [
      "Search for literal code patterns across public GitHub repositories using grep.app.",
      "This is a fast discovery tool — like running grep/rg across all of GitHub.",
      "Use it to find real-world usage examples, API patterns, and implementations.",
      "",
      "IMPORTANT: Search for actual code patterns (like grep), not natural language:",
      '  ✅ Good: "createAgentSession(", "impl Display for", "#[derive(Serialize"',
      '  ❌ Bad: "how to create sessions", "best practices"',
      "",
      "Results are leads for discovery. To cite code, read the actual file with readRepoFile.",
    ].join("\n"),
    parameters: searchCodeSchema,

    execute: async (_toolCallId, params, signal) => {
      const url = buildUrl(params);

      try {
        const response = await fetch(url, {
          signal,
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`grep.app returned HTTP ${response.status}: ${body.slice(0, 200)}`);
        }

        const data = (await response.json()) as GrepAppResponse;
        const text = formatResults(data);

        return {
          content: [{ type: "text", text }],
          details: {
            totalHits: data.hits.total,
            responseTimeMs: data.time,
            hitsReturned: data.hits.hits.length,
          },
        };
      } catch (error) {
        if (signal?.aborted) {
          throw new Error("Search aborted.");
        }

        const message =
          error instanceof Error ? error.message : String(error);
        throw new Error(`grep.app search failed: ${message}`);
      }
    },
  };
}
