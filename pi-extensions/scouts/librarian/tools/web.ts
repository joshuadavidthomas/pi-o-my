// Web search and content extraction tools for the librarian scout.
//
// webSearch supports multiple backends with lightweight caching and
// rate-limit-aware fallback:
// - Brave Search (`BRAVE_API_KEY`)
// - Exa Search (`EXA_API_KEY`)
// - Firecrawl Search (`FIRECRAWL_API_KEY`)
//
// webFetch implements content extraction inline using Readability + Turndown
// (no search API key needed).

import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
// @ts-ignore — turndown-plugin-gfm has no type declarations
import { gfm } from "turndown-plugin-gfm";
import { Type } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

type SearchBackend = "brave" | "exa" | "firecrawl";
type WebFetchBackend = "jina" | "direct";
type WebFetchBackendChoice = WebFetchBackend | "auto";

type WebSearchParams = {
  query: string;
  numResults?: number;
  content?: boolean;
  freshness?: string;
  country?: string;
};

type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
  age?: string;
  content?: string;
};

type CachedSearchResult = {
  text: string;
  expiresAt: number;
};

class SearchBackendError extends Error {
  constructor(
    message: string,
    readonly backend: SearchBackend,
    readonly rateLimited = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const SEARCH_CACHE_TTL_MS = 5 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const TRANSIENT_RETRY_DELAYS_MS = [500, 1500];

const searchCache = new Map<string, CachedSearchResult>();
const backendCooldownUntil = new Map<SearchBackend, number>();

function toolError(text: string): never {
  throw new Error(text);
}

function toolOk(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}

function cleanupExpiredSearchCache(): void {
  const now = Date.now();
  for (const [key, entry] of searchCache) {
    if (entry.expiresAt <= now) searchCache.delete(key);
  }
}

function getSearchCacheKey(params: WebSearchParams): string {
  return JSON.stringify({
    query: params.query,
    numResults: params.numResults ?? 5,
    content: params.content ?? false,
    freshness: params.freshness ?? "",
    country: params.country ?? "US",
  });
}

function getConfiguredBackends(): SearchBackend[] {
  const raw = process.env.PI_LIBRARIAN_WEB_SEARCH_BACKENDS?.trim();
  const requested = raw
    ? raw.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)
    : ["brave", "exa", "firecrawl"];

  const unique: SearchBackend[] = [];
  for (const candidate of requested) {
    if (candidate !== "brave" && candidate !== "exa" && candidate !== "firecrawl") continue;
    if (unique.includes(candidate)) continue;
    unique.push(candidate);
  }

  return unique.filter((backend) => {
    switch (backend) {
      case "brave":
        return !!process.env.BRAVE_API_KEY;
      case "exa":
        return !!process.env.EXA_API_KEY;
      case "firecrawl":
        return !!process.env.FIRECRAWL_API_KEY;
    }
  });
}

function backendIsCoolingDown(backend: SearchBackend): boolean {
  const until = backendCooldownUntil.get(backend);
  return until !== undefined && until > Date.now();
}

function setBackendCooldown(backend: SearchBackend, retryAfterMs?: number): void {
  backendCooldownUntil.set(backend, Date.now() + Math.max(retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS, 1_000));
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("Aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function normalizeSearchOutput(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";

  return results.map((result, index) => {
    const parts = [
      `--- Result ${index + 1} ---`,
      `Title: ${result.title}`,
      `Link: ${result.url}`,
    ];

    if (result.age) parts.push(`Age: ${result.age}`);
    if (result.snippet) parts.push(`Snippet: ${result.snippet}`);
    if (result.content) parts.push(`Content:\n${result.content}`);

    return parts.join("\n");
  }).join("\n\n");
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function extractRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(seconds * 1000, 1000);

  const timestamp = Date.parse(raw);
  if (!Number.isNaN(timestamp)) return Math.max(timestamp - Date.now(), 1000);
  return undefined;
}

async function fetchJson(url: string, init: RequestInit, backend: SearchBackend, signal?: AbortSignal): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(20_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { ...init, signal: combinedSignal });

    if (response.ok) {
      return await response.json();
    }

    const body = await response.text().catch(() => "");
    const message = `HTTP ${response.status}: ${response.statusText}${body ? `\n${body}` : ""}`;

    if (response.status === 429) {
      throw new SearchBackendError(message, backend, true, extractRetryAfterMs(response));
    }

    const isTransient = response.status >= 500 || response.status === 408;
    if (isTransient && attempt < TRANSIENT_RETRY_DELAYS_MS.length) {
      await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]!, signal);
      continue;
    }

    throw new SearchBackendError(message, backend);
  }
}

// JSDOM's CSS parser can't handle modern CSS and spams "Could not parse CSS
// stylesheet" to the console. Silence those warnings with a virtual console.
function quietConsole(): VirtualConsole {
  const vc = new VirtualConsole();
  vc.on("error", () => {});
  vc.on("warn", () => {});
  vc.on("info", () => {});
  vc.on("dir", () => {});
  return vc;
}

// Convert HTML to clean markdown using Turndown with GFM support
function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  turndown.use(gfm);
  turndown.addRule("removeEmptyLinks", {
    filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
    replacement: () => "",
  });
  return turndown
    .turndown(html)
    .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
    .replace(/ +/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Fetch a URL directly and extract readable content as markdown
async function fetchDirectWebContent(
  url: string,
  signal?: AbortSignal,
): Promise<{ title?: string; content: string }> {
  const timeoutSignal = AbortSignal.timeout(15_000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: combinedSignal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();

  const virtualConsole = quietConsole();
  const dom = new JSDOM(html, { url, virtualConsole });
  const article = new Readability(dom.window.document).parse();

  if (article?.content) {
    return {
      title: article.title || undefined,
      content: htmlToMarkdown(article.content),
    };
  }

  const fallbackDom = new JSDOM(html, { url, virtualConsole });
  const doc = fallbackDom.window.document;
  doc
    .querySelectorAll("script, style, noscript, nav, header, footer, aside")
    .forEach((el) => el.remove());

  const title = doc.querySelector("title")?.textContent?.trim();
  const main =
    doc.querySelector("main, article, [role='main'], .content, #content") ||
    doc.body;
  const mainHtml = main?.innerHTML || "";

  if (mainHtml.trim().length > 100) {
    return {
      title: title || undefined,
      content: htmlToMarkdown(mainHtml),
    };
  }

  throw new Error("Could not extract readable content from this page.");
}

function getWebFetchBackends(choice: WebFetchBackendChoice = "auto"): WebFetchBackend[] {
  if (choice === "jina") return ["jina"];
  if (choice === "direct") return ["direct"];
  return ["jina", "direct"];
}

function toJinaReaderUrl(url: string): string {
  if (url.startsWith("https://r.jina.ai/http://") || url.startsWith("http://r.jina.ai/http://")) return url;
  return `https://r.jina.ai/http://${url}`;
}

async function fetchJinaWebContent(url: string, signal?: AbortSignal): Promise<{ content: string }> {
  const timeoutSignal = AbortSignal.timeout(20_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(toJinaReaderUrl(url), { signal: combinedSignal });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return { content: await response.text() };
}

async function fetchWebContent(
  url: string,
  backend: WebFetchBackendChoice = "auto",
  signal?: AbortSignal,
): Promise<{ title?: string; content: string; backend: WebFetchBackend }> {
  const failures: string[] = [];
  const backends = getWebFetchBackends(backend);
  if (backends.length === 0) throw new Error("No web fetch backend is configured.");

  for (const candidate of backends) {
    try {
      const result = candidate === "jina"
        ? await fetchJinaWebContent(url, signal)
        : await fetchDirectWebContent(url, signal);
      return { ...result, backend: candidate };
    } catch (error) {
      if (signal?.aborted) throw new Error("Aborted");
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Web fetch failed across configured backends. ${failures.join(" | ")}`);
}

async function searchWithBrave(params: WebSearchParams, signal?: AbortSignal): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new SearchBackendError("BRAVE_API_KEY is not set.", "brave");

  const queryParams = new URLSearchParams({
    q: params.query,
    count: String(Math.min(params.numResults ?? 5, 20)),
    country: (params.country ?? "US").toUpperCase(),
  });
  if (params.freshness) queryParams.set("freshness", params.freshness);

  const data = await fetchJson(
    `https://api.search.brave.com/res/v1/web/search?${queryParams.toString()}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    },
    "brave",
    signal,
  ) as { web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string; page_age?: string }> } };

  const rawResults = data.web?.results ?? [];
  const results: SearchResult[] = [];
  for (const raw of rawResults.slice(0, params.numResults ?? 5)) {
    const url = raw.url?.trim();
    if (!url) continue;

    const result: SearchResult = {
      title: raw.title?.trim() || url,
      url,
      snippet: raw.description?.trim(),
      age: raw.age?.trim() || raw.page_age?.trim(),
    };

    if (params.content) {
      try {
        const fetched = await fetchWebContent(url, "auto", signal);
        result.content = truncateText(fetched.content, 5000);
      } catch (error) {
        result.content = `(Error: ${error instanceof Error ? error.message : String(error)})`;
      }
    }

    results.push(result);
  }
  return results;
}

async function searchWithExa(params: WebSearchParams, signal?: AbortSignal): Promise<SearchResult[]> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new SearchBackendError("EXA_API_KEY is not set.", "exa");

  const data = await fetchJson(
    "https://api.exa.ai/search",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query: params.query,
        type: "auto",
        numResults: Math.min(params.numResults ?? 5, 20),
        contents: {
          text: params.content
            ? { maxCharacters: 5000 }
            : { maxCharacters: 1000 },
        },
      }),
    },
    "exa",
    signal,
  ) as { results?: Array<{ title?: string; url?: string; text?: string }> };

  return (data.results ?? []).map((result) => ({
    title: result.title?.trim() || result.url?.trim() || "(untitled)",
    url: result.url?.trim() || "",
    snippet: params.content ? undefined : result.text ? truncateText(result.text.trim(), 300) : undefined,
    content: params.content && result.text ? truncateText(result.text.trim(), 5000) : undefined,
  })).filter((result) => result.url);
}

async function searchWithFirecrawl(params: WebSearchParams, signal?: AbortSignal): Promise<SearchResult[]> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new SearchBackendError("FIRECRAWL_API_KEY is not set.", "firecrawl");

  const body: Record<string, unknown> = {
    query: params.query,
    limit: Math.min(params.numResults ?? 5, 20),
  };
  if (params.content) {
    body.scrapeOptions = { formats: ["markdown"] };
  }

  const data = await fetchJson(
    "https://api.firecrawl.dev/v2/search",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    "firecrawl",
    signal,
  ) as {
    data?: {
      web?: Array<{ title?: string; url?: string; description?: string; markdown?: string }>;
    };
  };

  return (data.data?.web ?? []).map((result) => ({
    title: result.title?.trim() || result.url?.trim() || "(untitled)",
    url: result.url?.trim() || "",
    snippet: result.description?.trim(),
    content: params.content && result.markdown ? truncateText(result.markdown.trim(), 5000) : undefined,
  })).filter((result) => result.url);
}

async function searchWithBackend(
  backend: SearchBackend,
  params: WebSearchParams,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  switch (backend) {
    case "brave":
      return searchWithBrave(params, signal);
    case "exa":
      return searchWithExa(params, signal);
    case "firecrawl":
      return searchWithFirecrawl(params, signal);
  }
}

async function executeWebSearch(params: WebSearchParams, signal?: AbortSignal): Promise<string> {
  cleanupExpiredSearchCache();

  const cacheKey = getSearchCacheKey(params);
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.text;

  const backends = getConfiguredBackends();
  if (backends.length === 0) {
    throw new Error(
      "No web search backend is configured. Set BRAVE_API_KEY, EXA_API_KEY, or FIRECRAWL_API_KEY.",
    );
  }

  const skippedForCooldown: SearchBackend[] = [];
  const failures: string[] = [];

  for (const backend of backends) {
    if (backendIsCoolingDown(backend)) {
      skippedForCooldown.push(backend);
      continue;
    }

    try {
      const output = normalizeSearchOutput(await searchWithBackend(backend, params, signal));
      searchCache.set(cacheKey, { text: output, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
      return output;
    } catch (error) {
      if (signal?.aborted) throw new Error("Aborted");

      if (error instanceof SearchBackendError) {
        if (error.rateLimited) setBackendCooldown(backend, error.retryAfterMs);
        failures.push(`${backend}: ${error.message}`);
        continue;
      }

      failures.push(`${backend}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (skippedForCooldown.length > 0) {
    failures.push(`cooldown: ${skippedForCooldown.join(", ")}`);
  }

  throw new Error(`Web search failed across all configured backends. ${failures.join(" | ")}`);
}

// Web search tool
const webSearchSchema = Type.Object({
  query: Type.String({
    description: "Search query. Use specific terms, not natural language questions.",
  }),
  numResults: Type.Optional(
    Type.Number({
      description: "Number of results (default: 5, max: 20).",
      minimum: 1,
      maximum: 20,
    }),
  ),
  content: Type.Optional(
    Type.Boolean({
      description: "Fetch and include page content for each result. Slower and more expensive; use sparingly.",
    }),
  ),
  freshness: Type.Optional(
    Type.String({
      description: "Filter by time: 'pd' (past day), 'pw' (past week), 'pm' (past month), 'py' (past year), or 'YYYY-MM-DDtoYYYY-MM-DD' for a date range. Mainly supported by Brave.",
    }),
  ),
  country: Type.Optional(
    Type.String({
      description: "Two-letter country code for regional results (default: US). Mainly supported by Brave.",
    }),
  ),
});

export function createWebSearchTool(): AgentTool<typeof webSearchSchema> {
  return {
    name: "webSearch",
    label: "webSearch",
    description:
      "Search the web using the configured search backend (Brave, Exa, or Firecrawl). Results are cached briefly in-process, rate-limited backends are skipped temporarily, and search falls back across configured providers. Use for documentation, API references, and current information.",
    parameters: webSearchSchema,

    async execute(_toolCallId, params, signal) {
      const output = await executeWebSearch(params, signal);
      return toolOk(output);
    },
  };
}

// Web content extraction tool
const webFetchSchema = Type.Object({
  url: Type.String({
    description: "URL to fetch and extract readable content from. Pass the original URL; webFetch handles reader/browser fetching.",
  }),
  backend: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("jina"),
    Type.Literal("direct"),
  ], {
    description: "Fetch strategy. Use auto by default, jina for clean reader markdown, or direct for local Readability extraction.",
  })),
});

export function createWebFetchTool(): AgentTool<typeof webFetchSchema> {
  return {
    name: "webFetch",
    label: "webFetch",
    description:
      "Fetch a web page and extract its readable content as markdown. Use to read documentation pages, blog posts, or any URL discovered via webSearch.",
    parameters: webFetchSchema,

    async execute(_toolCallId, params, signal) {
      try {
        const { title, content, backend } = await fetchWebContent(params.url, params.backend as WebFetchBackendChoice | undefined, signal);
        const parts: string[] = [`Fetched with backend: ${backend}\nOriginal URL: ${params.url}\n`];
        if (title) {
          parts.push(`# ${title}\n`);
        }
        parts.push(content);
        const output = parts.join("\n").trim();
        return output ? toolOk(output) : toolError(`No readable content extracted from ${params.url}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolError(`Failed to fetch ${params.url}: ${msg}`);
      }
    },
  };
}
