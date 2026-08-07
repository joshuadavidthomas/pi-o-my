/**
 * Ralph Loop Engine
 *
 * Drives the iteration loop in-process using the pi SDK.
 * Creates an AgentSessionRuntime, manages iterations,
 * tracks telemetry, writes filesystem artifacts (state.json, iterations/).
 *
 * No subprocess, no RPC, no JSON serialization — events are typed objects
 * in the same heap, steering is a method call, fresh context is instant.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	createWriteStream,
	type WriteStream,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	CumulativeStats,
	IterationStats,
	LoopConfig,
	LoopState,
	LoopStatus,
} from "./types.ts";

export interface LoopEngineCallbacks {
	/** Typed session event forwarded for TUI rendering */
	onEvent: (event: AgentSessionEvent) => void;
	/** Fired before the first prompt of each iteration */
	onIterationStart?: (iteration: number) => void;
	/** Fired after stats are collected for a completed iteration */
	onIterationEnd?: (iteration: number, stats: IterationStats) => void;
	/** Fired when loop status changes (running, stopped, completed, error) */
	onStatusChange?: (status: LoopStatus, error?: string) => void;
}

/** Dependencies from the parent pi session needed to create child sessions */
export interface LoopEngineSessionDeps {
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
}

export class LoopEngine {
	private runtime: AgentSessionRuntime | null = null;
	private session: AgentSession | null = null;
	private unsubscribe: (() => void) | null = null;
	private status: LoopStatus = "starting";
	private iteration = 0;
	private startedAt = new Date();
	private error?: string;

	// Cumulative stats across all iterations
	private cumulativeStats: CumulativeStats = {
		iterations: 0,
		durationMs: 0,
		turns: 0,
		tokensIn: 0,
		tokensOut: 0,
		cost: 0,
	};

	// Per-iteration tracking (reset each iteration)
	private iterStartTime = 0;
	private iterTokensIn = 0;
	private iterTokensOut = 0;
	private iterCacheRead = 0;
	private iterCacheWrite = 0;
	private iterCost = 0;
	private iterTurns = 0;

	// Control flow
	private stopRequested = false;
	private pendingFollowup?: string;

	// Filesystem
	private eventsStream: WriteStream | null = null;

	constructor(
		private ralphDir: string,
		private config: LoopConfig,
		private callbacks: LoopEngineCallbacks,
		private sessionDeps: LoopEngineSessionDeps,
	) {}

	get currentStatus(): LoopStatus {
		return this.status;
	}

	get currentIteration(): number {
		return this.iteration;
	}

	getState(): LoopState {
		return {
			status: this.status,
			config: this.config,
			iteration: this.iteration,
			stats: { ...this.cumulativeStats },
			startedAt: this.startedAt.toISOString(),
			updatedAt: new Date().toISOString(),
			error: this.error,
		};
	}

	/**
	 * Start the loop. Runs iterations until max is reached, stop is requested,
	 * or an error occurs. Returns when the loop is finished.
	 */
	async start(): Promise<void> {
		mkdirSync(join(this.ralphDir, "iterations"), { recursive: true });
		this.clearArtifacts();

		this.eventsStream = createWriteStream(
			join(this.ralphDir, "events.jsonl"),
			{ flags: "a" },
		);

		writeFileSync(
			join(this.ralphDir, "config.json"),
			JSON.stringify(this.config, null, 2) + "\n",
		);

		// Create AgentSessionRuntime via SDK — no subprocess, in-process
		try {
			const createRuntime: CreateAgentSessionRuntimeFactory = async ({
				cwd,
				agentDir,
				sessionManager,
				sessionStartEvent,
			}) => {
				const services = await createAgentSessionServices({
					cwd,
					agentDir,
				});
				return {
					...(await createAgentSessionFromServices({
						services,
						sessionManager,
						sessionStartEvent,
						model: this.sessionDeps.model,
						thinkingLevel: this.sessionDeps.thinkingLevel,
					})),
					services,
					diagnostics: services.diagnostics,
				};
			};
			this.runtime = await createAgentSessionRuntime(createRuntime, {
				cwd: this.config.cwd,
				agentDir: getAgentDir(),
				sessionManager: SessionManager.inMemory(this.config.cwd),
			});
			this.runtime.setRebindSession(async (session) => {
				this.bindSession(session);
			});
			this.bindSession(this.runtime.session);
		} catch (err) {
			this.error = `Failed to create agent session: ${err instanceof Error ? err.message : String(err)}`;
			this.setStatus("error");
			return;
		}

		this.setStatus("running");
		this.writeState();

		try {
			await this.runIterations();
		} finally {
			await this.cleanup();
		}
	}

	/** Signal the loop to stop after the current iteration completes. */
	stop(): void {
		this.stopRequested = true;
	}

	/** Abort current iteration immediately and stop the loop. */
	kill(): void {
		this.stopRequested = true;

		// Unsubscribe immediately to stop event flow before abort cleanup
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}

		if (this.session) {
			this.session.abort().catch(() => {});
		}
		this.setStatus("stopped");
		this.writeState();
	}

	/**
	 * Steer the agent mid-iteration with a user message.
	 * Delivered after the current tool finishes via session.steer().
	 * The message is wrapped with instructions to continue the task
	 * so the steer doesn't short-circuit the iteration.
	 */
	nudge(message: string): void {
		if (this.status === "running" && this.session) {
			const wrapped = [
				message,
				"",
				"(Address the above, then continue with your current task.)",
			].join("\n");
			this.session.steer(wrapped).catch(() => {});
		}
	}

	/** Queue a message to be appended to the next iteration's prompt. */
	queueForNextIteration(message: string): void {
		this.pendingFollowup = message;
	}

	private bindSession(session: AgentSession): void {
		this.unsubscribe?.();
		this.session = session;
		this.unsubscribe = session.subscribe((event) => {
			this.eventsStream?.write(JSON.stringify(event) + "\n");
			this.handleEvent(event);
		});
	}

	private async runIterations(): Promise<void> {
		const taskPath = join(this.ralphDir, this.config.taskFile);

		for (
			this.iteration = 1;
			this.config.maxIterations === 0 ||
			this.iteration <= this.config.maxIterations;
			this.iteration++
		) {
			if (this.stopRequested) break;

			this.resetIterStats();
			this.callbacks.onIterationStart?.(this.iteration);

			// Re-read task each iteration — the agent may have updated it
			const taskContent = readFileSync(taskPath, "utf-8").trim();
			const prompt = this.pendingFollowup
				? `${taskContent}\n\n---\n\n${this.pendingFollowup}`
				: taskContent;
			this.pendingFollowup = undefined;

			try {
				await this.session!.prompt(prompt);
			} catch (err) {
				if (this.stopRequested) break;

				this.error = String(
					err instanceof Error ? err.message : err,
				);
				this.setStatus("error");
				this.writeState();
				return;
			}

			// Collect and save stats for this iteration
			const iterStats = this.saveIterationStats();
			this.callbacks.onIterationEnd?.(this.iteration, iterStats);
			this.writeState();

			// Check stop conditions
			if (this.stopRequested) break;
			if (
				this.config.maxIterations > 0 &&
				this.iteration >= this.config.maxIterations
			)
				break;

			// Fresh context for next iteration
			await this.runtime!.newSession();
		}

		this.setStatus(this.stopRequested ? "stopped" : "completed");
		this.writeState();
	}

	private handleEvent(event: AgentSessionEvent): void {
		// Don't forward events after stop/kill — prevents rendering after abort
		if (this.stopRequested) return;

		// Forward to extension for rendering
		this.callbacks.onEvent(event);

		// Track telemetry from message_end events
		if (event.type === "message_end") {
			const msg = event.message;
			if ("role" in msg && msg.role === "assistant" && "usage" in msg) {
				this.iterTurns++;
				const usage = msg.usage;
				this.iterTokensIn += usage.input ?? 0;
				this.iterTokensOut += usage.output ?? 0;
				this.iterCacheRead += usage.cacheRead ?? 0;
				this.iterCacheWrite += usage.cacheWrite ?? 0;
				this.iterCost += usage.cost?.total ?? 0;
			}
		}
	}

	private resetIterStats(): void {
		this.iterStartTime = Date.now();
		this.iterTokensIn = 0;
		this.iterTokensOut = 0;
		this.iterCacheRead = 0;
		this.iterCacheWrite = 0;
		this.iterCost = 0;
		this.iterTurns = 0;
	}

	private saveIterationStats(): IterationStats {
		const now = Date.now();
		const durationMs = now - this.iterStartTime;

		const stats: IterationStats = {
			iteration: this.iteration,
			durationMs,
			turns: this.iterTurns,
			tokensIn: this.iterTokensIn,
			tokensOut: this.iterTokensOut,
			cacheRead: this.iterCacheRead,
			cacheWrite: this.iterCacheWrite,
			cost: this.iterCost,
			startedAt: new Date(this.iterStartTime).toISOString(),
			endedAt: new Date(now).toISOString(),
		};

		const iterFile = join(
			this.ralphDir,
			"iterations",
			`${String(this.iteration).padStart(3, "0")}.json`,
		);
		writeFileSync(iterFile, JSON.stringify(stats, null, 2) + "\n");

		this.cumulativeStats.iterations++;
		this.cumulativeStats.durationMs += durationMs;
		this.cumulativeStats.turns += this.iterTurns;
		this.cumulativeStats.tokensIn += this.iterTokensIn;
		this.cumulativeStats.tokensOut += this.iterTokensOut;
		this.cumulativeStats.cost += this.iterCost;

		return stats;
	}

	/** Atomic write: tmp file + rename to prevent partial reads */
	private writeState(): void {
		const statePath = join(this.ralphDir, "state.json");
		const tmp = statePath + ".tmp";
		writeFileSync(
			tmp,
			JSON.stringify(this.getState(), null, 2) + "\n",
		);
		renameSync(tmp, statePath);
	}

	/** Clear old artifacts for a fresh start */
	private clearArtifacts(): void {
		try {
			writeFileSync(join(this.ralphDir, "events.jsonl"), "");
		} catch {}
		try {
			unlinkSync(join(this.ralphDir, "state.json"));
		} catch {}
		try {
			for (const f of readdirSync(
				join(this.ralphDir, "iterations"),
			)) {
				unlinkSync(join(this.ralphDir, "iterations", f));
			}
		} catch {}
	}

	private setStatus(status: LoopStatus): void {
		this.status = status;
		this.callbacks.onStatusChange?.(status, this.error);
	}

	private async cleanup(): Promise<void> {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}

		this.eventsStream?.end();
		this.eventsStream = null;

		this.session = null;

		if (this.runtime) {
			const runtime = this.runtime;
			this.runtime = null;
			await runtime.dispose();
		}
	}
}
