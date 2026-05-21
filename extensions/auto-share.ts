/**
 * Auto-Share Extension
 *
 * Automatically exports pi sessions to GitHub gists and keeps them
 * updated as the conversation progresses. Produces stable, shareable
 * URLs that always reflect the latest session state.
 *
 * Requires: gh CLI installed and authenticated (gh auth login)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

const COOLDOWN_MS = 10_000;
const MANIFEST_FILENAME = "shares.json";
const GIST_FILENAME = "session.html";
const DEBUG_LOG = join(tmpdir(), "pi-auto-share-debug.log");
const SHARE_VIEWER_URL = process.env.PI_SHARE_VIEWER_URL || "https://pi.dev/session/";

function getShareViewerUrl(gistId: string): string {
	return `${SHARE_VIEWER_URL}#${gistId}`;
}

type ExportSessionToHtmlFn = (sm: any, state: any, options: any) => Promise<string>;
let _exportSessionToHtml: ExportSessionToHtmlFn | null = null;
async function loadExportFn(): Promise<ExportSessionToHtmlFn> {
	if (!_exportSessionToHtml) {
		const extensionDir = dirname(realpathSync(__filename));
		const mod = await import(
			join(extensionDir, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "export-html", "index.js")
		);
		_exportSessionToHtml = mod.exportSessionToHtml;
	}
	return _exportSessionToHtml!;
}

interface ManifestEntry {
	gistId: string;
	viewerUrl: string;
	name?: string;
	sessionFile: string;
	created: string;
	updated: string;
}

interface Manifest {
	enabled?: boolean;
	sessions?: Record<string, ManifestEntry>;
}

// In-memory state
let gistId: string | null = null;
let ghUsername: string | null = null;

let lastExportTime = 0;
let ghAvailable: boolean | null = null;
let ghWarningShown = false;
let enabled = false;
let flagOverride: boolean | null = null;
let exporting = false;

function updateManifestForSession(
	sessionFile: string,
	sessionId: string,
	sessionName: string | undefined,
	gistId: string,
	isNew: boolean,
): void {
	const manifestPath = join(dirname(sessionFile), MANIFEST_FILENAME);
	let manifest: Manifest = {};
	try {
		if (existsSync(manifestPath)) {
			manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		}
	} catch {
		// Corrupted file, start fresh
	}
	const sessions = manifest.sessions ??= {};
	const now = new Date().toISOString();

	const existing = sessions[sessionId];
	sessions[sessionId] = {
		gistId,
		viewerUrl: getShareViewerUrl(gistId),
		name: sessionName,
		sessionFile: basename(sessionFile),
		created: isNew ? now : existing?.created ?? now,
		updated: now,
	};

	const dir = dirname(manifestPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

function persistEnabled(ctx: ExtensionContext, value: boolean): void {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return;
	const manifestPath = join(dirname(sessionFile), MANIFEST_FILENAME);
	let manifest: Manifest = {};
	try {
		if (existsSync(manifestPath)) {
			manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		}
	} catch {}
	manifest.enabled = value;
	const dir = dirname(manifestPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

function runGh(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn("gh", args);
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (data) => { stdout += data.toString(); });
		proc.stderr?.on("data", (data) => { stderr += data.toString(); });
		proc.on("close", (code) => resolve({ code, stdout, stderr }));
		proc.on("error", () => resolve({ code: 1, stdout, stderr }));
	});
}

function debugLog(message: string): void {
	try {
		appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${message}\n`);
	} catch {}
}

interface ExportOptions {
	skipCooldown?: boolean;
	notifyGhUnavailable?: boolean;
}

async function doExport(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: ExportOptions = {},
): Promise<void> {
	if (!enabled) return;
	if (exporting) return;
	if (!options.skipCooldown && Date.now() - lastExportTime < COOLDOWN_MS) return;

	const sessionManager = ctx.sessionManager;
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !existsSync(sessionFile)) return;
	const sessionId = sessionManager.getSessionId();
	const sessionName = sessionManager.getSessionName();
	const systemPrompt = ctx.getSystemPrompt();
	const themeName = ctx.ui.theme.name;
	const notify = ctx.hasUI ? ctx.ui.notify : undefined;
	const activeToolNames = new Set(pi.getActiveTools());
	const tools = pi.getAllTools()
		.filter((t) => activeToolNames.has(t.name))
		.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

	if (ghAvailable !== true) {
		const authCheck = await runGh(["auth", "status"]);
		ghAvailable = authCheck.code === 0;
		if (!ghAvailable) {
			if (options.notifyGhUnavailable && !ghWarningShown) {
				ghWarningShown = true;
				const versionCheck = await runGh(["--version"]);
				if (versionCheck.code !== 0) {
					notify?.("auto-share: gh CLI not found. Install from https://cli.github.com/", "warning");
				} else {
					notify?.("auto-share: gh is not logged in. Run 'gh auth login'.", "warning");
				}
			}
			return;
		}
	}

	exporting = true;
	// Use a subdirectory so the gist file is named consistently
	const tmpDir = join(tmpdir(), `pi-auto-share-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	const tmpFile = join(tmpDir, GIST_FILENAME);

	try {
		const exportSessionToHtml = await loadExportFn();
		const state = { systemPrompt, tools };
		await exportSessionToHtml(sessionManager, state, {
			outputPath: tmpFile,
			themeName,
		});

		if (gistId) {
			const result = await runGh(["gist", "edit", gistId, "--filename", GIST_FILENAME, tmpFile]);
			if (result.code === 0) {
				updateManifestForSession(sessionFile, sessionId, sessionName, gistId, false);
				lastExportTime = Date.now();
			} else {
				debugLog(`gist edit failed: ${result.stderr.trim()}`);
			}
		} else {
			const result = await runGh(["gist", "create", "--public=false", tmpFile]);
			const newGistId = result.code === 0 ? basename(result.stdout.trim()) : null;
			if (newGistId) {
				gistId = newGistId;
				updateManifestForSession(sessionFile, sessionId, sessionName, gistId, true);
				lastExportTime = Date.now();
				debugLog(`Created gist ${gistId} for session ${sessionId}`);
			} else {
				debugLog(`gist create failed: ${result.stderr.trim()}`);
			}
		}
	} catch (err) {
		debugLog(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
		exporting = false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("auto-share", {
		description: "Enable auto-sharing to GitHub gists",
		type: "boolean",
	});

	pi.on("session_start", async (_event, ctx) => {
		gistId = null;

		const flag = pi.getFlag("auto-share");
		if (typeof flag === "boolean") {
			flagOverride = flag;
		}

		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		const manifestPath = join(dirname(sessionFile), MANIFEST_FILENAME);
		let manifest: Manifest = {};
		try {
			if (existsSync(manifestPath)) {
				manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
			}
		} catch {
			return;
		}

		enabled = flagOverride ?? manifest.enabled ?? false;

		const entry = manifest.sessions?.[ctx.sessionManager.getSessionId()];
		if (entry?.gistId) {
			gistId = entry.gistId;
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		void doExport(pi, ctx).catch((err) => debugLog(`Export failed: ${err instanceof Error ? err.message : String(err)}`));
	});

	pi.on("session_compact", (_event, ctx) => {
		void doExport(pi, ctx).catch((err) => debugLog(`Export failed: ${err instanceof Error ? err.message : String(err)}`));
	});

	pi.on("session_tree", (_event, ctx) => {
		void doExport(pi, ctx).catch((err) => debugLog(`Export failed: ${err instanceof Error ? err.message : String(err)}`));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await doExport(pi, ctx, { skipCooldown: true });
		gistId = null;
		lastExportTime = 0;
	});

	pi.registerCommand("auto-share", {
		description: "Toggle auto-sharing or show status",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "status", label: "status" },
				{ value: "on", label: "on" },
				{ value: "off", label: "off" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "status") {
				const lines = [`Auto-share: ${enabled ? "enabled" : "disabled"}`];
				if (enabled) {
					const authCheck = await runGh(["auth", "status"]);
					ghAvailable = authCheck.code === 0;
					lines.push(`GitHub CLI: ${ghAvailable ? "available" : "unavailable"}`);
					if (gistId) {
						if (!ghUsername) {
							const info = await runGh(["api", "user", "--jq", ".login"]);
							if (info.code === 0) ghUsername = info.stdout.trim();
						}
						lines.push(`Share URL: ${getShareViewerUrl(gistId)}`);
						lines.push(`Gist: https://gist.github.com/${ghUsername}/${gistId}`);
					}
					if (lastExportTime > 0) {
						const ago = Math.round((Date.now() - lastExportTime) / 1000);
						lines.push(`Last export: ${ago}s ago`);
					}
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (arg === "on" || arg === "off" || arg === "") {
				const next = arg === "" ? !enabled : arg === "on";
				if (next === enabled) {
					ctx.ui.notify(`Auto-share is already ${enabled ? "enabled" : "disabled"}`, "info");
					return;
				}
				enabled = next;
				persistEnabled(ctx, enabled);
				ctx.ui.notify(`Auto-share ${enabled ? "enabled" : "disabled"}`, "info");
				if (enabled) {
					await doExport(pi, ctx, { skipCooldown: true, notifyGhUnavailable: true });
				}
				return;
			}
		},
	});
}
