/**
 * Share Markdown Extension
 *
 * Exports the active pi session branch to Markdown and uploads it as a secret GitHub gist.
 * Requires: gh CLI installed and authenticated (gh auth login)
 */

import { getLanguageFromPath, type ExtensionAPI, type ExtensionCommandContext, type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent, ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const GIST_FILENAME = "session.md";

type GhResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type ToolResultEntry = SessionMessageEntry & { message: ToolResultMessage };

type MarkdownRenderContext = {
  toolResultsById: Map<string, ToolResultEntry>;
  pairedToolResultIds: Set<string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextContent(value: unknown): value is TextContent {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isImageContent(value: unknown): value is ImageContent {
  return isRecord(value) && value.type === "image";
}

function isThinkingContent(value: unknown): value is ThinkingContent {
  return isRecord(value) && value.type === "thinking" && typeof value.thinking === "string";
}

function isToolCall(value: unknown): value is ToolCall {
  return isRecord(value) && value.type === "toolCall" && typeof value.name === "string";
}

function runGh(args: string[]): Promise<GhResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (result: GhResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const proc = spawn("gh", args);
    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("error", (error) => {
      finish({ code: null, stdout, stderr: error.message });
    });
    proc.on("close", (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

function inlineCode(value: string): string {
  const maxTicks = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(maxTicks + 1);
  return `${fence}${value}${fence}`;
}

function fencedBlock(text: string, language = ""): string {
  const maxTicks = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(maxTicks + 1);
  const body = text.endsWith("\n") ? text : `${text}\n`;
  return `${fence}${language}\n${body}${fence}`;
}

function jsonBlock(value: unknown): string {
  return fencedBlock(JSON.stringify(value, null, 2) ?? "null", "json");
}

function headingText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

function imageDescription(image: ImageContent): string {
  const data = isRecord(image) && typeof image.data === "string" ? image.data : undefined;
  const mimeType = isRecord(image) && typeof image.mimeType === "string" ? image.mimeType : "image";
  const size = data ? `, ${Buffer.byteLength(data, "base64")} bytes` : "";
  return `[${mimeType} image omitted${size}]`;
}

function imageSummary(image: ImageContent): string {
  return `> ${imageDescription(image)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function detailsBlock(summary: string, body: string): string {
  return [`<details>`, `<summary>${escapeHtml(summary)}</summary>`, "", body, "", `</details>`].join("\n");
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter(isTextContent).map((block) => block.text);
}

function imageParts(content: unknown): ImageContent[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isImageContent);
}

function stringArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function toolTarget(call: ToolCall): string | undefined {
  const args = call.arguments ?? {};
  switch (call.name) {
    case "bash": {
      const command = stringArg(args, ["command"]);
      if (!command) return undefined;
      const firstLine = command.split("\n")[0]!.trim();
      return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
    }
    case "read":
    case "write":
    case "edit":
      return stringArg(args, ["path", "file_path"]);
    case "ls":
    case "grep":
    case "find":
      return stringArg(args, ["path"]);
    default:
      return undefined;
  }
}

function resultLanguage(call: ToolCall | undefined): string {
  if (!call) return "text";
  if (call.name === "read") {
    const filePath = stringArg(call.arguments ?? {}, ["path", "file_path"]);
    return filePath ? getLanguageFromPath(filePath) ?? "text" : "text";
  }
  return "text";
}

function toolPreviewLineLimit(call: ToolCall | undefined): number {
  switch (call?.name) {
    case "bash":
      return 5;
    case "read":
    case "write":
      return 10;
    case "ls":
      return 20;
    default:
      return 10;
  }
}

function formatToolOutput(text: string, language: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return fencedBlock(text, language);
  }

  const preview = lines.slice(0, maxLines).join("\n");
  const remaining = lines.length - maxLines;
  return [
    fencedBlock(preview, language),
    `_${remaining} more line${remaining === 1 ? "" : "s"}; expand for full output._`,
    "",
    detailsBlock(`Full output (${lines.length} lines)`, fencedBlock(text, language)),
  ].join("\n");
}

function formatToolResult(call: ToolCall | undefined, result: ToolResultMessage): string {
  const sections = [`Result: ${result.isError ? "error" : "ok"}`];
  const text = textParts(result.content).join("\n").trimEnd();
  const images = imageParts(result.content);

  if (text) {
    sections.push("", formatToolOutput(text, resultLanguage(call), toolPreviewLineLimit(call)));
  }

  for (const image of images) {
    sections.push("", imageSummary(image));
  }

  const details = formatDetails(result.details);
  if (details) {
    sections.push("", details);
  }

  return sections.join("\n");
}

function formatToolCall(call: ToolCall, context: MarkdownRenderContext | undefined): string {
  const result = context?.toolResultsById.get(call.id)?.message;
  const target = toolTarget(call);
  const label = target ? `${call.name} ${target}` : call.name;
  const summary = result ? `${label} — ${result.isError ? "error" : "ok"}` : label;
  const sections = ["Arguments:", "", jsonBlock(call.arguments ?? {})];

  if (result) {
    sections.push("", formatToolResult(call, result));
  }

  return detailsBlock(`Tool: ${summary}`, sections.join("\n"));
}

function hasTextOrImageContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => (isTextContent(block) && block.text.trim().length > 0) || isImageContent(block));
}

function entryMetadata(entry: SessionEntry, label?: string): string {
  const metadata = [entry.timestamp, inlineCode(entry.id)];
  if (label) metadata.push(`label: ${inlineCode(label)}`);
  return `_${metadata.join(" · ")}_`;
}

function formatContent(content: unknown, context?: MarkdownRenderContext): string {
  if (typeof content === "string") {
    return content.trimEnd();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (isTextContent(block)) {
      const text = block.text.trimEnd();
      if (text) parts.push(text);
      continue;
    }

    if (isImageContent(block)) {
      parts.push(imageSummary(block));
      continue;
    }

    if (isThinkingContent(block)) {
      if (!block.redacted && !block.thinking.trim()) continue;

      if (block.redacted) {
        parts.push(detailsBlock("Thinking", "[redacted]"));
      } else {
        parts.push(detailsBlock("Thinking", fencedBlock(block.thinking, "text")));
      }
      continue;
    }

    if (isToolCall(block)) {
      parts.push(formatToolCall(block, context));
    }
  }

  return parts.join("\n\n");
}

function formatVisibleMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trimEnd();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (isTextContent(block)) {
      const text = block.text.trimEnd();
      if (text) parts.push(text);
    } else if (isImageContent(block)) {
      parts.push(imageSummary(block));
    }
  }

  return parts.join("\n\n");
}

function formatDetails(details: unknown): string {
  if (details === undefined) return "";

  if (isRecord(details) && typeof details.diff === "string") {
    const { diff, ...rest } = details;
    const sections = [`#### Diff`, "", fencedBlock(diff, "diff")];
    if (Object.keys(rest).length > 0) {
      sections.push("", detailsBlock("Tool details", jsonBlock(rest)));
    }
    return sections.join("\n");
  }

  return detailsBlock("Tool details", jsonBlock(details));
}

function entryHeading(index: number, title: string, entry: SessionEntry, label?: string): string {
  return [`## ${index}. ${headingText(title)}`, "", entryMetadata(entry, label)].join("\n");
}

function escapeMessageText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function quoteMessageBody(value: string): string {
  return value.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
}

function formatTranscriptContent(content: unknown): string {
  if (typeof content === "string") return escapeMessageText(content.trimEnd());
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (isTextContent(block)) {
      const text = block.text.trimEnd();
      if (text) parts.push(escapeMessageText(text));
    } else if (isImageContent(block)) {
      parts.push(imageDescription(block));
    }
  }

  return parts.join("\n\n");
}

function formatTranscriptEntry(index: number, entry: SessionEntry, label: string | undefined): string | undefined {
  if (entry.type !== "message") return undefined;

  const message = entry.message;
  if (message.role === "user") {
    const content = formatTranscriptContent(message.content);
    if (!content) return undefined;
    return [entryHeading(index, "User", entry, label), "", quoteMessageBody(content)].join("\n").trimEnd();
  }

  if (message.role === "assistant") {
    let content = formatTranscriptContent(message.content);
    if (!content && message.stopReason === "aborted") content = "_Aborted._";
    if (!content && message.stopReason === "error") content = `_Error: ${escapeMessageText(message.errorMessage || "Unknown error")}_`;
    if (!content) return undefined;
    return [entryHeading(index, "Assistant", entry, label), "", quoteMessageBody(content)].join("\n").trimEnd();
  }

  return undefined;
}

function formatMessageEntry(index: number, entry: SessionMessageEntry, label: string | undefined, context: MarkdownRenderContext): string {
  const message = entry.message;

  switch (message.role) {
    case "user": {
      return [entryHeading(index, "User", entry, label), "", formatContent(message.content)].join("\n").trimEnd();
    }
    case "assistant": {
      const content = formatContent(message.content, context);
      const shouldHaveHeading = hasTextOrImageContent(message.content) || message.stopReason === "error" || message.stopReason === "aborted";
      if (!shouldHaveHeading) return content;

      const title = `Assistant (${message.provider}/${message.model})`;
      const metadata = [`Stop reason: ${message.stopReason}`];
      if (message.errorMessage) metadata.push(`Error: ${message.errorMessage}`);
      return [entryHeading(index, title, entry, label), "", metadata.join(" · "), "", content].join("\n").trimEnd();
    }
    case "toolResult": {
      const status = message.isError ? "error" : "ok";
      return [entryHeading(index, `Tool result: ${message.toolName} (${status})`, entry, label), "", formatToolResult(undefined, message)].join("\n").trimEnd();
    }
    case "bashExecution": {
      const lines = [entryHeading(index, `User bash${message.excludeFromContext ? " (excluded from context)" : ""}`, entry, label), ""];
      lines.push("Command:", "", fencedBlock(message.command, "bash"));
      lines.push("", `Exit code: ${message.exitCode ?? "unknown"}${message.cancelled ? " · cancelled" : ""}${message.truncated ? " · truncated" : ""}`);
      if (message.fullOutputPath) lines.push(`Full output: ${inlineCode(message.fullOutputPath)}`);
      if (message.output) lines.push("", "Output:", "", fencedBlock(message.output, "text"));
      return lines.join("\n").trimEnd();
    }
    case "custom": {
      const details = formatDetails(message.details);
      return [entryHeading(index, `Custom message: ${message.customType}${message.display ? "" : " (hidden)"}`, entry, label), "", formatContent(message.content), details ? `\n${details}` : ""]
        .join("\n")
        .trimEnd();
    }
    case "branchSummary": {
      return [entryHeading(index, "Branch summary", entry, label), "", message.summary].join("\n").trimEnd();
    }
    case "compactionSummary": {
      return [entryHeading(index, "Compaction summary", entry, label), "", `Tokens before: ${message.tokensBefore}`, "", message.summary].join("\n").trimEnd();
    }
    default: {
      return [entryHeading(index, "Message", entry, label), "", jsonBlock(message)].join("\n");
    }
  }
}

function isToolResultEntry(entry: SessionEntry): entry is ToolResultEntry {
  return entry.type === "message" && entry.message.role === "toolResult";
}

function formatEntry(index: number, entry: SessionEntry, label: string | undefined, context: MarkdownRenderContext): string | undefined {
  switch (entry.type) {
    case "message":
      if (entry.message.role === "toolResult" && context.pairedToolResultIds.has(entry.message.toolCallId)) {
        return undefined;
      }
      return formatMessageEntry(index, entry, label, context);
    case "compaction":
      return [entryHeading(index, "Compaction", entry, label), "", `Tokens before: ${entry.tokensBefore}`, `First kept entry: ${inlineCode(entry.firstKeptEntryId)}`, "", entry.summary].join("\n").trimEnd();
    case "branch_summary":
      return [entryHeading(index, "Branch summary", entry, label), "", `From: ${inlineCode(entry.fromId)}`, "", entry.summary].join("\n").trimEnd();
    case "model_change":
      return [entryHeading(index, "Model change", entry, label), "", `${entry.provider}/${entry.modelId}`].join("\n").trimEnd();
    case "thinking_level_change":
      return [entryHeading(index, "Thinking level change", entry, label), "", entry.thinkingLevel].join("\n").trimEnd();
    case "custom_message": {
      const details = formatDetails(entry.details);
      return [entryHeading(index, `Custom message: ${entry.customType}${entry.display ? "" : " (hidden)"}`, entry, label), "", formatContent(entry.content), details ? `\n${details}` : ""]
        .join("\n")
        .trimEnd();
    }
    case "label":
    case "session_info":
    case "custom":
      return undefined;
    default: {
      const unknownEntry = entry as SessionEntry & { type: string };
      return [entryHeading(index, unknownEntry.type, unknownEntry, label), "", jsonBlock(unknownEntry)].join("\n");
    }
  }
}

function buildRenderContext(branch: SessionEntry[]): MarkdownRenderContext {
  const toolResultsById = new Map<string, ToolResultEntry>();
  const pairedToolResultIds = new Set<string>();

  for (const entry of branch) {
    if (isToolResultEntry(entry)) {
      toolResultsById.set(entry.message.toolCallId, entry);
    }
  }

  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (isToolCall(block) && toolResultsById.has(block.id)) {
        pairedToolResultIds.add(block.id);
      }
    }
  }

  return { toolResultsById, pairedToolResultIds };
}

export function buildMarkdown(ctx: ExtensionCommandContext): string {
  const sessionManager = ctx.sessionManager;
  const header = sessionManager.getHeader();
  const branch = sessionManager.getBranch();
  const sessionName = sessionManager.getSessionName();
  const sessionFile = sessionManager.getSessionFile();

  const lines = ["# Pi session export", ""];
  if (sessionName) lines.push(`- Name: ${sessionName}`);
  lines.push(`- Session ID: ${inlineCode(sessionManager.getSessionId())}`);
  if (header?.timestamp) lines.push(`- Started: ${header.timestamp}`);
  lines.push(`- Exported: ${new Date().toISOString()}`);
  lines.push(`- CWD: ${inlineCode(sessionManager.getCwd())}`);
  if (sessionFile) lines.push(`- Session file: ${inlineCode(sessionFile)}`);
  const leafId = sessionManager.getLeafId();
  if (leafId) lines.push(`- Active leaf: ${inlineCode(leafId)}`);
  lines.push(`- Entries: ${branch.length} active-branch entries`);

  let index = 1;
  for (const entry of branch) {
    const section = formatTranscriptEntry(index, entry, sessionManager.getLabel(entry.id));
    if (!section) continue;
    lines.push("", section);
    index += 1;
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

async function ensureGhAvailable(ctx: ExtensionCommandContext): Promise<boolean> {
  const auth = await runGh(["auth", "status"]);
  if (auth.code === 0) return true;

  const version = await runGh(["--version"]);
  if (version.code !== 0) {
    notify(ctx, "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/.", "error");
    return false;
  }

  notify(ctx, "GitHub CLI is not logged in. Run `gh auth login` first.", "error");
  return false;
}

function parseGistUrl(stdout: string): string | undefined {
  return stdout.trim().split(/\s+/).find((part) => part.startsWith("https://gist.github.com/"));
}

export default function shareMarkdownExtension(pi: ExtensionAPI) {
  pi.registerCommand("share-md", {
    description: "Upload the active session branch as a Markdown GitHub gist",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      if (!(await ensureGhAvailable(ctx))) return;

      const markdown = buildMarkdown(ctx);
      const tmpDir = mkdtempSync(join(tmpdir(), "pi-share-md-"));
      const tmpFile = join(tmpDir, GIST_FILENAME);

      try {
        writeFileSync(tmpFile, markdown, "utf8");
        notify(ctx, "Creating Markdown gist...", "info");

        const result = await runGh(["gist", "create", "--public=false", tmpFile]);
        if (result.code !== 0) {
          const error = result.stderr.trim() || "Unknown error";
          notify(ctx, `Failed to create gist: ${error}`, "error");
          return;
        }

        const gistUrl = parseGistUrl(result.stdout);
        if (!gistUrl) {
          notify(ctx, "Created gist, but could not parse the URL from gh output.", "warning");
          return;
        }

        const gistId = basename(gistUrl);
        notify(ctx, `Markdown session gist: ${gistUrl}\nRaw: ${gistUrl}/raw/${GIST_FILENAME}\nID: ${gistId}`, "info");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  });
}
