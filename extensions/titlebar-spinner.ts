import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL_MS = 80;

function getBaseTitle(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const cwd = path.basename(ctx.cwd);
	const session = pi.getSessionName();
	return session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
}

function getSpinnerTitle(pi: ExtensionAPI, ctx: ExtensionContext, frame: string): string {
	const cwd = path.basename(ctx.cwd);
	const session = pi.getSessionName();
	return session ? `${frame} - ${session} - ${cwd}` : `${frame} - ${cwd}`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}

		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(pi, ctx));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);

		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			ctx.ui.setTitle(getSpinnerTitle(pi, ctx, frame));
			frameIndex++;
		}, FRAME_INTERVAL_MS);
		(timer as NodeJS.Timeout).unref?.();
	}

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setTitle(getBaseTitle(pi, ctx));
	});

	pi.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
