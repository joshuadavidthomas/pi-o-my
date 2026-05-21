/**
 * Ralph Loop — Shared types between loop engine and extension.
 */

export type LoopStatus =
	| "starting"
	| "running"
	| "stopped"
	| "completed"
	| "error";

export interface LoopConfig {
	name: string;
	cwd: string;
	/** Relative to the ralph dir */
	taskFile: string;
	/** 0 = unlimited */
	maxIterations: number;
	model?: string;
	provider?: string;
	thinking?: string;
	/** 0 = disabled */
	reflectEvery: number;
}

export interface IterationStats {
	iteration: number;
	durationMs: number;
	turns: number;
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	startedAt: string;
	endedAt: string;
}

export interface CumulativeStats {
	iterations: number;
	durationMs: number;
	turns: number;
	tokensIn: number;
	tokensOut: number;
	cost: number;
}

export interface LoopState {
	status: LoopStatus;
	config: LoopConfig;
	iteration: number;
	stats: CumulativeStats;
	startedAt: string;
	updatedAt: string;
	error?: string;
}

/** Get the .ralph/<name>/ directory for a named loop in a project */
export function loopDir(cwd: string, name: string): string {
	return `${cwd}/.ralph/${name}`;
}
