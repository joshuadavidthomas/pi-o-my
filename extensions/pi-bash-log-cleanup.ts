import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFile, readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIN_AGE_MS = 30 * 60 * 1000;
const DEBUG =
	process.env.PI_BASH_LOG_CLEANUP_DEBUG === "1" ||
	(process.env.DEBUG ?? "").split(",").includes("pi-bash-log-cleanup");

let cleanupPromise: Promise<void> | undefined;

async function cleanupPiBashLogs(reason: string): Promise<void> {
	if (cleanupPromise) {
		return cleanupPromise;
	}

	cleanupPromise = (async () => {
		let removed = 0;
		let bytes = 0;
		const dir = tmpdir();
		const now = Date.now();

		try {
			for (const name of await readdir(dir)) {
				if (!name.startsWith("pi-bash-")) {
					continue;
				}

				const path = join(dir, name);

				try {
					const info = await stat(path);
					if (!info.isFile() || now - info.mtimeMs < MIN_AGE_MS) {
						continue;
					}

					await unlink(path);
					removed += 1;
					bytes += info.size;
				} catch {
					// File may have disappeared or become inaccessible.
				}
			}
		} catch {
			// Ignore cleanup failures. This extension should never affect pi startup/shutdown.
		}

		if (DEBUG && removed > 0) {
			try {
				await appendFile(
					join(getAgentDir(), "pi-bash-log-cleanup.log"),
					`${new Date().toISOString()} ${reason}: removed ${removed} files (${(bytes / 1024 / 1024).toFixed(1)} MiB)\n`,
				);
			} catch {
				// Ignore debug logging failures too.
			}
		}
	})().finally(() => {
		cleanupPromise = undefined;
	});

	return cleanupPromise;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		void cleanupPiBashLogs("session_start");
	});
	pi.on("session_shutdown", () => {
		void cleanupPiBashLogs("session_shutdown");
	});
}
