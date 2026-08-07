/**
 * Ralph Loop Extension
 *
 * Provides an in-session iterative agent loop with fresh context per iteration.
 * Uses the pi SDK (AgentSession) in-process — no subprocess, no RPC.
 *
 * Commands: /ralph start, stop, status, list, clean
 */

import type {
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	CustomEditor,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { LoopEngine } from "./loop-engine.ts";
import type { IterationStats, LoopConfig, LoopState } from "./types.ts";
import { loopDir } from "./types.ts";

// ToolExecutionComponent only calls requestRender() on its TUI dependency.
// These components render completed, immutable tool results, so it can be a no-op.
const renderOnlyTui = { requestRender() {} } as TUI;

/**
 * Strips exactly one leading empty line from a component's render output.
 * Used to remove the internal Spacer(1) from ToolExecutionComponent and
 * AssistantMessageComponent — the CustomMessageComponent wrapper already
 * provides one, so the inner one creates double spacing.
 */
class StripLeadingSpacer implements Component {
	constructor(private inner: Component) {}
	invalidate() {
		this.inner.invalidate();
	}
	render(width: number): string[] {
		const lines = this.inner.render(width);
		if (lines.length > 0 && lines[0].trim() === "") {
			return lines.slice(1);
		}
		return lines;
	}
}

/**
 * Custom editor for the ralph loop. Intercepts Enter, Alt+Enter, and Esc
 * in handleInput() so they route to the loop engine instead of pi's parent
 * agent.
 *
 * Why we intercept here instead of using onAction/onEscape:
 * pi's setEditorComponent() post-processing copies all default action
 * handlers onto the custom editor AFTER the factory returns, silently
 * overwriting any handlers the extension registered. So we must handle
 * these keys at a higher priority — before super.handleInput() dispatches
 * to the overwritten handlers.
 */
class RalphEditor extends CustomEditor {
	onSteer?: (text: string) => void;
	onFollowUp?: (text: string) => void;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
	}

	handleInput(data: string): void {
		// Alt+Enter → queue follow-up for next iteration
		if (matchesKey(data, Key.alt("enter"))) {
			const text = this.getText().trim();
			if (text && this.onFollowUp) {
				this.onFollowUp(text);
				this.setText("");
			}
			return;
		}

		// Enter (not Shift+Enter) → steer current iteration
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			const text = this.getText().trim();
			if (text && this.onSteer) {
				this.onSteer(text);
				this.setText("");
			}
			return;
		}

		// Esc → kill the loop (when not showing autocomplete)
		if (matchesKey(data, Key.escape) && !this.isShowingAutocomplete()) {
			this.onEscape?.();
			return;
		}

		super.handleInput(data);
	}
}

class LabeledBorder implements Component {
	constructor(
		private label: string,
		private color: (s: string) => string,
	) {}
	invalidate() {}
	render(width: number): string[] {
		const padded = ` ${this.label} `;
		const left = 3;
		const right = Math.max(1, width - left - padded.length);
		return [this.color("─".repeat(left) + padded + "─".repeat(right))];
	}
}

function renderAsAssistantMessage(text: string): AssistantMessageComponent {
	return new AssistantMessageComponent(
		{
			role: "assistant",
			content: [{ type: "text", text }],
			api: "messages",
			provider: "anthropic",
			model: "unknown",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
		true,
		getMarkdownTheme(),
	);
}

function fmtDuration(ms: number): string {
	const secs = Math.round(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const remainSecs = secs % 60;
	if (mins < 60) return `${mins}m${remainSecs}s`;
	const hours = Math.floor(mins / 60);
	const remainMins = mins % 60;
	return `${hours}h${remainMins}m`;
}

function fmtCost(cost: number): string {
	return `$${cost.toFixed(3)}`;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function fmtIterStats(stats: IterationStats): string {
	const duration =
		stats.durationMs >= 60_000
			? `${Math.floor(stats.durationMs / 60_000)}m${Math.round((stats.durationMs % 60_000) / 1000)}s`
			: `${Math.round(stats.durationMs / 1000)}s`;
	return `${duration} │ ${stats.turns} turns │ ${fmtTokens(stats.tokensIn)} in ${fmtTokens(stats.tokensOut)} out │ ${fmtCost(stats.cost)}`;
}

/** Read state.json from a ralph loop directory, or null if missing/invalid */
function readLoopState(dir: string): LoopState | null {
	const statePath = join(dir, "state.json");
	try {
		return JSON.parse(readFileSync(statePath, "utf-8")) as LoopState;
	} catch {
		return null;
	}
}

/** List all local .ralph/<name>/ loop directories in the given project cwd */
function listLocalLoops(
	cwd: string,
): Array<{ name: string; dir: string; state: LoopState | null }> {
	const ralphRoot = join(cwd, ".ralph");
	if (!existsSync(ralphRoot)) return [];

	const results: Array<{
		name: string;
		dir: string;
		state: LoopState | null;
	}> = [];
	try {
		for (const entry of readdirSync(ralphRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = join(ralphRoot, entry.name);
			if (!existsSync(join(dir, "config.json"))) continue;
			results.push({
				name: entry.name,
				dir,
				state: readLoopState(dir),
			});
		}
	} catch {
		// ignore
	}
	return results;
}

interface ParsedStartArgs {
	name: string;
	maxIterations: number;
	model?: string;
	provider?: string;
	thinking?: string;
	taskFile?: string;
}

function parseStartArgs(argsStr: string): ParsedStartArgs | string {
	const tokens = argsStr.trim().split(/\s+/);
	if (tokens.length === 0 || tokens[0] === "") {
		return "Missing loop name. Usage: /ralph start <name> [options]";
	}

	const result: ParsedStartArgs = {
		name: tokens[0],
		maxIterations: 50,
	};

	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result.name)) {
		return `Invalid loop name "${result.name}". Use alphanumeric characters, dots, hyphens, and underscores.`;
	}

	let i = 1;
	while (i < tokens.length) {
		const token = tokens[i];

		if (
			(token === "--max-iterations" || token === "-n") &&
			i + 1 < tokens.length
		) {
			const val = parseInt(tokens[i + 1], 10);
			if (isNaN(val) || val < 0) {
				return `Invalid max-iterations: "${tokens[i + 1]}". Must be a non-negative integer (0 = unlimited).`;
			}
			result.maxIterations = val;
			i += 2;
		} else if (
			(token === "--model" || token === "-m") &&
			i + 1 < tokens.length
		) {
			result.model = tokens[i + 1];
			i += 2;
		} else if (token === "--provider" && i + 1 < tokens.length) {
			result.provider = tokens[i + 1];
			i += 2;
		} else if (token === "--thinking" && i + 1 < tokens.length) {
			result.thinking = tokens[i + 1];
			i += 2;
		} else if (token === "--task" && i + 1 < tokens.length) {
			result.taskFile = tokens[i + 1];
			i += 2;
		} else {
			return `Unknown option: "${token}". Options: --max-iterations/-n, --model/-m, --provider, --thinking, --task`;
		}
	}

	return result;
}

let activeLoop: {
	name: string;
	dir: string;
	engine: LoopEngine;
	ctx: ExtensionCommandContext;
} | null = null;

// Pending messages shown as sticky widget above editor until consumed.
// Steer texts are queued (not a single value) to handle rapid consecutive steers.
let pendingSteerTexts: string[] = [];
let pendingFollowupText: string | null = null;

// Rendering state for the active loop's event stream
let currentAssistantText = "";
const pendingToolArgs = new Map<
	string,
	{ toolName: string; args: Record<string, unknown> }
>();

function resetRenderingState(): void {
	currentAssistantText = "";
	pendingToolArgs.clear();
}

export default function (pi: ExtensionAPI) {
	/** Flush any accumulated assistant text as a rendered message. */
	function flushAssistantText(): void {
		if (currentAssistantText.trim()) {
			pi.sendMessage({
				customType: "ralph_assistant",
				content: currentAssistantText.trim(),
				display: true,
				details: {},
			});
		}
		currentAssistantText = "";
	}
	// Message Renderers

	pi.registerMessageRenderer(
		"ralph_iteration",
		(message, _options, theme) => {
			const color = (s: string) => theme.fg("borderMuted", s);
			return new LabeledBorder(String(message.content), color);
		},
	);

	pi.registerMessageRenderer("ralph_tool", (message) => {
		const { toolName, args, result, isError, cwd } = message.details as {
			toolName: string;
			args: Record<string, unknown>;
			result?: { content: Array<{ type: string; text?: string }> };
			isError?: boolean;
			cwd?: string;
		};

		const comp = new ToolExecutionComponent(
			toolName,
			String(message.timestamp),
			args,
			{ showImages: false },
			undefined,
			renderOnlyTui,
			cwd ?? process.cwd(),
		);
		comp.setArgsComplete();

		if (result) {
			comp.updateResult(
				{ ...result, isError: isError ?? false },
				false,
			);
		}

		return new StripLeadingSpacer(comp);
	});

	pi.registerMessageRenderer("ralph_assistant", (message) => {
		return new StripLeadingSpacer(
			renderAsAssistantMessage(String(message.content)),
		);
	});

	pi.registerMessageRenderer("ralph_user", (message) => {
		return new StripLeadingSpacer(
			new UserMessageComponent(String(message.content), getMarkdownTheme()),
		);
	});

	// Shutdown

	pi.on("session_shutdown", () => {
		if (activeLoop) {
			uninstallLoopEditor(activeLoop.ctx);
			activeLoop.engine.kill();
			activeLoop = null;
		}
	});

	// Input Routing — custom editor replaces pi's default while loop is active.
	// All key routing (Enter, Alt+Enter, Esc) is handled in RalphEditor.handleInput()
	// at a higher priority than super.handleInput(), because pi's setEditorComponent
	// post-processing overwrites onAction/onEscape handlers with its own defaults.

	function installLoopEditor(ctx: ExtensionCommandContext, engine: LoopEngine): void {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new RalphEditor(tui, theme, keybindings);

			editor.onSteer = (text: string) => {
				pendingSteerTexts.push(text);
				updateWidget(ctx);
				engine.nudge(text);
			};

			editor.onFollowUp = (text: string) => {
				pendingFollowupText = text;
				updateWidget(ctx);
				engine.queueForNextIteration(text);
			};

			editor.onEscape = () => {
				engine.kill();
			};

			return editor;
		});
	}

	function uninstallLoopEditor(ctx: ExtensionCommandContext): void {
		ctx.ui.setEditorComponent(undefined);
	}

	// Event Rendering — uses typed AgentSessionEvent

	function handleSessionEvent(
		event: AgentSessionEvent,
		cwd: string,
	): void {
		if (event.type === "tool_execution_start") {
			pendingToolArgs.set(event.toolCallId, {
				toolName: event.toolName,
				args: (event.args ?? {}) as Record<string, unknown>,
			});
		} else if (event.type === "tool_execution_end") {
			const pending = pendingToolArgs.get(event.toolCallId);
			pendingToolArgs.delete(event.toolCallId);

			pi.sendMessage({
				customType: "ralph_tool",
				content: event.toolName,
				display: true,
				details: {
					toolName: event.toolName,
					args: pending?.args ?? {},
					result: event.result,
					isError: event.isError,
					cwd,
				},
			});
		} else if (event.type === "message_update") {
			if (event.assistantMessageEvent.type === "text_delta") {
				currentAssistantText += event.assistantMessageEvent.delta;
			}
		} else if (event.type === "message_start") {
			// Flush any accumulated assistant text from the previous message
			// before starting a new one. This prevents text from bleeding
			// across message boundaries (e.g., when a steer creates a new turn).
			flushAssistantText();

			const msg = event.message;

			// When a steer is delivered, the session emits a message_start
			// with role "user". Insert our user message at exactly this
			// point — right where the agent actually receives it.
			if ("role" in msg && msg.role === "user" && pendingSteerTexts.length > 0) {
				const steerText = pendingSteerTexts.shift()!;
				pi.sendMessage({
					customType: "ralph_user",
					content: steerText,
					display: true,
					details: {},
				});
				if (activeLoop) {
					updateWidget(activeLoop.ctx);
				}
			}
		} else if (event.type === "message_end") {
			flushAssistantText();
		}
	}

	// Widget Management

	function updateWidget(ctx: ExtensionCommandContext): void {
		if (!activeLoop) {
			ctx.ui.setWidget("ralph", undefined);
			return;
		}

		const state = activeLoop.engine.getState();
		const name = activeLoop.name;

		const maxStr =
			state.config.maxIterations > 0
				? `/${state.config.maxIterations}`
				: "";

		let statusLine: string;
		if (state.status === "starting" || state.iteration === 0) {
			statusLine = `ralph: ${name} │ starting`;
		} else {
			const cost =
				state.stats.cost > 0
					? ` │ ${fmtCost(state.stats.cost)}`
					: "";
			const duration =
				state.stats.durationMs > 0
					? ` │ ${fmtDuration(state.stats.durationMs)}`
					: "";
			statusLine = `ralph: ${name} │ ${state.status} │ iter ${state.iteration}${maxStr}${duration}${cost}`;
		}

		const steers = [...pendingSteerTexts];
		const followup = pendingFollowupText;

		ctx.ui.setWidget("ralph", (_tui, theme) => ({
			render(width: number): string[] {
				const lines: string[] = [];

				for (const steer of steers) {
					lines.push(theme.fg("dim", ` Steering: ${steer}`));
				}
				if (followup) {
					lines.push(theme.fg("dim", ` Follow-up: ${followup}`));
				}

				lines.push(theme.fg("accent", statusLine));
				return lines;
			},
			invalidate() {},
		}));
	}

	function clearWidgetAfterDelay(ctx: ExtensionCommandContext): void {
		setTimeout(() => {
			if (
				!activeLoop ||
				activeLoop.engine.currentStatus === "completed" ||
				activeLoop.engine.currentStatus === "stopped" ||
				activeLoop.engine.currentStatus === "error"
			) {
				ctx.ui.setWidget("ralph", undefined);
			}
		}, 5000);
	}

	// Command Registration

	pi.registerCommand("ralph", {
		description:
			"Ralph loop extension. Subcommands: start, stop, kill, status, list, clean",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const subcommands = [
					"start",
					"stop",
					"kill",
					"status",
					"list",
					"clean",
				];
				return subcommands
					.filter((s) => s.startsWith(parts[0] || ""))
					.map((s) => ({ value: s, label: s }));
			}
			const sub = parts[0];
			if (["stop", "kill", "status"].includes(sub)) {
				const namePrefix = parts[1] || "";
				const loops = listLocalLoops(process.cwd());
				const names = loops
					.map((l) => l.name)
					.filter((n) => n.startsWith(namePrefix));
				if (activeLoop && activeLoop.name.startsWith(namePrefix)) {
					if (!names.includes(activeLoop.name))
						names.unshift(activeLoop.name);
				}
				return names.map((n) => ({
					value: `${sub} ${n}`,
					label: n,
				}));
			}
			return null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0] || "";
			const subArgs = parts.slice(1).join(" ");

			switch (subcommand) {
				case "start":
					return handleStart(pi, ctx, subArgs);
				case "stop":
					return handleStop(ctx, subArgs);
				case "kill":
					return handleKill(ctx, subArgs);
				case "status":
					return handleStatus(pi, ctx, subArgs);
				case "list":
					return handleList(pi, ctx);
				case "clean":
					return handleClean(ctx);
				default:
					ctx.ui.notify(
						"Usage: /ralph <start|stop|kill|status|list|clean> [args]",
						"info",
					);
			}
		},
	});

	// Command Handlers

	async function handleStart(
		pi: ExtensionAPI,
		ctx: ExtensionCommandContext,
		argsStr: string,
	) {
		const parsed = parseStartArgs(argsStr);
		if (typeof parsed === "string") {
			ctx.ui.notify(parsed, "error");
			return;
		}

		if (activeLoop) {
			ctx.ui.notify(
				`Loop "${activeLoop.name}" is already running. Stop it first with /ralph stop`,
				"warning",
			);
			return;
		}

		const cwd = ctx.cwd;
		const dir = loopDir(cwd, parsed.name);

		// Check if loop already exists on disk and was running
		const existingState = readLoopState(dir);
		if (existingState && existingState.status === "running") {
			// No pid to check anymore — in-process sessions don't survive restarts.
			// Safe to reuse since we're in a fresh pi session.
		}

		mkdirSync(join(dir, "iterations"), { recursive: true });

		// Handle task file
		const taskFilePath = join(dir, "task.md");
		if (parsed.taskFile) {
			const sourcePath = resolve(cwd, parsed.taskFile);
			if (!existsSync(sourcePath)) {
				ctx.ui.notify(
					`Task file not found: ${sourcePath}`,
					"error",
				);
				return;
			}
			const content = readFileSync(sourcePath, "utf-8");
			writeFileSync(taskFilePath, content);
		} else if (!existsSync(taskFilePath)) {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"No UI available. Use --task to specify a task file.",
					"error",
				);
				return;
			}

			const taskContent = await ctx.ui.editor(
				"Write the task for this loop:",
				"",
			);
			if (!taskContent || !taskContent.trim()) {
				ctx.ui.notify(
					"No task provided. Loop not started.",
					"warning",
				);
				return;
			}
			writeFileSync(taskFilePath, taskContent);
		}

		// Build config
		const config: LoopConfig = {
			name: parsed.name,
			cwd,
			taskFile: "task.md",
			maxIterations: parsed.maxIterations,
			model: parsed.model,
			provider: parsed.provider,
			thinking: parsed.thinking,
			reflectEvery: 0,
		};

		// Resolve model from config or fall back to parent pi's current model
		const modelRegistry = ctx.modelRegistry;
		let resolvedModel = ctx.model;
		if (parsed.model) {
			const allModels = modelRegistry.getAll();
			const found = parsed.provider
				? allModels.find(
						(m) =>
							m.provider === parsed.provider &&
							m.id === parsed.model,
					)
				: allModels.find((m) => m.id === parsed.model);
			if (found) {
				resolvedModel = found;
			} else {
				ctx.ui.notify(
					`Model "${parsed.model}" not found, using current model`,
					"warning",
				);
			}
		}

		// Resolve thinking level
		const thinkingLevel = parsed.thinking as
			| "off"
			| "minimal"
			| "low"
			| "medium"
			| "high"
			| "xhigh"
			| undefined;

		// Create engine with rendering callbacks and session dependencies
		const engine = new LoopEngine(
			dir,
			config,
			{
				onEvent: (event) => handleSessionEvent(event, cwd),

				onIterationStart: (iteration) => {
					// Flush any remaining text from previous iteration before clearing
					flushAssistantText();
					resetRenderingState();

					const consumedFollowup = pendingFollowupText;

					pendingSteerTexts = [];
					pendingFollowupText = null;

					pi.sendMessage({
						customType: "ralph_iteration",
						content: `Iteration ${iteration}`,
						display: true,
						details: {
							iteration,
							status: "start",
						},
					});

					if (consumedFollowup) {
						pi.sendMessage({
							customType: "ralph_user",
							content: consumedFollowup,
							display: true,
							details: {},
						});
					}

					updateWidget(ctx);
				},

				onIterationEnd: (iteration, stats) => {
					pi.sendMessage({
						customType: "ralph_iteration",
						content: fmtIterStats(stats),
						display: true,
						details: {
							iteration,
							status: "end",
						},
					});
					updateWidget(ctx);
				},

				onStatusChange: (status, error) => {
					if (
						status === "completed" ||
						status === "stopped" ||
						status === "error"
					) {
						pendingSteerTexts = [];
						pendingFollowupText = null;
						uninstallLoopEditor(ctx);
					}
					updateWidget(ctx);
					if (status === "completed") {
						const state = engine.getState();
						ctx.ui.notify(
							`Loop "${parsed.name}" completed after ${state.stats.iterations} iterations (${fmtCost(state.stats.cost)})`,
							"info",
						);
						clearWidgetAfterDelay(ctx);
					} else if (status === "stopped") {
						ctx.ui.notify(
							`Loop "${parsed.name}" stopped`,
							"info",
						);
						clearWidgetAfterDelay(ctx);
					} else if (status === "error") {
						ctx.ui.notify(
							`Loop "${parsed.name}" error: ${error}`,
							"error",
						);
						clearWidgetAfterDelay(ctx);
					}
				},
			},
			{
				model: resolvedModel,
				thinkingLevel,
			},
		);

		activeLoop = { name: parsed.name, dir, engine, ctx };
		pendingSteerTexts = [];
		pendingFollowupText = null;
		resetRenderingState();
		installLoopEditor(ctx, engine);

		const maxStr =
			parsed.maxIterations === 0
				? "unlimited"
				: String(parsed.maxIterations);
		const modelStr = parsed.model ? ` (model: ${parsed.model})` : "";
		ctx.ui.notify(
			`Loop "${parsed.name}" started (max: ${maxStr} iterations${modelStr})`,
			"info",
		);
		updateWidget(ctx);

		engine
			.start()
			.catch((err) => {
				ctx.ui.notify(
					`Loop "${parsed.name}" failed: ${err.message}`,
					"error",
				);
			})
			.finally(() => {
				if (activeLoop?.engine === engine) {
					uninstallLoopEditor(ctx);
					activeLoop = null;
				}
			});
	}

	function handleStop(ctx: ExtensionCommandContext, argsStr: string) {
		const name = argsStr.trim() || activeLoop?.name;

		if (!name) {
			ctx.ui.notify("No active loop. Usage: /ralph stop <name>", "error");
			return;
		}

		if (!activeLoop || activeLoop.name !== name) {
			ctx.ui.notify(`No active loop named "${name}"`, "error");
			return;
		}

		const status = activeLoop.engine.currentStatus;
		if (status === "stopped" || status === "completed") {
			ctx.ui.notify(`Loop "${name}" is already ${status}`, "info");
			return;
		}

		activeLoop.engine.stop();
		ctx.ui.notify(
			`Stopping loop "${name}" after current iteration completes...`,
			"info",
		);
	}

	function handleKill(ctx: ExtensionCommandContext, argsStr: string) {
		const name = argsStr.trim() || activeLoop?.name;

		if (!name) {
			ctx.ui.notify(
				"No active loop. Usage: /ralph kill <name>",
				"error",
			);
			return;
		}

		if (!activeLoop || activeLoop.name !== name) {
			ctx.ui.notify(`No active loop named "${name}"`, "error");
			return;
		}

		activeLoop.engine.kill();
		ctx.ui.notify(`Killed loop "${name}"`, "info");
	}

	function handleStatus(
		pi: ExtensionAPI,
		ctx: ExtensionCommandContext,
		argsStr: string,
	) {
		const name = argsStr.trim();

		if (!name) {
			return handleList(pi, ctx);
		}

		let state: LoopState | null = null;
		if (activeLoop && activeLoop.name === name) {
			state = activeLoop.engine.getState();
		} else {
			const dir = loopDir(ctx.cwd, name);
			state = readLoopState(dir);
		}

		if (!state) {
			ctx.ui.notify(`No loop found: "${name}"`, "error");
			return;
		}

		const lines = [
			`**Loop: ${name}**`,
			"",
			"| Field | Value |",
			"|-------|-------|",
			`| Status | ${state.status} |`,
			`| Iteration | ${state.iteration}${state.config.maxIterations > 0 ? ` / ${state.config.maxIterations}` : ""} |`,
			`| Duration | ${fmtDuration(state.stats.durationMs)} |`,
			`| Cost | ${fmtCost(state.stats.cost)} |`,
			`| Tokens In | ${fmtTokens(state.stats.tokensIn)} |`,
			`| Tokens Out | ${fmtTokens(state.stats.tokensOut)} |`,
			`| Turns | ${state.stats.turns} |`,
			`| Started | ${new Date(state.startedAt).toLocaleString()} |`,
			`| Updated | ${new Date(state.updatedAt).toLocaleString()} |`,
		];

		if (state.config.model) {
			lines.push(`| Model | ${state.config.model} |`);
		}
		if (state.error) {
			lines.push(`| Error | ${state.error} |`);
		}

		pi.sendMessage({
			customType: "ralph_assistant",
			content: lines.join("\n"),
			display: true,
			details: {},
		});
	}

	function handleList(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
		const diskLoops = listLocalLoops(ctx.cwd);

		const loopEntries: Array<{
			name: string;
			state: LoopState;
			active: boolean;
		}> = [];

		if (activeLoop) {
			loopEntries.push({
				name: activeLoop.name,
				state: activeLoop.engine.getState(),
				active: true,
			});
		}

		for (const dl of diskLoops) {
			if (activeLoop && dl.name === activeLoop.name) continue;
			if (!dl.state) continue;
			loopEntries.push({
				name: dl.name,
				state: dl.state,
				active: false,
			});
		}

		if (loopEntries.length === 0) {
			ctx.ui.notify(
				"No loops found. Use /ralph start <name> to create one.",
				"info",
			);
			return;
		}

		const lines = [
			"**Ralph Loops**",
			"",
			"| Name | Status | Iteration | Duration | Cost |",
			"|------|--------|-----------|----------|------|",
		];

		for (const entry of loopEntries) {
			const s = entry.state;
			const maxStr =
				s.config.maxIterations > 0
					? `/${s.config.maxIterations}`
					: "";
			const marker = entry.active ? " ●" : "";

			lines.push(
				`| ${entry.name}${marker} | ${s.status} | ${s.iteration}${maxStr} | ${fmtDuration(s.stats.durationMs)} | ${fmtCost(s.stats.cost)} |`,
			);
		}

		pi.sendMessage({
			customType: "ralph_assistant",
			content: lines.join("\n"),
			display: true,
			details: {},
		});
	}

	async function handleClean(ctx: ExtensionCommandContext) {
		const loops = listLocalLoops(ctx.cwd);
		const cleanable = loops.filter((l) => {
			if (!l.state) return true;
			if (activeLoop && l.name === activeLoop.name) return false;
			return (
				l.state.status === "completed" ||
				l.state.status === "stopped" ||
				l.state.status === "error"
			);
		});

		if (cleanable.length === 0) {
			ctx.ui.notify("No loops to clean up", "info");
			return;
		}

		const names = cleanable.map((l) => l.name).join(", ");

		if (ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				"Clean loops?",
				`Remove ${cleanable.length} loop${cleanable.length > 1 ? "s" : ""}: ${names}`,
			);
			if (!ok) return;
		}

		let cleaned = 0;
		for (const loop of cleanable) {
			try {
				rmSync(loop.dir, { recursive: true, force: true });
				cleaned++;
			} catch {
				// ignore
			}
		}

		ctx.ui.notify(
			`Cleaned ${cleaned} loop${cleaned > 1 ? "s" : ""}: ${names}`,
			"info",
		);
	}
}
