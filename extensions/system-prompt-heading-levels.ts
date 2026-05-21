import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ContextFile = NonNullable<BuildSystemPromptOptions["contextFiles"]>[number];

const CONTEXT_FILE_HEADING_LEVEL = 3;

function markdownHeadingLevels(markdown: string): number[] {
  const levels: number[] = [];

  for (const match of markdown.matchAll(/^(#{1,6})([ \t]+.+)$/gm)) {
    levels.push(match[1]!.length);
  }

  return levels;
}

function normalizeMarkdownSpacing(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeMarkdownHeadings(markdown: string, targetTopLevel = CONTEXT_FILE_HEADING_LEVEL): string {
  const normalized = normalizeMarkdownSpacing(markdown);
  const levels = markdownHeadingLevels(normalized);
  if (levels.length === 0) return normalized;

  const topLevel = Math.min(...levels);
  const shift = targetTopLevel - topLevel;
  if (shift === 0) return normalized;

  return normalized.replace(/^(#{1,6})([ \t]+.+)$/gm, (_match, hashes: string, rest: string) => {
    const level = Math.max(1, Math.min(6, hashes.length + shift));
    return `${"#".repeat(level)}${rest}`;
  });
}

function findContextFileHeading(prompt: string, path: string, fromIndex: number): number {
  const heading = `## ${path}`;
  const index = prompt.indexOf(heading, fromIndex);
  if (index === -1) return -1;

  const startsLine = index === 0 || prompt[index - 1] === "\n";
  const endsLine = prompt[index + heading.length] === "\n" || prompt[index + heading.length] === "\r";
  return startsLine && endsLine ? index : -1;
}

function contentStartAfterHeading(prompt: string, headingStart: number): number {
  const lineEnd = prompt.indexOf("\n", headingStart);
  if (lineEnd === -1) return prompt.length;

  let start = lineEnd + 1;
  while (prompt.startsWith("\n", start)) start += 1;
  return start;
}

function findSkillsStart(prompt: string, fromIndex: number): number {
  const marker = "The following skills provide specialized instructions for specific tasks.";
  const index = prompt.indexOf(marker, fromIndex);
  if (index === -1) return prompt.length;

  return index > 0 && prompt[index - 1] === "\n" ? index : prompt.lastIndexOf("\n", index) + 1;
}

function normalizeContextFileHeadings(systemPrompt: string, contextFiles: ContextFile[] | undefined): string {
  if (!contextFiles?.length) return systemPrompt;

  const ranges: Array<{ start: number; end: number }> = [];
  let searchFrom = 0;

  for (const [index, contextFile] of contextFiles.entries()) {
    const headingStart = findContextFileHeading(systemPrompt, contextFile.path, searchFrom);
    if (headingStart === -1) continue;

    const start = contentStartAfterHeading(systemPrompt, headingStart);
    const nextContextFile = contextFiles[index + 1];
    const nextHeadingStart = nextContextFile
      ? findContextFileHeading(systemPrompt, nextContextFile.path, start)
      : -1;
    const end = nextHeadingStart === -1 ? findSkillsStart(systemPrompt, start) : nextHeadingStart;

    ranges.push({ start, end });
    searchFrom = end;
  }

  let prompt = systemPrompt;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]!;
    const before = prompt.slice(0, range.start);
    const content = prompt.slice(range.start, range.end);
    const after = prompt.slice(range.end);
    prompt = `${before}${normalizeMarkdownHeadings(content)}\n\n${after.trimStart()}`;
  }

  return normalizeSkillsSectionBoundary(prompt);
}

function normalizeSkillsSectionBoundary(systemPrompt: string): string {
  const marker = "The following skills provide specialized instructions for specific tasks.";
  const markerIndex = systemPrompt.indexOf(marker);
  if (markerIndex === -1) return systemPrompt;

  const lineStart = markerIndex > 0 && systemPrompt[markerIndex - 1] === "\n"
    ? markerIndex
    : systemPrompt.lastIndexOf("\n", markerIndex) + 1;
  const before = systemPrompt.slice(0, lineStart).trimEnd();
  const after = systemPrompt.slice(lineStart).trimStart();

  return `${before}\n\n# Available Skills\n\n${after}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const systemPrompt = normalizeContextFileHeadings(
      event.systemPrompt,
      event.systemPromptOptions.contextFiles,
    );

    if (systemPrompt === event.systemPrompt) return;
    return { systemPrompt };
  });
}
