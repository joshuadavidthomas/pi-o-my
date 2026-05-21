/**
 * Git diff overlay — view diffs inside pi with your configured pager (delta, etc.)
 *
 * Usage:
 *   alt+g         - keyboard shortcut
 *   /diff          - command (optionally pass args, e.g. /diff --cached)
 *
 * Controls:
 *   up/down, j/k     - scroll line by line
 *   page up/down      - scroll by page
 *   home/end, g/G     - jump to top/bottom
 *   tab               - cycle: unstaged → staged → untracked
 *   q / escape        - close
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

// Strip all ANSI sequences EXCEPT SGR (colors/styles ending in 'm')
function cleanPtyOutput(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    .replace(/\x1b\[\?[\d;]*[A-Za-z]/g, "")
    .replace(/\x1b\[[\d;]*[A-HJ-Za-lp-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][AB012]/g, "")
    .replace(/\x1b[=>]/g, "")
    .trim();
}

type DiffMode = "unstaged" | "staged" | "untracked";

const MODE_ORDER: DiffMode[] = ["unstaged", "staged", "untracked"];

function modeArgs(mode: DiffMode): string {
  switch (mode) {
    case "unstaged": return "";
    case "staged": return "--cached";
    case "untracked": return "";
  }
}

function runUntracked(
  cwd: string,
  width?: number
): { lines: string[]; empty: boolean } {
  const cols = width || (process.stdout.columns || 120);
  const rows = process.stdout.rows || 50;

  try {
    const check = execSync("git ls-files --others --exclude-standard", {
      cwd,
      encoding: "utf-8",
    }).trim();

    if (!check) return { lines: [], empty: true };

    // Run entirely inside script's PTY — no JS-side file list or quoting needed
    const inner = `stty cols ${cols} rows ${rows} 2>/dev/null; git ls-files --others --exclude-standard | while IFS= read -r f; do git diff --no-index -- /dev/null "$f" 2>/dev/null; done; true`;
    const scriptCmd =
      process.platform === "darwin"
        ? `script -q /dev/null bash -c '${inner}'`
        : `script -qc '${inner}' /dev/null`;

    const raw = execSync(scriptCmd, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
      env: { ...process.env, DELTA_PAGER: "cat", BAT_PAGER: "cat" },
      timeout: 10000,
    });

    const cleaned = cleanPtyOutput(raw);
    if (cleaned) return { lines: cleaned.split("\n"), empty: false };
    return { lines: [], empty: true };
  } catch {
    return { lines: [], empty: true };
  }
}

function runDiff(
  cwd: string,
  args: string,
  width?: number
): { lines: string[]; empty: boolean; error?: string } {
  const cols = width || (process.stdout.columns || 120);
  const rows = process.stdout.rows || 50;

  // Try with TTY via `script` so the configured pager (delta, etc.) runs with colors
  try {
    const gitCmd = `stty cols ${cols} rows ${rows} 2>/dev/null; git diff ${args}`.trim();
    const scriptCmd =
      process.platform === "darwin"
        ? `script -q /dev/null bash -c '${gitCmd}'`
        : `script -qec "${gitCmd}" /dev/null`;

    const raw = execSync(scriptCmd, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
      env: { ...process.env, DELTA_PAGER: "cat", BAT_PAGER: "cat" },
      timeout: 10000,
    });

    const cleaned = cleanPtyOutput(raw);
    if (cleaned) return { lines: cleaned.split("\n"), empty: false };
    return { lines: [], empty: true };
  } catch {
    // Fall back to raw git diff (no pager formatting)
    try {
      const raw = execSync(`git diff --color=always ${args}`, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf-8",
        env: { ...process.env, GIT_PAGER: "cat" },
      });
      if (!raw.trim()) return { lines: [], empty: true };
      return { lines: raw.split("\n"), empty: false };
    } catch (e: any) {
      return { lines: [], empty: true, error: e.message };
    }
  }
}

export default function (pi: ExtensionAPI) {
  async function showDiff(ctx: any, extraArgs?: string) {
    if (!ctx.hasUI) {
      ctx.ui.notify("Requires interactive mode", "error");
      return;
    }

    // Estimate overlay width (~95% of terminal minus padding)
    const overlayWidth = Math.floor((process.stdout.columns || 120) * 0.95) - 2;

    // If the user passed custom args to /diff, use those directly (no toggle)
    if (extraArgs?.trim()) {
      const result = runDiff(ctx.cwd, extraArgs, overlayWidth);
      if (result.error) {
        ctx.ui.notify("Not a git repo or git error", "error");
        return;
      }
      if (result.empty) {
        ctx.ui.notify("No diff output", "info");
        return;
      }
      return showOverlay(ctx, result.lines, extraArgs, false, overlayWidth);
    }

    // Find first non-empty mode: unstaged → staged → untracked
    for (const mode of MODE_ORDER) {
      const result =
        mode === "untracked"
          ? runUntracked(ctx.cwd, overlayWidth)
          : runDiff(ctx.cwd, modeArgs(mode), overlayWidth);

      if (result.empty) continue;
      if ("error" in result && result.error) {
        ctx.ui.notify("Not a git repo or git error", "error");
        return;
      }

      return showOverlay(ctx, result.lines, mode, true, overlayWidth);
    }

    ctx.ui.notify("No changes (staged, unstaged, or untracked)", "info");
  }

  function showOverlay(
    ctx: any,
    initialLines: string[],
    initialMode: DiffMode | string,
    allowToggle: boolean,
    diffWidth: number
  ) {
    let lines = initialLines;
    let scroll = 0;
    let mode: DiffMode = MODE_ORDER.includes(initialMode as DiffMode)
      ? (initialMode as DiffMode)
      : "unstaged";

    return ctx.ui.custom(
      (tui: any, theme: any, _kb: any, done: (v: null) => void) => {
        let cachedWidth = 0;

        function viewportHeight(): number {
          return Math.max(5, (process.stdout.rows || 24) - 8);
        }

        function clamp() {
          const max = Math.max(0, lines.length - viewportHeight());
          if (scroll > max) scroll = max;
          if (scroll < 0) scroll = 0;
        }

        return {
          render(width: number): string[] {
            const viewH = viewportHeight();
            clamp();

            const out: string[] = [];
            const border = (s: string) => theme.fg("border", s);

            // Top border
            out.push(truncateToWidth(border("─".repeat(width)), width));

            // Title
            const pos = `${scroll + 1}–${Math.min(scroll + viewH, lines.length)}/${lines.length}`;
            const title =
              theme.fg("accent", theme.bold(" git diff ")) +
              theme.fg("muted", `(${mode})`) +
              (allowToggle ? theme.fg("dim", "  tab: toggle") : "") +
              theme.fg("dim", `  ${pos}`);
            out.push(truncateToWidth(title, width));

            // Separator
            out.push(truncateToWidth(border("─".repeat(width)), width));

            // Diff content — only the visible slice
            const visible = lines.slice(scroll, scroll + viewH);
            for (let i = 0; i < viewH; i++) {
              out.push(
                truncateToWidth(i < visible.length ? " " + visible[i] : "", width)
              );
            }

            // Bottom border + help
            out.push(truncateToWidth(border("─".repeat(width)), width));
            out.push(
              truncateToWidth(
                theme.fg(
                  "dim",
                  " ↑↓/jk scroll • pgup/pgdn page • g/G top/bottom • tab mode • q close"
                ),
                width
              )
            );

            cachedWidth = width;
            return out;
          },

          handleInput(data: string) {
            const viewH = viewportHeight();

            if (
              matchesKey(data, "escape") ||
              data === "q" ||
              data === "Q"
            ) {
              done(null);
              return;
            }

            if (matchesKey(data, "up") || data === "k") {
              scroll--;
            } else if (matchesKey(data, "down") || data === "j") {
              scroll++;
            } else if (matchesKey(data, "pageUp")) {
              scroll -= viewH;
            } else if (matchesKey(data, "pageDown")) {
              scroll += viewH;
            } else if (matchesKey(data, "home") || data === "g") {
              scroll = 0;
            } else if (matchesKey(data, "end") || data === "G") {
              scroll = Math.max(0, lines.length - viewH);
            } else if (matchesKey(data, "tab") && allowToggle) {
              const idx = MODE_ORDER.indexOf(mode);
              mode = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
              const result =
                mode === "untracked"
                  ? runUntracked(ctx.cwd, diffWidth)
                  : runDiff(ctx.cwd, modeArgs(mode), diffWidth);
              lines = result.empty ? [`  (no ${mode} changes)`] : result.lines;
              scroll = 0;
            } else {
              return;
            }

            clamp();
            tui.requestRender();
          },

          invalidate() {
            cachedWidth = 0;
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center" as const,
          width: "95%",
          maxHeight: "95%",
        },
      }
    );
  }

  pi.registerShortcut("alt+g", {
    description: "Show git diff",
    handler: async (ctx) => {
      await showDiff(ctx);
    },
  });

  pi.registerCommand("diff", {
    description: "Show git diff (pass args like: /diff --cached HEAD~3)",
    handler: async (args, ctx) => {
      await showDiff(ctx, args);
    },
  });
}
