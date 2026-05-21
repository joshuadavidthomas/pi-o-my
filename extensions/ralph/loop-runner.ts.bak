/**
 * Ralph Loop Runner
 *
 * Standalone detached process that drives the RPC iteration loop.
 * Communicates with the extension via filesystem:
 *   events.jsonl, state.json, inbox/, iterations/, ~/.ralph/registry/
 *
 * Usage: bun run loop-runner.ts <ralph-dir>
 * Spawned by the extension via: spawn("bun", ["run", "loop-runner.ts", ralphDir])
 */

import { spawn } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
	CumulativeStats,
	InboxCommand,
	IterationStats,
	LoopConfig,
	LoopState,
	LoopStatus,
	RegistryEntry,
} from "./types.ts";
import { registryDir, registryFilename } from "./types.ts";

const ralphDir = process.argv[2];
if (!ralphDir) {
	process.stderr.write("Usage: loop-runner <ralph-dir>\n");
	process.exit(1);
}

const configPath = join(ralphDir, "config.json");
if (!existsSync(configPath)) {
	process.stderr.write(`Missing config: ${configPath}\n`);
	process.exit(1);
}

const config: LoopConfig = JSON.parse(readFileSync(configPath, "utf-8"));
const taskPath = join(ralphDir, config.taskFile);
if (!existsSync(taskPath)) {
	process.stderr.write(`Missing task file: ${taskPath}\n`);
	process.exit(1);
}

const inboxDir = join(ralphDir, "inbox");
const iterationsDir = join(ralphDir, "iterations");
mkdirSync(inboxDir, { recursive: true });
mkdirSync(iterationsDir, { recursive: true });


const startedAt = new Date();
const cumulativeStats: CumulativeStats = {
	iterations: 0,
	durationMs: 0,
	turns: 0,
	tokensIn: 0,
	tokensOut: 0,
	cost: 0,
};

let currentStatus: LoopStatus = "starting";
let currentIteration = 0;
let loopError: string | undefined;

function buildState(): LoopState {
	return {
		status: currentStatus,
		config,
		iteration: currentIteration,
		stats: { ...cumulativeStats },
		startedAt: startedAt.toISOString(),
		updatedAt: new Date().toISOString(),
		error: loopError,
		pid: process.pid,
	};
}

// Atomic write: tmp file + rename to avoid partial reads
function writeState() {
	const statePath = join(ralphDir, "state.json");
	const tmp = statePath + ".tmp";
	writeFileSync(tmp, JSON.stringify(buildState(), null, 2) + "\n");
	renameSync(tmp, statePath);
}


const pidPath = join(ralphDir, "pid");
writeFileSync(pidPath, String(process.pid));


const regDir = registryDir();
mkdirSync(regDir, { recursive: true });
const regFile = join(regDir, registryFilename(config.cwd, config.name));

function writeRegistry() {
	const entry: RegistryEntry = {
		pid: process.pid,
		cwd: config.cwd,
		ralphDir,
		name: config.name,
		startedAt: startedAt.toISOString(),
		lastSeen: new Date().toISOString(),
		status: currentStatus,
		iteration: currentIteration,
		maxIterations: config.maxIterations,
		model: config.model,
		provider: config.provider,
	};
	const tmp = regFile + ".tmp";
	writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n");
	renameSync(tmp, regFile);
}

function removeRegistry() {
	try { unlinkSync(regFile); } catch {}
}

const heartbeatInterval = setInterval(() => writeRegistry(), 30_000);
heartbeatInterval.unref();


const eventsStream = createWriteStream(join(ralphDir, "events.jsonl"), { flags: "a" });


let iterStartTime = 0;
let iterTokensIn = 0;
let iterTokensOut = 0;
let iterCacheRead = 0;
let iterCacheWrite = 0;
let iterCost = 0;
let iterTurns = 0;

function resetIterStats() {
	iterStartTime = Date.now();
	iterTokensIn = 0;
	iterTokensOut = 0;
	iterCacheRead = 0;
	iterCacheWrite = 0;
	iterCost = 0;
	iterTurns = 0;
}

function saveIterationStats() {
	const now = Date.now();
	const durationMs = now - iterStartTime;

	const stats: IterationStats = {
		iteration: currentIteration,
		durationMs,
		turns: iterTurns,
		tokensIn: iterTokensIn,
		tokensOut: iterTokensOut,
		cacheRead: iterCacheRead,
		cacheWrite: iterCacheWrite,
		cost: iterCost,
		startedAt: new Date(iterStartTime).toISOString(),
		endedAt: new Date(now).toISOString(),
	};

	const iterFile = join(
		iterationsDir,
		`${String(currentIteration).padStart(3, "0")}.json`,
	);
	writeFileSync(iterFile, JSON.stringify(stats, null, 2) + "\n");

	cumulativeStats.iterations++;
	cumulativeStats.durationMs += durationMs;
	cumulativeStats.turns += iterTurns;
	cumulativeStats.tokensIn += iterTokensIn;
	cumulativeStats.tokensOut += iterTokensOut;
	cumulativeStats.cost += iterCost;
}


let stopRequested = false;
let pendingFollowup: string | undefined;

function pollInbox(): InboxCommand | undefined {
	let files: string[];
	try {
		files = readdirSync(inboxDir).filter((f) => f.endsWith(".json"));
	} catch {
		return undefined;
	}

	const priority = ["stop.json", "steer.json", "followup.json"];
	files.sort(
		(a, b) =>
			(priority.indexOf(a) === -1 ? 99 : priority.indexOf(a)) -
			(priority.indexOf(b) === -1 ? 99 : priority.indexOf(b)),
	);

	for (const file of files) {
		const filePath = join(inboxDir, file);
		try {
			const content = readFileSync(filePath, "utf-8");
			unlinkSync(filePath);
			return JSON.parse(content) as InboxCommand;
		} catch {
			try { unlinkSync(filePath); } catch {}
		}
	}
	return undefined;
}

const inboxPollInterval = setInterval(() => {
	const cmd = pollInbox();
	if (!cmd) return;

	if (cmd.type === "stop") {
		stopRequested = true;
	} else if (cmd.type === "followup") {
		pendingFollowup = cmd.message;
	} else if (cmd.type === "steer") {
		rpcSend({ type: "steer", message: cmd.message });
	}
}, 500);
inboxPollInterval.unref();


let rpcProcess: ReturnType<typeof spawn> | null = null;

function rpcSend(command: Record<string, unknown>) {
	if (rpcProcess?.stdin?.writable) {
		rpcProcess.stdin.write(JSON.stringify(command) + "\n");
	}
}

async function runLoop() {
	currentStatus = "running";
	writeState();
	writeRegistry();

	const rpcArgs = ["--mode", "rpc", "--no-session"];
	if (config.model) rpcArgs.push("--model", config.model);
	if (config.provider) rpcArgs.push("--provider", config.provider);
	if (config.thinking) rpcArgs.push("--thinking", config.thinking);

	rpcProcess = spawn("pi", rpcArgs, {
		cwd: config.cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});

	rpcProcess.stderr?.resume();

	rpcProcess.on("error", (err) => {
		loopError = `Failed to start pi RPC: ${err.message}`;
		currentStatus = "error";
		writeState();
		writeRegistry();
		shutdown(1);
	});

	const rl = createInterface({ input: rpcProcess.stdout! });

	let resolveAgentEnd: (() => void) | null = null;
	let rejectAgentEnd: ((err: Error) => void) | null = null;

	// If RPC dies mid-iteration, reject the pending await so the loop can exit
	rpcProcess.on("exit", (code, signal) => {
		if (rejectAgentEnd) {
			rejectAgentEnd(
				new Error(`RPC process exited unexpectedly (code=${code}, signal=${signal})`),
			);
		}
	});

	rl.on("line", (line) => {
		eventsStream.write(line + "\n");

		let event: Record<string, unknown>;
		try { event = JSON.parse(line); } catch { return; }

		const eventType = event.type as string;

		if (eventType === "message_end") {
			const msg = event.message as Record<string, unknown> | undefined;
			if (msg?.role === "assistant") {
				iterTurns++;
				const usage = msg.usage as Record<string, unknown> | undefined;
				if (usage) {
					iterTokensIn += ((usage.input as number) ?? 0);
					iterTokensOut += ((usage.output as number) ?? 0);
					iterCacheRead += ((usage.cacheRead as number) ?? 0);
					iterCacheWrite += ((usage.cacheWrite as number) ?? 0);
					const cost = usage.cost as Record<string, unknown> | undefined;
					if (cost) iterCost += ((cost.total as number) ?? 0);
				}
			}
		} else if (eventType === "agent_end") {
			if (resolveAgentEnd) resolveAgentEnd();
		}
	});

	for (
		currentIteration = 1;
		config.maxIterations === 0 || currentIteration <= config.maxIterations;
		currentIteration++
	) {
		if (stopRequested) break;

		resetIterStats();

		// Re-read each iteration; the agent may have updated the task file
		const taskContent = readFileSync(taskPath, "utf-8").trim();

		const prompt = pendingFollowup ?? taskContent;
		pendingFollowup = undefined;

		const agentEndPromise = new Promise<void>((resolve, reject) => {
			resolveAgentEnd = resolve;
			rejectAgentEnd = reject;
		});

		rpcSend({ type: "prompt", message: prompt });

		try {
			await agentEndPromise;
		} catch (err) {
			loopError = String(err instanceof Error ? err.message : err);
			currentStatus = "error";
			writeState();
			writeRegistry();
			shutdown(1);
			return;
		}
		resolveAgentEnd = null;
		rejectAgentEnd = null;

		saveIterationStats();
		writeState();
		writeRegistry();

		const cmd = pollInbox();
		if (cmd?.type === "stop") stopRequested = true;
		if (stopRequested) break;
		if (config.maxIterations > 0 && currentIteration >= config.maxIterations) break;

		rpcSend({ type: "new_session" });
	}

	currentStatus = stopRequested ? "stopped" : "completed";
	writeState();
	writeRegistry();

	if (rpcProcess && !rpcProcess.killed) rpcProcess.kill("SIGTERM");

	shutdown(0);
}


let shuttingDown = false;

function shutdown(code: number) {
	if (shuttingDown) return;
	shuttingDown = true;

	clearInterval(heartbeatInterval);
	clearInterval(inboxPollInterval);
	eventsStream.end();

	if (currentStatus === "running" || currentStatus === "starting") {
		currentStatus = "error";
		loopError = "Unexpected shutdown";
		writeState();
	}

	try { unlinkSync(pidPath); } catch {}

	// Keep registry on error so the extension can detect and report
	if (currentStatus === "stopped" || currentStatus === "completed") {
		removeRegistry();
	}

	if (rpcProcess && !rpcProcess.killed) rpcProcess.kill("SIGTERM");

	process.exit(code);
}

// Finish current iteration before exiting, force after 10s
process.on("SIGTERM", () => {
	stopRequested = true;
	setTimeout(() => shutdown(0), 10_000);
});

process.on("SIGINT", () => {
	stopRequested = true;
	setTimeout(() => shutdown(0), 10_000);
});

runLoop().catch((err) => {
	loopError = String(err);
	currentStatus = "error";
	writeState();
	shutdown(1);
});
