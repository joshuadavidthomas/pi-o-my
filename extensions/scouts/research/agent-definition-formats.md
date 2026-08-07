# Agent definition formats — portability survey

Surveyed 2026-07-06 (three librarian passes: Claude Code/Agent SDK docs, cross-harness docs, pi ecosystem repos). Feeds the definition format in `../DESIGN-dynamic-agents.md`.

## The convergent core

YAML frontmatter + markdown body as system prompt, with these fields, is shared by Claude Code, the first-party pi-mono subagent example, Gemini CLI, opencode, and community registries (subagents.sh, VoltAgent):

```yaml
---
name: code-reviewer        # or derived from filename (opencode, tintinweb, kky42)
description: ...           # universal, usually required — the routing hint
tools: Read, Grep, Glob    # CSV scalar (CC docs) or array (SDK/JSON, most others)
model: sonnet              # alias or full ID; omit = inherit
---
System prompt body...
```

Only `description` is truly universal. `model` is common but absent from Cursor rules, Codex AGENTS.md, and the AGENTS.md standard (those are instructions-only formats, not agent definitions).

## Per-harness summary

| Harness | Location | Fields beyond core | Tool selection |
|---|---|---|---|
| **Claude Code** | `.claude/agents/*.md`, `~/.claude/agents/` | `disallowedTools`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory` (user/project/local), `background`, `effort` (low..max), `isolation: worktree`, `color`, `initialPrompt` | allowlist; omitted = inherit **all**; `disallowedTools` denylist applied first; MCP patterns `mcp__server__*`; `Agent(type)` restricts spawnable subagents |
| **Claude Agent SDK** | programmatic `agents` map | same as CC, camelCase, `prompt` replaces body; `criticalSystemReminder_EXPERIMENTAL` (TS) | `tools: string[]` |
| **CC plugins** | plugin `agents/` dir | subset only — no `hooks`/`mcpServers`/`permissionMode`; scoped names `plugin:agent` | same |
| **opencode** | `.opencode/agents/*.md`, `~/.config/opencode/agents/` | `mode` (primary/subagent/all), `temperature`, `top_p`, `permission` (ask/allow/deny map), `steps`, `color`, `hidden`, `disable`; filename = name | `permission` map preferred; `tools: Record<name,bool>` deprecated |
| **Copilot / VS Code** | `.github/agents/*.agent.md`, `~/.copilot/agents` | `argument-hint`, `agents` (subagent allowlist), `user-invocable`, `disable-model-invocation`, `target`, `mcp-servers`, `handoffs`, `hooks`; `model` can be priority array | `tools` array with aliases (`read`, `edit`, `execute`, `web`…); omitted or `["*"]` = all; `[]` = none; **unknown names ignored** |
| **Gemini CLI** | `.gemini/agents/*.md`, `~/.gemini/agents/` | `kind` (local/remote), `temperature`, `max_turns`, `timeout_mins`, `mcpServers` inline | `tools` array, wildcards `mcp_*`; omitted = inherit parent |
| **Roo/Cline** | `.roomodes` YAML/JSON (not markdown) | `slug`, `roleDefinition`, `whenToUse`, `customInstructions` | `groups`: read/edit/command/mcp; `edit` restrictable by `fileRegex` |
| **Cursor** | `.cursor/rules/*.mdc` | `globs`, `alwaysApply` — rules/context selection, not agents | none |
| **Codex / AGENTS.md** | `AGENTS.md` | none — instructions-only markdown, "no required fields" | none |
| **AFM (wso2)** | `.afm.md` | `spec_version`, `author`, `license`, structured `model {name,provider,url}`, `tools.mcp[]`, `interfaces` | MCP-centric allow/deny |

## Pi ecosystem

| Extension | Name source | Notable fields | Tool/extension selection |
|---|---|---|---|
| **pi-mono first-party example** | `name` required | core four only | CSV builtin allowlist |
| **tintinweb/pi-subagents** | filename | `display_name`, `thinking`, `max_turns`, `persist_session`, `prompt_mode`, `inherit_context`, `run_in_background`, `memory`, `isolation: worktree`, snake_case | CSV **or** YAML list; `ext:<extension>/<tool>` selectors; `extensions`/`exclude_extensions` |
| **nicobailon/pi-subagents** | `name` required | `package` namespace, `fallbackModels`, `systemPromptMode`, `defaultContext` (fresh/fork), `maxSubagentDepth`, `toolBudget`, camelCase | CSV; `mcp:` selectors; `subagentOnlyExtensions` child-only extension loading |
| **melihmucuk/pi-crew** | `name` required | `thinking`, `compaction`, `interactive` | CSV or list; fixed builtin set only |
| **kky42/pi-flow** | filename | `backend` (pi/codex/claude), `thinking` | CSV, pi backend only |
| **ruizrica/agent-pi** | `name` required | model lives in separate `models.json`, not frontmatter | raw CSV |
| **KristjanPikhof/Pi-Agents-Team** | `name` | markdown profiles need `prompt` field (body unused!); primary config is JSON with `access.*` objects | `access.tools`, `access.extensions`, `writePolicy` |
| **pi SKILL.md (first-party)** | dir-name fallback | `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation`; **unknown fields ignored** | space-delimited `allowed-tools` (experimental) |

## What scouts adopted (and why)

- **CC field names** (`name`/`description`/`tools`/`model`/`skills`) — dominant convention, fable-trained, matches pi-mono first-party.
- **Filename fallback for `name`** — opencode/tintinweb/kky42; subsumes CC's required-name.
- **CSV or YAML list for `tools`** — both appear in the wild; tintinweb/pi-crew already accept both.
- **Unknown frontmatter ignored** — pi SKILL.md precedent; makes CC files (`permissionMode`, `color`, `maxTurns`…) drop-in loadable.
- **Unknown tool names ignored with warning** — Copilot's documented behavior.
- **User definition locations** `.pi/agents/` + `~/.pi/agent/agents/` — pi ecosystem convention.

Conscious divergences: omitted `tools` = base pool (not CC's inherit-all); `Edit`/`Write` in an explicit allowlist authorize but do not activate mutation (the call site must still provide the `mutation` object); CC's `isolation: worktree` frontmatter ignored (that's call-site `mutation.isolation`); no `temperature`/`thinking` (poorly portable; call-site `effort` owns it).

Full librarian evidence logs (transient): `~/.cache/pi/tmp/pi-librarian-{424b0c2784cc4863,bdb5f184dfe0b567,e5d27e6886a48cf5}.log`.
