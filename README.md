# Pi-O-My

There are many Pi setups, but this one is mine. [Please don’t set it on fire.](https://en.wikipedia.org/wiki/Pie-O-My)

![Pi-O-My](./assets/pi-o-my.png)

## Installation

### Install everything

```bash
pi install git:github.com/joshuadavidthomas/pi-o-my
```

This installs the whole enchilada: every extension declared by the package.

### Install selected extensions

Add a filtered package entry to `~/.pi/agent/settings.json` for global installs, or `.pi/settings.json` for a project-local install:

```json
{
  "packages": [
    {
      "source": "git:github.com/joshuadavidthomas/pi-o-my",
      "extensions": ["extensions/answer.ts"]
    }
  ]
}
```

Load multiple extensions by listing each entrypoint:

```json
{
  "packages": [
    {
      "source": "git:github.com/joshuadavidthomas/pi-o-my",
      "extensions": [
        "extensions/answer.ts",
        "extensions/notify.ts",
        "extensions/scouts/index.ts"
      ]
    }
  ]
}
```

If you already ran `pi install`, replace the simple package string in settings with the filtered object.

## Extensions

#### [auto-share](./extensions/auto-share/)

Automates the built-in `/share` functionality — keeps a gist updated with the current session as you work, so you always have a shareable URL without manual exports.

Off by default. Enable per-project with `/auto-share on` or per-invocation with `pi --auto-share`. Requires `gh` CLI (`gh auth login`).

#### [answer](./extensions/answer.ts)

Extract questions from the last assistant message into an interactive Q&A interface.

When the assistant asks multiple questions, `/answer` (or `Ctrl+.`) extracts them using a fast model (prefers Codex mini, falls back to Haiku), then presents a TUI for navigating and answering each question. Answers are compiled and submitted when complete.

#### [custom-provider-claude-agent-sdk](./extensions/custom-provider-claude-agent-sdk/)

Claude Agent SDK provider for pi using Anthropic's stable `query()` API. It registers the `claude-agent-sdk` provider, mirrors pi's built-in Anthropic Claude model list, and adds Claude Opus 5. Model IDs look like `claude-agent-sdk/claude-opus-5`.

The provider runs one live streaming SDK query per active pi session/branch. Claude sees pi tools through an in-process MCP server, but pi still executes the tools, renders them, records tool calls/results, and applies its normal permission and extension hooks. Built-in Claude Code tools are disabled so tool execution stays pi-native.

Session continuity is persisted in pi custom session entries and restored on resume. After `/compact`, pi remains the compaction owner and the provider seeds Pi's summary and retained recent messages inside Claude's native compacted-session envelope. Tree navigation uses the same envelope to preseed a fresh Claude session from the selected Pi branch. Only the next user prompt is submitted as a live request. Optional tree summaries run on an authenticated non-Claude model so the Claude subscription request never receives a transcript-summarization prompt.

This avoids presenting prior assistant/tool output as an ordinary new user request, which Fable rejects. Private preseeded transcripts live under the configured pi agent directory at `state/claude-agent-sdk/sessions/`. They are not removed automatically because old pi branches may still reference them.

The transcript encoder targets the pinned Claude Agent SDK/CLI format. Run `PI_CLAUDE_AGENT_SDK_RUN_INTEGRATION=1 bun test ./extensions/custom-provider-claude-agent-sdk/sdk/session-store.integration.test.ts` before upgrading that dependency. Ordinary tests skip this authenticated gate.

Structural boundaries such as `/new`, forks, and branch/tree switches close or rebuild the live SDK query as needed. Model switching away and back closes the process without resetting SDK continuity for the same pi session. Print mode closes the live query after each final turn so CLI invocations exit.

#### [dcg](./extensions/dcg.ts)

Bash tool override that integrates with [dcg (Destructive Command Guard)](https://github.com/Dicklesworthstone/destructive_command_guard).

Runs every bash command through dcg's hook mode before execution. When dcg blocks a potentially destructive command, presents an interactive decision UI:

- **Deny** (default): Block the command
- **Allow once**: Permit this specific invocation only
- **Allow always**: Add to project or global allowlist

Displays severity badges, detailed reasons, and tracks allow decisions in tool results. Falls back gracefully when dcg isn't available or returns unexpected output.

#### Auto mode

On by default. Disable with `--no-dcg-auto` or `DCG_AUTO=0`. When dcg blocks a command, a model judge reads the recent conversation for user intent and the blocked command, then answers:

- **allow** — the command runs, marked `allowed (auto)` in the result with the judge's reason
- **deny** or **ask** — the interactive decision prompt appears as usual, now showing the judge's verdict

The judge only short-circuits the prompt. dcg still guards every command, auto decisions last one invocation (never written to the allowlist), and any judge failure falls back to the prompt. The judge uses the session model, or `DCG_AUTO_MODEL=provider/modelId` for a specific one.

#### [editor](./extensions/editor.ts)

Widens pi's autocomplete column so long model and provider IDs are easier to read in pickers like `/model`.

#### [handoff](./extensions/handoff.ts)

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

#### [kebab-command-aliases](./extensions/kebab-command-aliases.ts)

Personal command-palette hygiene shim. Some pi extensions register many top-level kebab-case slash commands, which can clutter `/` autocomplete. This keeps the original commands available, but hides the kebab variants from autocomplete and exposes them as grouped subcommands instead — for example, `/example-status` becomes `/example status`.

This is a personal preference: it does not matter at all, except it really does when autocomplete is part of daily muscle memory. Rather than pester extension authors or maintain forks over taste, this shim makes pi behave the way I want locally. It monkey-patches pi internals to delegate grouped subcommands to the original command handlers, so it may break across pi releases. If the patch fails, it falls back to pi's default command list and shows a warning.

#### [messages](./extensions/messages.ts)

Whimsical working messages while the agent thinks.

Replaces the default "Working..." message with randomly selected playful alternatives like "Percolating...", "Consulting the void...", "Herding pointers...", and "Reticulating splines...". Messages change on each turn for variety and delight.

#### [notify](./extensions/notify.ts)

Desktop notifications when the agent finishes. Uses a cheap model to summarize what was done ("Wrote auth.ts") or what's blocking ("Need: which database?") so you know at a glance whether to come back.

Supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode. Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty.

#### [pi-bash-log-cleanup](./extensions/pi-bash-log-cleanup.ts)

Silently removes stale `/tmp/pi-bash-*` full-output logs on session start and shutdown. This keeps Pi's truncated bash-output temp files from accumulating after sessions finish. Set `PI_BASH_LOG_CLEANUP_DEBUG=1` or `DEBUG=pi-bash-log-cleanup` to write cleanup activity to `~/.pi/agent/pi-bash-log-cleanup.log`.

#### [peon-ping](./extensions/peon-ping/)

Sound notifications for pi using [peon-ping](https://github.com/PeonPing/peon-ping) / OpenPeon sound packs. Plays themed audio clips (Warcraft III Peon, GLaDOS, Duke Nukem, StarCraft, and more) on lifecycle events:

| Event | Sound category |
|-------|---------------|
| Session start | `session.start` — "Ready to work?" |
| Agent starts working | `task.acknowledge` — "Work, work." |
| Rapid prompts (≥3 in 10s) | `user.spam` — annoyed voice line |
| Agent finishes | `task.complete` — completion sound + desktop notification |

`/peon` opens a settings panel to toggle sounds, switch packs, adjust volume, and enable/disable individual categories. Browsing packs previews each one as you scroll. `/peon install` downloads the default 10 packs from the [peon-ping registry](https://peonping.github.io/registry/).

Cross-platform audio: `afplay` (macOS), `pw-play`/`paplay`/`ffplay`/`mpv`/`aplay` (Linux), PowerShell MediaPlayer (WSL). Also picks up existing packs from `~/.claude/hooks/peon-ping/` if you have a Claude Code installation. Config and state stored in `~/.config/peon-ping/`.

#### [ralph](./extensions/ralph/)

**Experimental.** In-session iterative agent loop with fresh context per iteration, implementing [Geoffrey Huntley's Ralph Wiggum loop approach](https://ghuntley.com/ralph/).

Uses the pi SDK in-process (no subprocess, no RPC) to run repeated agent turns against a task file. Supports steering mid-iteration with queued user messages, follow-ups for next iteration, and comprehensive stats tracking (cost, tokens, duration). State persisted to `.ralph/<name>/` with iteration snapshots.

#### [read](./extensions/read.ts)

Overrides the built-in read tool to handle directories gracefully.

When called on a directory, returns an `ls -la` listing with a hint instead of erroring with EISDIR. All other behavior delegates to the built-in implementation.

#### [rg-replace-warning](./extensions/rg-replace-warning.ts)

Warns when `rg` is called with `-r` (which means `--replace`, not recursive). A common grep muscle memory mistake: `rg -rn "pattern"` silently replaces every match with the letter `n` instead of searching recursively with line numbers. `rg` is already recursive and shows line numbers by default.

Non-blocking — the command still runs, but a warning is prepended to the tool result so the LLM sees it and self-corrects.

#### [share-md](./extensions/share-md.ts)

Adds `/share-md`, which exports the active session branch as Markdown and uploads it as a secret GitHub gist. Requires the `gh` CLI (`gh auth login`).

#### [scouts](./extensions/scouts/)

Scout subagent system — spins up focused sessions with purpose-built tool sets, returning structured results with custom TUI rendering. Originally vendored from [pi-finder](https://github.com/default-anton/pi-finder) and [pi-librarian](https://github.com/default-anton/pi-librarian), now significantly expanded.

Features:
- **Fixed model defaults with fallbacks**: Each scout declares an ordered target list. The first available model wins. Use Pi-specific config for model routing instead of per-call model overrides.
- **User model config**: Override scout model target lists globally with `~/.pi/agent/scouts.jsonc` or per project with `.pi/scouts.jsonc` in the current directory or an ancestor.
- **Interleaved TUI rendering**: Tool calls and text render chronologically with collapsible markdown output.
- **Timeout enforcement**: Scouts run with a 10-minute wall-clock timeout by default.

Model config example:

```jsonc
{
  "scouts": {
    "oracle": {
      "models": [
        { "model": "openai-codex/gpt-5.5", "thinkingLevel": "high" },
        { "model": "openai/gpt-5.5", "thinkingLevel": "high" }
      ]
    }
  }
}
```

Registers six tools:

- **finder**: Workspace scout — locates files, directories, and components when exact locations are unknown.
- **librarian**: External research scout — searches GitHub repos and the web, fetches code and documentation.
- **oracle**: Deep code analysis scout — traces data flow, analyzes architecture, finds patterns with precise file:line references. Read-only with a restricted bash allowlist.
- **specialist**: Skill-powered domain expert — loads an installed skill and applies it to a focused task with a configurable tool set. Skill frontmatter can set its preferred model.
- **reviewer**: Adversarial artifact review scout — judges concrete diffs, plans, design sketches, files/modules, or session briefs through one review lens per call: Hickey structural simplicity, Lowy volatility-based decomposition, Grug smol-brain changeability, Beck tidy-first change economics, Muratori semantic compression and actual work visibility, Lamport state-space and invariant reasoning, Ousterhout deep-module change complexity, or Feathers legacy-change safety. For multi-lens reviews, call `reviewer` multiple times in parallel.
- **worker**: Bounded implementation worker — applies a concrete implementation brief or validation-only task with read/edit/write/bash tools, then reports changed files and verification. Supports `effort: "quick" | "standard" | "thorough"` to set low/medium/high reasoning for the implementation pass. It stops when the bounded task is complete, blocked, out of scope, or the 10-minute timeout is reached. Use finder/oracle/librarian before worker when the target or design is unclear; only one worker runs at a time.

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

#### [skill-requires-path](./extensions/skill-requires-path/)

Strips skills from the system prompt when their `metadata.requires-path` frontmatter field doesn't exist in the current project. Skills declare a path requirement under metadata (e.g., `metadata: { requires-path: ".jj/" }`) and the extension removes them from the LLM's context when the path is absent — the LLM never sees the skill.

#### [skill-usage](./extensions/skill-usage.ts)

Tracks `SKILL.md` reads and writes aggregate skill usage stats to `~/.pi/agent/skill-usage.json`.

#### [statusline](./extensions/statusline.ts)

Starship-style custom footer with model context, git status, costs, and token stats.

#### [titlebar-spinner](./extensions/titlebar-spinner.ts)

Shows a braille spinner in the terminal title while the agent is working, then restores the title to `π - <cwd>` or `π - <session> - <cwd>` when idle.

#### [system-prompt-heading-levels](./extensions/system-prompt-heading-levels.ts)

Demotes Markdown headings inside loaded context files, so `AGENTS.md` headings nest under Pi's system prompt sections instead of competing with them.

## Acknowledgements

Oracle and librarian scout design inspired by [Amp](https://ampcode.com/)'s agent architecture.

Answer pi extension from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache 2.0, Armin Ronacher).

Messages pi extension from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache 2.0, Armin Ronacher).

Notify pi extension from [pi-coding-agent examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions) (MIT, Mario Zechner).

Scouts pi extension from [default-anton/pi-finder](https://github.com/default-anton/pi-finder), [default-anton/pi-librarian](https://github.com/default-anton/pi-librarian), and [default-anton/pi-subagent-model-selection](https://github.com/default-anton/pi-subagent-model-selection) (MIT, Anton Kuzmenko).

Peon-ping pi extension uses the [peon-ping](https://github.com/PeonPing/peon-ping) sound pack registry and [OpenPeon](https://github.com/PeonPing/og-packs) sound packs (CC-BY-NC-4.0).

## License

pi-o-my is licensed under the MIT license. See the [`LICENSE`](LICENSE) file for more information.
