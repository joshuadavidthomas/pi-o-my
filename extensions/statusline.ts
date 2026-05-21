/**
 * Starship-style Statusline Extension
 *
 * Custom footer with:
 * - Line 1 left: Model info, context %, sycophancy, cwd, VCS status (Starship-style)
 * - Line 1 right: Cost, token stats
 * - Line 2: vibeusage provider usage (via `vibeusage statusline -p <provider>`)
 *
 * Supports both git and jj (Jujutsu) version control systems.
 * In colocated repos (.jj/ + .git/), jj takes priority.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Nerd Font characters — DO NOT EDIT these values. They contain Nerd Font
// glyphs that may render as blank in agent environments. Only a human with
// a Nerd Font-capable terminal should change these.
const NERD_FONT_MAP = {
  ROBOT: "󰚩",
  BRAIN: "",
  THUMBS_UP: "",
  GIT_BRANCH: "",
  JJ_WORKING_COPY: "@",
} as const;

const PROVIDER_MAP = {
  "claude-agent-sdk": "claude code",
  "github-copilot": "copilot",
  "google-antigravity": "google",
  "openai-codex": "openai",
} as const;

// Maps pi model provider IDs to vibeusage provider IDs
const VIBEUSAGE_PROVIDER_MAP: Record<string, string> = {
  "anthropic": "claude",
  "claude-agent-sdk": "claude",
  "github-copilot": "copilot",
  "google": "gemini",
  "google-antigravity": "antigravity",
  "google-gemini-cli": "gemini",
  "google-vertex": "gemini",
  "kimi-coding": "kimicode",
  "minimax": "minimax",
  "minimax-cn": "minimax",
  "openai": "codex",
  "openai-codex": "codex",
  "openrouter": "openrouter",
  "xai": "amp",
  "zai": "zai",
};

// VCS types
type VcsType = "git" | "jj";

// Shared VCS state flags
const VCS_STATE = {
  CONFLICTED: "=",
  STASHED: "$",
  DELETED: "✘",
  RENAMED: "»",
  MODIFIED: "!",
  STAGED: "+",
  UNTRACKED: "?",
  EMPTY: "∅",
  DIVERGENT: "↔",
  HIDDEN: "◌",
  IMMUTABLE: "󰌾",
} as const;

type VcsStateKey = keyof typeof VCS_STATE;

const VCS_AHEAD_BEHIND = {
  DIVERGED: "⇕",
  AHEAD: "⇡",
  BEHIND: "⇣",
} as const;

// Display order for state symbols (Starship order, with EMPTY at end)
const VCS_STATE_ORDER: VcsStateKey[] = [
  "CONFLICTED",
  "STASHED",
  "DELETED",
  "RENAMED",
  "MODIFIED",
  "STAGED",
  "UNTRACKED",
  "EMPTY",
  "DIVERGENT",
  "HIDDEN",
  "IMMUTABLE",
];

interface VcsStatus {
  vcs: VcsType;
  identifier: string;              // git: branch name, jj: short change ID
  label?: string;                  // jj: bookmark name if present
  aheadBehind: (typeof VCS_AHEAD_BEHIND)[keyof typeof VCS_AHEAD_BEHIND] | null;
  states: Set<VcsStateKey>;
}

// VCS status cache
let vcsStatusCache: { status: VcsStatus | null; timestamp: number } | null = null;
const VCS_CACHE_TTL = 2000; // 2 seconds

// Vibeusage cache (async, non-blocking)
let vibeusageCache: { output: string | null; provider: string | null; timestamp: number } | null = null;
let vibeusageFetching = false;
const VIBEUSAGE_CACHE_TTL = 30000; // 30 seconds
let vibeusageRequestRender: (() => void) | null = null;

let footerRequestRender: (() => void) | null = null;
let footerRenderTimeout: NodeJS.Timeout | null = null;
let lastFooterRenderAt = 0;
const FOOTER_RENDER_THROTTLE_MS = 125;

let lastContextUsageCache: {
  modelKey: string;
  tokens: number;
  percent: number;
  contextWindow: number;
} | null = null;

function requestFooterRender(): void {
  if (!footerRequestRender) return;

  const now = Date.now();
  const delay = FOOTER_RENDER_THROTTLE_MS - (now - lastFooterRenderAt);

  if (delay <= 0) {
    lastFooterRenderAt = now;
    footerRequestRender();
    return;
  }

  if (footerRenderTimeout) return;

  footerRenderTimeout = setTimeout(() => {
    footerRenderTimeout = null;
    lastFooterRenderAt = Date.now();
    footerRequestRender?.();
  }, delay);
}

function clearFooterRender(): void {
  footerRequestRender = null;
  if (footerRenderTimeout) {
    clearTimeout(footerRenderTimeout);
    footerRenderTimeout = null;
  }
}

function refreshVibeusage(vibeProvider: string): void {
  if (vibeusageFetching) return;
  vibeusageFetching = true;

  const { execFile } = require("node:child_process") as typeof import("node:child_process");
  execFile(
    "vibeusage",
    ["statusline", "-p", vibeProvider],
    { encoding: "utf8", timeout: 5000, env: { ...process.env, CLICOLOR_FORCE: "1" } },
    (err, stdout) => {
      vibeusageFetching = false;
      if (err) {
        vibeusageCache = { output: null, provider: vibeProvider, timestamp: Date.now() };
      } else {
        const output = stdout.trim();
        vibeusageCache = { output: output || null, provider: vibeProvider, timestamp: Date.now() };
      }
      vibeusageRequestRender?.();
    },
  );
}

function getVibeusageOutput(piProvider: string | undefined): string | null {
  const vibeProvider = piProvider ? VIBEUSAGE_PROVIDER_MAP[piProvider] : null;
  if (!vibeProvider) return null;

  const isFresh =
    vibeusageCache &&
    vibeusageCache.provider === vibeProvider &&
    Date.now() - vibeusageCache.timestamp < VIBEUSAGE_CACHE_TTL;

  if (!isFresh) {
    refreshVibeusage(vibeProvider);
  }

  return vibeusageCache?.provider === vibeProvider ? vibeusageCache.output : null;
}

function runCmd(cmd: string, ...args: string[]): string | null {
  try {
    const result = execSync([cmd, ...args].join(" "), {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch {
    return null;
  }
}

// VCS detection

function detectVcs(): VcsType | null {
  // jj root walks up the directory tree, so it works from subdirectories.
  // --ignore-working-copy avoids snapshotting overhead.
  if (runCmd("jj", "root", "--ignore-working-copy")) return "jj";
  if (runCmd("git", "rev-parse", "--git-dir")) return "git";
  return null;
}

// Git provider

function getGitStatus(): VcsStatus | null {
  const status: VcsStatus = {
    vcs: "git",
    identifier: "detached",
    aheadBehind: null,
    states: new Set(),
  };

  // Branch name
  status.identifier = runCmd("git", "branch", "--show-current") || "detached";

  // Ahead/behind
  const revList = runCmd("git", "rev-list", "--left-right", "--count", "@{upstream}...HEAD");
  if (revList) {
    const parts = revList.split(/\s+/);
    if (parts.length === 2) {
      const behind = parseInt(parts[0], 10);
      const ahead = parseInt(parts[1], 10);
      if (ahead > 0 && behind > 0) {
        status.aheadBehind = VCS_AHEAD_BEHIND.DIVERGED;
      } else if (ahead > 0) {
        status.aheadBehind = VCS_AHEAD_BEHIND.AHEAD;
      } else if (behind > 0) {
        status.aheadBehind = VCS_AHEAD_BEHIND.BEHIND;
      }
    }
  }

  // Porcelain status
  const porcelain = runCmd("git", "status", "--porcelain=v1");
  if (porcelain) {
    for (const line of porcelain.split("\n")) {
      if (line.length < 2) continue;
      const index = line[0];
      const worktree = line[1];

      if (index === "U" || worktree === "U" || (index === "A" && worktree === "A")) {
        status.states.add("CONFLICTED");
        continue;
      }

      if (index === "R") status.states.add("RENAMED");
      else if (index === "D") status.states.add("DELETED");
      else if ("AMC".includes(index)) status.states.add("STAGED");
      else if (index === "?") status.states.add("UNTRACKED");

      if (worktree === "M") status.states.add("MODIFIED");
      else if (worktree === "D") status.states.add("DELETED");
    }
  }

  // Stash
  if (runCmd("git", "stash", "list")) {
    status.states.add("STASHED");
  }

  return status;
}

// jj provider

function getJjStatus(): VcsStatus | null {
  // Single template call to get change ID, bookmarks, conflict, empty status
  const template = [
    'change_id.short(8)',
    '"\\n"',
    'if(bookmarks, bookmarks.join(","), "")',
    '"\\n"',
    'if(conflict, "true", "false")',
    '"\\n"',
    'if(empty, "true", "false")',
    '"\\n"',
    'if(divergent, "true", "false")',
    '"\\n"',
    'if(hidden, "true", "false")',
    '"\\n"',
    'if(immutable, "true", "false")',
  ].join(" ++ ");

  const logOutput = runCmd("jj", "log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", `'${template}'`);
  if (!logOutput) return null;

  const lines = logOutput.split("\n");
  if (lines.length < 7) return null;

  const changeId = lines[0].trim();
  const bookmarks = lines[1].trim();
  const hasConflict = lines[2].trim() === "true";
  const isEmpty = lines[3].trim() === "true";
  const isDivergent = lines[4].trim() === "true";
  const isHidden = lines[5].trim() === "true";
  const isImmutable = lines[6].trim() === "true";

  const status: VcsStatus = {
    vcs: "jj",
    identifier: changeId,
    label: bookmarks || undefined,
    aheadBehind: null,
    states: new Set(),
  };

  if (hasConflict) status.states.add("CONFLICTED");
  if (isEmpty) status.states.add("EMPTY");
  if (isDivergent) status.states.add("DIVERGENT");
  if (isHidden) status.states.add("HIDDEN");
  if (isImmutable) status.states.add("IMMUTABLE");

  // File-level status from jj diff --summary
  const diffSummary = runCmd("jj", "diff", "--ignore-working-copy", "--summary");
  if (diffSummary) {
    for (const line of diffSummary.split("\n")) {
      if (!line.trim()) continue;
      const code = line[0];
      if (code === "M") status.states.add("MODIFIED");
      else if (code === "D") status.states.add("DELETED");
      else if (code === "A") status.states.add("UNTRACKED"); // new files in jj
      else if (code === "R") status.states.add("RENAMED");
    }
  }

  return status;
}

// Shared formatting

function formatVcsStates(status: VcsStatus): string {
  let result = "";

  for (const state of VCS_STATE_ORDER) {
    // Skip git-only states for jj, skip jj-only states for git
    if (status.vcs === "jj" && (state === "STASHED" || state === "STAGED")) continue;
    if (status.vcs === "git" && (state === "EMPTY" || state === "DIVERGENT" || state === "HIDDEN" || state === "IMMUTABLE")) continue;

    if (status.states.has(state)) {
      result += VCS_STATE[state];
    }
  }

  if (status.aheadBehind) {
    result += status.aheadBehind;
  }

  return result;
}

function getVcsStatus(): VcsStatus | null {
  // Check cache
  if (vcsStatusCache && Date.now() - vcsStatusCache.timestamp < VCS_CACHE_TTL) {
    return vcsStatusCache.status;
  }

  const vcsType = detectVcs();
  let status: VcsStatus | null = null;

  if (vcsType === "git") {
    status = getGitStatus();
  } else if (vcsType === "jj") {
    status = getJjStatus();
  }

  vcsStatusCache = { status, timestamp: Date.now() };
  return status;
}

function formatModelName(name: string): string {
  return name.toLowerCase().replace(/^claude[-\s]+/, "");
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
  if (count >= 1_000) return `${Math.floor(count / 1_000)}k`;
  return count.toString();
}

// Sycophantic phrases to count
const SYCOPHANTIC_PHRASES = [
  "you're absolutely right",
  "you're right",
  "great question",
  "excellent point",
  "that's a great idea",
  "brilliant suggestion",
];

function countSycophancy(sessionManager: { getBranch(): Array<{ type: string; message: { role: string; content: Array<{ type: string; text?: string }> } }> }): number {
  let count = 0;

  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;

    for (const block of entry.message.content) {
      if (block.type !== "text" || !block.text) continue;
      const text = block.text.toLowerCase();
      for (const phrase of SYCOPHANTIC_PHRASES) {
        let idx = 0;
        while ((idx = text.indexOf(phrase, idx)) !== -1) {
          count++;
          idx += phrase.length;
        }
      }
    }
  }

  return count;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    lastContextUsageCache = null;

    ctx.ui.setFooter((tui, theme, footerData) => {
      footerRequestRender = () => tui.requestRender();
      vibeusageRequestRender = requestFooterRender;
      const unsub = footerData.onBranchChange(() => {
        vcsStatusCache = null;
        requestFooterRender();
      });

      return {
        dispose() {
          unsub();
          vibeusageRequestRender = null;
          clearFooterRender();
        },
        invalidate() {
          vcsStatusCache = null;
        },
        render(width: number): string[] {
          const state = ctx.sessionManager;
          const model = ctx.model;

          // === LINE 1: Model, context, duration, cwd, VCS ===
          let line1Parts: string[] = [];

          // Model: "󰚩 claude-sonnet-4 from anthropic" (bold blue)
          if (model) {
            const modelName = formatModelName(model.name || model.id);
            line1Parts.push(
              theme.fg("accent", theme.bold(`${NERD_FONT_MAP["ROBOT"]} ${modelName}`)) +
              theme.fg("dim", " from ") +
              theme.fg("muted", PROVIDER_MAP[model.provider as keyof typeof PROVIDER_MAP] || model.provider)
            );
          }

          // Context percentage with color coding
          const contextUsage = ctx.getContextUsage();
          const modelKey = model
            ? `${model.provider}:${model.id}:${model.contextWindow || 0}`
            : null;

          let displayContextUsage: {
            tokens: number;
            percent: number;
            contextWindow: number;
          } | null = null;

          if (
            contextUsage &&
            contextUsage.contextWindow > 0 &&
            contextUsage.tokens !== null &&
            contextUsage.percent !== null
          ) {
            displayContextUsage = {
              tokens: contextUsage.tokens,
              percent: contextUsage.percent,
              contextWindow: contextUsage.contextWindow,
            };

            if (modelKey) {
              lastContextUsageCache = { modelKey, ...displayContextUsage };
            }
          } else if (modelKey && lastContextUsageCache?.modelKey === modelKey) {
            displayContextUsage = {
              tokens: lastContextUsageCache.tokens,
              percent: lastContextUsageCache.percent,
              contextWindow: lastContextUsageCache.contextWindow,
            };
          }

          if (displayContextUsage) {
            // Dumb zone thresholds based on absolute token counts, not percentages.
            // Horthy's 40% rule was observed on 128K-200K windows — the real
            // degradation is ~40K-80K tokens regardless of window size.
            const cw = displayContextUsage.contextWindow;
            const warningAt = Math.max(40_000, Math.min(cw * 0.40, 80_000));
            const errorAt = Math.max(65_000, Math.min(cw * 0.65, 130_000));

            let contextColor: "success" | "warning" | "error" = "success";
            if (displayContextUsage.tokens >= errorAt) contextColor = "error";
            else if (displayContextUsage.tokens >= warningAt) contextColor = "warning";

            const contextStr = `${NERD_FONT_MAP["BRAIN"]} ${displayContextUsage.percent.toFixed(0)}%`;
            const contextDetail = `(${formatTokens(displayContextUsage.tokens)}/${formatTokens(displayContextUsage.contextWindow)})`;

            line1Parts.push(
              theme.fg("dim", "at ") +
              theme.fg(contextColor, theme.bold(contextStr)) +
              " " +
              theme.fg("dim", theme.italic(contextDetail))
            );
          }

          // Sycophancy count (bold yellow)
          const sycophancyCount = countSycophancy(state as any);
          if (sycophancyCount > 0) {
            line1Parts.push(theme.fg("warning", theme.bold(`${NERD_FONT_MAP["THUMBS_UP"]} ${sycophancyCount}`)));
          }

          // Current directory (basename only, bold cyan)
          const cwd = process.cwd();
          const cwdName = cwd.split("/").pop() || cwd;
          line1Parts.push(theme.fg("dim", "in ") + theme.fg("accent", theme.bold(cwdName)));

          // VCS status
          const vcsStatus = getVcsStatus();
          if (vcsStatus) {
            const vcsIcon = vcsStatus.vcs === "jj" ? NERD_FONT_MAP["JJ_WORKING_COPY"] : NERD_FONT_MAP["GIT_BRANCH"];
            let vcsPart = theme.fg("dim", "on ") +
              theme.fg("muted", theme.bold(`${vcsIcon} ${vcsStatus.identifier}`));

            // jj: show bookmark label after change ID
            if (vcsStatus.label) {
              vcsPart += " " + theme.fg("dim", vcsStatus.label);
            }

            const statusStr = formatVcsStates(vcsStatus);
            if (statusStr) {
              vcsPart += " " + theme.fg("error", theme.bold(`[${statusStr}]`));
            }
            line1Parts.push(vcsPart);
          }

          // === LINE 1 RIGHT: Cost, tokens ===
          let totalInput = 0;
          let totalOutput = 0;
          let totalCost = 0;

          for (const entry of state.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              const msg = entry.message as AssistantMessage;
              totalInput += msg.usage.input;
              totalOutput += msg.usage.output;
              totalCost += msg.usage.cost.total;
            }
          }

          const usingSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;

          const line1RightParts: string[] = [];

          const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
          line1RightParts.push(theme.fg("dim", costStr));

          if (totalInput || totalOutput) {
            line1RightParts.push(theme.fg("dim", `↑${formatTokens(totalInput)} ↓${formatTokens(totalOutput)}`));
          }

          const line1Left = line1Parts.join(" ");
          const line1Right = line1RightParts.join(" ");

          const leftWidth = visibleWidth(line1Left);
          const rightWidth = visibleWidth(line1Right);
          const gap = width - leftWidth - rightWidth;
          const line1 = gap > 0
            ? line1Left + " ".repeat(gap) + line1Right
            : truncateToWidth(line1Left + "  " + line1Right, width);

          // === LINE 2: Vibeusage ===
          const vibeusageOutput = getVibeusageOutput(model?.provider);
          const line2 = vibeusageOutput ? truncateToWidth(vibeusageOutput, width) : "";

          const lines = [truncateToWidth(line1, width)];
          if (line2) {
            lines.push(line2);
          }

          const extensionStatuses = footerData.getExtensionStatuses();
          if (extensionStatuses.size > 0) {
            const sortedStatuses = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => text.replace(/[\r\n\t]/g, " ").trim());
            const statusLine = sortedStatuses.join(" ");
            lines.push(truncateToWidth(statusLine, width));
          }

          return lines;
        },
      };
    });
  });

  pi.on("turn_start", async () => {
    requestFooterRender();
  });

  (pi as any).on("message_end", async () => {
    requestFooterRender();
  });

  (pi as any).on("message_update", async () => {
    requestFooterRender();
  });

  (pi as any).on("tool_execution_end", async () => {
    requestFooterRender();
  });

  pi.on("model_select", async () => {
    requestFooterRender();
  });

  // Invalidate caches on turn end (files may have changed, usage updated)
  pi.on("turn_end", async () => {
    vcsStatusCache = null;
    // Expire vibeusage cache but keep stale data visible while refreshing
    if (vibeusageCache) {
      vibeusageCache.timestamp = 0;
    }
    requestFooterRender();
  });
}
