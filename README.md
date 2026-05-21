# agentkit

A personal collection of extensions for Pi and other agentic LLM tools.

## Installation

```bash
./install.sh
```

This installs everything:

| What | Where |
|------|-------|
| Pi extensions | `~/.pi/agent/extensions/` (symlinked) |
| [dcg](https://github.com/Dicklesworthstone/destructive_command_guard) config | `~/.config/dcg/` (symlinked) |

## Pi Extensions

Extensions for [pi](https://shittycodingagent.ai/), a TUI coding agent.

#### [auto-share](./pi-extensions/auto-share/)

Automates the built-in `/share` functionality — keeps a gist updated with the current session as you work, so you always have a shareable URL without manual exports.

Off by default. Enable per-project with `/auto-share on` or per-invocation with `pi --auto-share`. Requires `gh` CLI (`gh auth login`).

#### [answer](./pi-extensions/answer.ts)

Extract questions from the last assistant message into an interactive Q&A interface.

When the assistant asks multiple questions, `/answer` (or `Ctrl+.`) extracts them using a fast model (prefers Codex mini, falls back to Haiku), then presents a TUI for navigating and answering each question. Answers are compiled and submitted when complete.

#### [beans](./pi-extensions/beans.ts)

Integrates [Beans](https://github.com/hmans/beans) with pi by running `beans prime` in a project using Beans to track issues and injecting its output into the system prompt at session start and after compaction.

#### [custom-provider-claude-agent-sdk](./pi-extensions/custom-provider-claude-agent-sdk/)

Claude Agent SDK provider for pi using Anthropic's stable `query()` API. It registers the `claude-agent-sdk` provider and mirrors pi's built-in Anthropic Claude model list, so model IDs look like `claude-agent-sdk/claude-sonnet-4-6`.

The provider runs one live streaming SDK query per active pi session/branch. Claude sees pi tools through an in-process MCP server, but pi still executes the tools, renders them, records tool calls/results, and applies its normal permission and extension hooks. Built-in Claude Code tools are disabled so tool execution stays pi-native.

Session continuity is persisted in pi custom session entries and restored on resume. Structural boundaries such as `/compact`, `/new`, forks, and branch/tree switches close/reset the live SDK query as needed; model switching away and back closes the process without resetting SDK continuity for the same pi session. Print mode closes the live query after each final turn so CLI invocations exit.

#### [dcg](./pi-extensions/dcg.ts)

Bash tool override that integrates with [dcg (Destructive Command Guard)](https://github.com/Dicklesworthstone/destructive_command_guard).

Runs every bash command through dcg's hook mode before execution. When dcg blocks a potentially destructive command, presents an interactive decision UI:

- **Deny** (default): Block the command
- **Allow once**: Permit this specific invocation only
- **Allow always**: Add to project or global allowlist

Displays severity badges, detailed reasons, and tracks allow decisions in tool results. Falls back gracefully when dcg isn't available or returns unexpected output.

#### [handoff](./pi-extensions/handoff.ts)

Transfer context to a new focused session instead of compacting.

When sessions get long, compacting loses information. Handoff extracts what matters for your next task and creates a new session with a generated prompt containing:

- **Files**: Absolute paths to relevant files (targets 8-15 files)
- **Context**: Decisions made, constraints discovered, patterns established
- **Task**: Clear description of what to do next

The generated prompt appears in the editor for review before starting the new session.

```
/handoff now implement this for teams as well
/handoff execute phase one of the plan
/handoff check other places that need this fix
```

#### [kebab-command-aliases](./pi-extensions/kebab-command-aliases.ts)

Personal command-palette hygiene shim. Some pi extensions register many top-level kebab-case slash commands, which can clutter `/` autocomplete. This keeps the original commands available, but hides the kebab variants from autocomplete and exposes them as grouped subcommands instead — for example, `/example-status` becomes `/example status`.

This is a personal preference: it does not matter at all, except it really does when autocomplete is part of daily muscle memory. Rather than pester extension authors or maintain forks over taste, this shim makes pi behave the way I want locally. It monkey-patches pi internals to delegate grouped subcommands to the original command handlers, so it may break across pi releases. If the patch fails, it falls back to pi's default command list and shows a warning.

#### [messages](./pi-extensions/messages.ts)

Whimsical working messages while the agent thinks.

Replaces the default "Working..." message with randomly selected playful alternatives like "Percolating...", "Consulting the void...", "Herding pointers...", and "Reticulating splines...". Messages change on each turn for variety and delight.

#### [notify](./pi-extensions/notify.ts)

Desktop notifications when the agent finishes. Uses a cheap model to summarize what was done ("Wrote auth.ts") or what's blocking ("Need: which database?") so you know at a glance whether to come back.

Supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode. Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty.

#### [pi-bash-log-cleanup](./pi-extensions/pi-bash-log-cleanup.ts)

Silently removes stale `/tmp/pi-bash-*` full-output logs on session start and shutdown. This keeps Pi's truncated bash-output temp files from accumulating after sessions finish. Set `PI_BASH_LOG_CLEANUP_DEBUG=1` or `DEBUG=pi-bash-log-cleanup` to write cleanup activity to `~/.pi/agent/pi-bash-log-cleanup.log`.

#### [peon-ping](./pi-extensions/peon-ping/)

Sound notifications for pi using [peon-ping](https://github.com/PeonPing/peon-ping) / OpenPeon sound packs. Plays themed audio clips (Warcraft III Peon, GLaDOS, Duke Nukem, StarCraft, and more) on lifecycle events:

| Event | Sound category |
|-------|---------------|
| Session start | `session.start` — "Ready to work?" |
| Agent starts working | `task.acknowledge` — "Work, work." |
| Rapid prompts (≥3 in 10s) | `user.spam` — annoyed voice line |
| Agent finishes | `task.complete` — completion sound + desktop notification |

`/peon` opens a settings panel to toggle sounds, switch packs, adjust volume, and enable/disable individual categories. Browsing packs previews each one as you scroll. `/peon install` downloads the default 10 packs from the [peon-ping registry](https://peonping.github.io/registry/).

Cross-platform audio: `afplay` (macOS), `pw-play`/`paplay`/`ffplay`/`mpv`/`aplay` (Linux), PowerShell MediaPlayer (WSL). Also picks up existing packs from `~/.claude/hooks/peon-ping/` if you have a Claude Code installation. Config and state stored in `~/.config/peon-ping/`.

#### [ralph](./pi-extensions/ralph/)

**Experimental.** In-session iterative agent loop with fresh context per iteration, implementing [Geoffrey Huntley's Ralph Wiggum loop approach](https://ghuntley.com/ralph/).

Uses the pi SDK in-process (no subprocess, no RPC) to run repeated agent turns against a task file. Supports steering mid-iteration with queued user messages, follow-ups for next iteration, and comprehensive stats tracking (cost, tokens, duration). State persisted to `.ralph/<name>/` with iteration snapshots.

#### [read](./pi-extensions/read.ts)

Overrides the built-in read tool to handle directories gracefully.

When called on a directory, returns an `ls -la` listing with a hint instead of erroring with EISDIR. All other behavior delegates to the built-in implementation.

#### [rg-replace-warning](./pi-extensions/rg-replace-warning.ts)

Warns when `rg` is called with `-r` (which means `--replace`, not recursive). A common grep muscle memory mistake: `rg -rn "pattern"` silently replaces every match with the letter `n` instead of searching recursively with line numbers. `rg` is already recursive and shows line numbers by default.

Non-blocking — the command still runs, but a warning is prepended to the tool result so the LLM sees it and self-corrects.

#### [scouts](./pi-extensions/scouts/)

Scout subagent system — spins up focused small-model sessions with purpose-built tool sets, returning structured results with custom TUI rendering. Originally vendored from [pi-finder](https://github.com/default-anton/pi-finder) and [pi-librarian](https://github.com/default-anton/pi-librarian), now significantly expanded.

Features:
- **Model tier system**: Each scout has a default tier (`fast` or `capable`) overridable per-call via `modelTier` parameter
- **Usage-aware model selection**: Checks provider utilization via [vibeusage](https://github.com/joshuadavidthomas/vibeusage), deprioritizing providers above 85% and skipping those above 95%
- **Interleaved TUI rendering**: Tool calls and text rendered chronologically with collapsible markdown output
- **Turn budget enforcement**: Blocks tool use on the final turn to force a summary response

Registers five tools:

- **finder** (fast): Read-only workspace scout — locates files, directories, and components when exact locations are unknown
- **librarian** (fast, overridable to capable): External research scout — searches GitHub repos and the web, fetches code and documentation
- **oracle** (capable): Deep code analysis scout — traces data flow, analyzes architecture, finds patterns with precise file:line references. Read-only (restricted bash allowlist)
- **specialist** (capable): Skill-powered domain expert — loads an installed skill and applies it to a focused task with a configurable tool set
- **reviewer** (capable): Adversarial artifact review scout — judges concrete diffs, plans, design sketches, files/modules, or session briefs through one review lens per call: Hickey structural simplicity, Lowy volatility-based decomposition, Grug smol-brain changeability, Beck tidy-first change economics, Muratori semantic compression and actual work visibility, Lamport state-space and invariant reasoning, Ousterhout deep-module change complexity, or Feathers legacy-change safety. For multi-lens reviews, call `reviewer` multiple times in parallel. Returns evidence-backed findings and actions without leaking reviewer deliberation into the main session

Also registers `/review`, a command that gathers an artifact and calls the reviewer scout directly:

```text
/review
/review repo
/review design <sketch>
/review plan <plan-or-path>
/review diff [base] [--strict] [--hickey|--lowy|--grug|--beck|--muratori|--lamport|--ousterhout|--feathers]
/review staged
/review file <path>
/review boundary <path-or-description>
```

#### [skill-requires-path](./pi-extensions/skill-requires-path/)

Strips skills from the system prompt when their `metadata.requires-path` frontmatter field doesn't exist in the current project. Skills declare a path requirement under metadata (e.g., `metadata: { requires-path: ".jj/" }`) and the extension removes them from the LLM's context when the path is absent — the LLM never sees the skill.

#### [statusline](./pi-extensions/statusline.ts)

Starship-style custom footer with model context, git status, costs, and token stats.

#### [system-prompt-heading-levels](./pi-extensions/system-prompt-heading-levels.ts)

Demotes Markdown headings inside loaded context files, so `AGENTS.md` headings nest under Pi's system prompt sections instead of competing with them.

## Tools

### [dcg](./dcg/)

Custom packs for [dcg (Destructive Command Guard)](https://github.com/Dicklesworthstone/destructive_command_guard).

> **Note:** Custom pack loading is not yet functional in dcg. The `ExternalPackLoader` is implemented but not wired up. See [issue #24](https://github.com/Dicklesworthstone/destructive_command_guard/issues/24).

#### [devtools-noblock](./dcg/devtools-noblock.yaml)

Prevents agents from running blocking dev server commands that hang indefinitely.

Blocks commands like `npm run dev`, `vite`, `python manage.py runserver`, `docker compose up` (without `-d`), `cargo watch`, and various `just` recipes that start attached servers or follow logs.

When blocked, the agent is instructed to ask if the server is already running, and if not, offer to run it in a tmux session.

## Acknowledgements

Oracle and librarian scout design inspired by [Amp](https://ampcode.com/)'s agent architecture.

Answer pi extension from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache 2.0, Armin Ronacher).

Messages pi extension from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache 2.0, Armin Ronacher).

Notify pi extension from [pi-coding-agent examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions) (MIT, Mario Zechner).

Scouts pi extension from [default-anton/pi-finder](https://github.com/default-anton/pi-finder), [default-anton/pi-librarian](https://github.com/default-anton/pi-librarian), and [default-anton/pi-subagent-model-selection](https://github.com/default-anton/pi-subagent-model-selection) (MIT, Anton Kuzmenko).

Peon-ping pi extension uses the [peon-ping](https://github.com/PeonPing/peon-ping) sound pack registry and [OpenPeon](https://github.com/PeonPing/og-packs) sound packs (CC-BY-NC-4.0).

## License

agentkit is licensed under the MIT license. See the [`LICENSE`](LICENSE) file for more information.
