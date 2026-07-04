import { getModels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { debug } from "./sdk/debug.js";
import { ClaudeSessionManager } from "./session.js";
import { streamClaudeAgentSdk, streamClaudeAgentSdkOneShot } from "./sdk/query.js";

export const PROVIDER_ID = "claude-agent-sdk";
export const API_ID = "claude-agent-sdk";

const PROVIDER_MODELS: ProviderModelConfig[] = getModels("anthropic")
  .filter((model) => model.id.startsWith("claude-"))
  .map((model) => ({
    id: model.id,
    name: model.name,
    api: API_ID,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));

export default function claudeAgentSdkProvider(pi: ExtensionAPI) {
  const claudeSessions = ClaudeSessionManager.claim(pi);

  pi.on("session_start", (event, ctx) => {
    debug("event:session_start", {
      reason: event.reason,
      piSessionId: ctx.sessionManager.getSessionId(),
      provider: ctx.model?.provider,
      willResetContinuity: (event.reason === "new" || event.reason === "fork") && ctx.model?.provider === PROVIDER_ID,
    });
    const session = claudeSessions.hydrateSession(ctx.sessionManager, `session_start:${event.reason}`);

    if ((event.reason === "new" || event.reason === "fork") && ctx.model?.provider === PROVIDER_ID) {
      session.resetContinuity(`session_start: reason=${event.reason}`);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    debug("event:session_shutdown", { piSessionId: ctx.sessionManager.getSessionId() });
    claudeSessions.shutdownSession(ctx.sessionManager.getSessionId());
  });

  pi.on("session_compact", (_event, ctx) => {
    debug("event:session_compact", { piSessionId: ctx.sessionManager.getSessionId(), provider: ctx.model?.provider });
    if (ctx.model?.provider !== PROVIDER_ID) return;
    claudeSessions.resetSessionForStructuralChange(ctx.sessionManager);
  });

  pi.on("session_tree", (_event, ctx) => {
    debug("event:session_tree", { piSessionId: ctx.sessionManager.getSessionId(), provider: ctx.model?.provider });
    if (ctx.model?.provider !== PROVIDER_ID) return;

    // /tree changes Pi's active branch inside the same Pi session file. Do not
    // blindly persist a null SDK session: the selected branch may already have
    // valid continuity entries. Close the old live SDK query and rehydrate from
    // the new branch, letting the next turn resume branch-local continuity or
    // cold-start with a Pi handoff if none exists.
    claudeSessions.hydrateSession(ctx.sessionManager, "session_tree");
  });

  pi.on("turn_end", (_event, ctx) => {
    const leafId = ctx.sessionManager.getLeafId();
    debug("event:turn_end", {
      piSessionId: ctx.sessionManager.getSessionId(),
      provider: ctx.model?.provider,
      leafId,
    });
    if (ctx.model?.provider !== PROVIDER_ID) return;
    if (!leafId) return;

    claudeSessions.markSessionSynced(ctx.sessionManager, leafId);
  });

  pi.on("model_select", (event, ctx) => {
    debug("event:model_select", {
      piSessionId: ctx.sessionManager.getSessionId(),
      previousProvider: event.previousModel?.provider,
      newProvider: event.model.provider,
      willCloseLiveQuery: event.previousModel?.provider === PROVIDER_ID && event.model.provider !== PROVIDER_ID,
    });
    if (event.previousModel?.provider !== PROVIDER_ID || event.model.provider === PROVIDER_ID) return;

    claudeSessions.currentSession(ctx.sessionManager)?.closeLiveQuery("Claude Agent SDK request cancelled after switching models");
  });

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "https://api.anthropic.com",
    // Pi requires apiKey or oauth on the registration when defining models, and
    // uses configured auth to decide whether the provider appears in model
    // pickers. The Claude Agent SDK does not use this value: the spawned
    // `claude` binary authenticates with credentials from `claude auth login`,
    // and createSdkEnv() strips ANTHROPIC_API_KEY before spawning the subprocess.
    // Keep this as a literal sentinel so pi treats the provider as available
    // even when ANTHROPIC_API_KEY is unset.
    apiKey: "claude-agent-sdk-auth-sentinel",
    api: API_ID,
    models: PROVIDER_MODELS,
    streamSimple: (model, context, options) => {
      if (!options?.sessionId) {
        return streamClaudeAgentSdkOneShot(model, context, options);
      }

      let session = claudeSessions.getSession(options.sessionId);
      if (!session) {
        session = claudeSessions.createSession(options.sessionId);
      }

      return streamClaudeAgentSdk(session, model, context, options);
    },
  });
}
