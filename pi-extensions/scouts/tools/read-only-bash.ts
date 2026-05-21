// Read-only bash tool for scout agents that must inspect without mutation.
//
// Wraps pi's createBashTool but rejects commands that could modify
// the workspace. Only allows a known set of read-only commands.

import { createBashTool } from "@mariozechner/pi-coding-agent";

// Commands read-only scouts are allowed to run
const ALLOWED_COMMANDS = new Set([
  "rg", "fd", "ls", "cat", "wc", "head", "tail", "file", "stat", "nl",
  "find", "tree", "du", "grep", "awk", "sort", "uniq", "cut",
  "tr", "diff", "comm", "echo", "printf", "test",
  "basename", "dirname", "realpath", "readlink",
]);

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

function isReadOnly(command: string): { ok: boolean; reason?: string } {
  for (const pattern of MUTATION_PATTERNS) {
    if (pattern.test(command)) {
      return { ok: false, reason: `Command matches blocked pattern: ${pattern.source}` };
    }
  }

  const segments = command.split(/[|;]/).map((s) => s.trim()).filter(Boolean);

  for (const segment of segments) {
    const inner = segment.replace(/^\(+/, "").replace(/\)+$/, "").trim();
    const lead = extractLeadCommand(inner);

    if (!lead) continue;

    const parts = inner.split(/\s*(?:&&|\|\|)\s*/);
    for (const part of parts) {
      const partLead = extractLeadCommand(part);
      if (partLead && !ALLOWED_COMMANDS.has(partLead)) {
        return { ok: false, reason: `Command '${partLead}' is not in the read-only allowlist` };
      }
    }
  }

  return { ok: true };
}

export function createReadOnlyBashTool(cwd: string) {
  const baseTool = createBashTool(cwd);

  return {
    ...baseTool,
    name: "bash",
    description: "Execute read-only bash commands (rg, fd, ls, cat, wc, head, tail, file, stat, nl, find, tree, grep, awk, sort, uniq, cut, diff). No writes, installs, or mutations allowed.",

    async execute(...args: Parameters<typeof baseTool.execute>) {
      const [toolCallId, params, signal, onUpdate] = args;
      const command = typeof params.command === "string" ? params.command : "";

      const check = isReadOnly(command);
      if (!check.ok) {
        throw new Error(`Blocked: ${check.reason}. This scout operates in read-only mode.`);
      }

      return baseTool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}
