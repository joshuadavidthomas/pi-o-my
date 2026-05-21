// Read-only bash tool for scout agents that must inspect without mutation.
//
// Wraps pi's createBashTool but rejects commands that could modify
// the workspace. Only allows a known set of read-only commands.

import { createBashTool } from "@mariozechner/pi-coding-agent";

// Commands read-only scouts are allowed to run
const ALLOWED_COMMANDS = new Set([
  "rg", "fd", "ls", "cat", "wc", "head", "tail", "file", "stat", "nl",
  "tree", "du", "grep", "sort", "uniq", "cut",
  "tr", "diff", "comm", "echo", "printf", "test", "git",
  "basename", "dirname", "realpath", "readlink",
]);

const ALLOWED_GIT_SUBCOMMANDS = new Set(["diff", "status", "ls-files", "rev-parse", "show", "log"]);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
const BLOCKED_GIT_OPTIONS = [/^--output(?:=|$)/, /^--ext-diff$/, /^--external-diff$/];

// Patterns that indicate mutation regardless of the command
const MUTATION_PATTERNS = [
  /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln)\b/,
  /\b(git\s+(commit|push|checkout|reset|clean|stash|merge|rebase|pull|add|init))\b/,
  /\b(npm|npx|yarn|pnpm|bun|pip|cargo|go)\s+(install|add|remove|run|build|publish)\b/,
  /\b(make|cmake|ninja)\b/,
  /[>|]\s*tee\b/,  // tee used for writing
  />\s*[^&]/,       // output redirection (but not >&2)
  /\bsudo\b/,
  /\bcurl\b.*-[^s]*[oO]/,  // curl with -o/-O (download to file)
  /\bwget\b/,
];

function extractLeadCommand(command: string): string | null {
  const trimmed = command.trim();
  const match = trimmed.match(/^(?:(?:cd\s+\S+\s*&&\s*)|(?:\w+=\S+\s+))*(\w[\w.-]*)/);
  return match?.[1] ?? null;
}

function words(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    const next = command[i + 1];

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      current += char;
      escaping = true;
      continue;
    }

    if ((char === "'" || char === '"') && quote === null) {
      quote = char;
      current += char;
      continue;
    }

    if (char === quote) {
      quote = null;
      current += char;
      continue;
    }

    if (quote === null && (char === ";" || char === "|" || (char === "&" && next === "&"))) {
      const segment = current.trim();
      if (segment) segments.push(segment);
      current = "";
      if ((char === "|" && next === "|") || (char === "&" && next === "&")) i += 1;
      continue;
    }

    current += char;
  }

  const segment = current.trim();
  if (segment) segments.push(segment);
  return segments;
}

function gitSubcommand(command: string): string | undefined {
  const tokens = words(command);
  if (tokens[0] !== "git") return undefined;

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--") return undefined;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("-C") && token.length > 2) continue;
    if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=") || token.startsWith("--namespace=")) continue;
    if (token.startsWith("-")) continue;
    return token;
  }

  return undefined;
}

function validateGitCommand(command: string): { ok: boolean; reason?: string } {
  const tokens = words(command);
  const blockedOption = tokens.find((token) => BLOCKED_GIT_OPTIONS.some((pattern) => pattern.test(token)));
  if (blockedOption) return { ok: false, reason: `Git option '${blockedOption}' is not allowed in read-only mode` };

  const subcommand = gitSubcommand(command);
  if (!subcommand) return { ok: false, reason: "Git command is missing a read-only subcommand" };
  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    return { ok: false, reason: `Git subcommand '${subcommand}' is not in the read-only allowlist` };
  }
  return { ok: true };
}

export function isReadOnlyCommand(command: string): { ok: boolean; reason?: string } {
  for (const pattern of MUTATION_PATTERNS) {
    if (pattern.test(command)) {
      return { ok: false, reason: `Command matches blocked pattern: ${pattern.source}` };
    }
  }

  const segments = splitShellSegments(command);

  for (const segment of segments) {
    const inner = segment.replace(/^\(+/, "").replace(/\)+$/, "").trim();
    const lead = extractLeadCommand(inner);

    if (!lead) continue;
    if (!ALLOWED_COMMANDS.has(lead)) {
      return { ok: false, reason: `Command '${lead}' is not in the read-only allowlist` };
    }
    if (lead === "git") {
      const gitCheck = validateGitCommand(inner);
      if (!gitCheck.ok) return gitCheck;
    }
  }

  return { ok: true };
}

export function createReadOnlyBashTool(cwd: string) {
  const baseTool = createBashTool(cwd);

  return {
    ...baseTool,
    __scoutCustomTool: true,
    name: "bash",
    description: "Execute read-only bash commands (rg, fd, ls, cat, wc, head, tail, file, stat, nl, tree, grep, sort, uniq, cut, diff, safe git reads). No writes, installs, or mutations allowed.",

    async execute(...args: Parameters<typeof baseTool.execute>) {
      const [toolCallId, params, signal, onUpdate] = args;
      const command = typeof params.command === "string" ? params.command : "";

      const check = isReadOnlyCommand(command);
      if (!check.ok) {
        throw new Error(`Blocked: ${check.reason}. This scout operates in read-only mode.`);
      }

      return baseTool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}
