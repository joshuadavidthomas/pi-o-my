import { createRequire } from "node:module";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Tool as PiTool,
} from "@earendil-works/pi-ai";
import { buildContextMessagesHandoff } from "../handoff.js";
import { PiStreamState, applyTurnUpdate } from "../pi-stream.js";
import { ClaudeSession, ClaudeTurn } from "../session.js";
import { buildPiMcpServer } from "../tools/mcp-server.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "../tools/names.js";
import { createMcpTextResult, extractToolResults } from "../tools/results.js";
import { extractSessionId, parseClaudeMessage } from "./events.js";
import { extractLatestUserPrompt, piContentToSdkPromptContent, toSdkPrompt, type PromptBlock } from "./prompt.js";
import { SdkInputQueue } from "./queue.js";
import { debug } from "./debug.js";

export type SdkQuery = ReturnType<typeof query>;

const require = createRequire(import.meta.url);

// Local Linux x64 quirk: the SDK resolver selected its musl package on my
// machine, but the installed/working binary is the glibc package. Prefer that
// known-good binary here; other platforms and missing packages fall back to the
// SDK's normal executable resolution.
function resolveClaudeExecutable(): string | undefined {
  if (process.platform !== "linux" || process.arch !== "x64") return undefined;

  try {
    return require.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude");
  } catch {
    return undefined;
  }
}

// Strip ANTHROPIC_API_KEY so the spawned `claude` binary falls back to OAuth
// credentials from `claude auth login`, matching what direct interactive
// `claude` use does. We also avoid setting CLAUDE_AGENT_SDK_CLIENT_APP — that
// env var appears to be a server-side discriminator that flips billing from
// Max subscription to API/extra-usage even when OAuth is the auth method.
function createSdkEnv(): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _stripped, ...inherited } = process.env;
  return {
    ...inherited,
    // Pi owns conversation compaction. Letting Claude Code auto-compact its
    // hidden transcript makes the same Pi session feel like a different model
    // mid-run and can drop tool/server details. Users can override this by
    // exporting DISABLE_AUTO_COMPACT=0 before starting pi.
    DISABLE_AUTO_COMPACT: inherited.DISABLE_AUTO_COMPACT ?? "1",
  };
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function fingerprintTools(tools: PiTool[] | undefined): string {
  if (!tools || tools.length === 0) return "[]";
  return JSON.stringify(
    tools.map((tool) => [tool.name, tool.description ?? "", tool.parameters ?? null]),
  );
}

function shouldCloseLiveQueryAfterTurn(): boolean {
  return process.argv.includes("-p") || process.argv.includes("--print");
}

function softResetThreshold(): number {
  const raw = process.env.PI_CLAUDE_AGENT_SDK_SOFT_RESET_THRESHOLD;
  if (!raw) return 0.85;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0.85;
  return parsed <= 0 ? Number.POSITIVE_INFINITY : Math.min(parsed, 1);
}

function shouldSoftResetAfterTurn(usageTotalTokens: number, contextWindow: number | undefined): boolean {
  if (!contextWindow || usageTotalTokens <= 0) return false;
  return usageTotalTokens >= contextWindow * softResetThreshold();
}

// Claude Code only requests the context-1m beta when the model string carries
// the [1m] suffix; a bare model id is served with a 200k window even for
// natively-1M models, so long pi sessions die with "Prompt is too long".
function toSdkModelId(model: Model<Api>): string {
  if (model.contextWindow > 200_000 && !model.id.endsWith("[1m]")) {
    return `${model.id}[1m]`;
  }
  return model.id;
}

const baseQueryOptions = (model: Model<Api>, abortController: AbortController) => ({
  abortController,
  cwd: process.cwd(),
  pathToClaudeCodeExecutable: resolveClaudeExecutable(),
  model: toSdkModelId(model),
  tools: [],
  includePartialMessages: true,
  settingSources: [],
  ...(process.env.PI_CLAUDE_AGENT_SDK_DEBUG ? {
    debugFile: "/tmp/pi-claude-code-debug.log",
    stderr: (data: string) => debug("claude-code:stderr", { data }),
  } : {}),
  env: createSdkEnv(),
});

function createAbortController(signal?: AbortSignal): AbortController {
  const abortController = new AbortController();
  if (!signal) return abortController;

  if (signal.aborted) {
    abortController.abort(signal.reason);
    return abortController;
  }

  signal.addEventListener("abort", () => abortController.abort(signal.reason), { once: true });
  return abortController;
}

export function streamClaudeAgentSdkOneShot(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const turn = new ClaudeTurn(new PiStreamState(model, stream));

  void runOneShotQuery(turn, model, context, options);

  return stream;
}

async function runOneShotQuery(
  turn: ClaudeTurn,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  debug("runOneShotQuery:start", { modelId: model.id, messageCount: context.messages.length });
  const abortController = createAbortController(options?.signal);
  let sdkQuery: ReturnType<typeof query> | undefined;

  if (abortController.signal.aborted) {
    debug("runOneShotQuery:already-aborted");
    turn.abort("Claude Agent SDK one-shot request aborted");
    return;
  }

  try {
    sdkQuery = query({
      prompt: toSdkPrompt(extractLatestUserPrompt(context)),
      options: {
        ...baseQueryOptions(model, abortController),
        allowedTools: [],
        systemPrompt: context.systemPrompt,
      },
    });

    for await (const message of sdkQuery) {
      const state = turn.streamState();
      if (!state) continue;

      const update = parseClaudeMessage(message);
      if (update && applyTurnUpdate(update, state, turn.toolBridge)) {
        turn.detachStreamState(state);
      }
    }

    const state = turn.streamState();
    if (state && !state.finished) {
      state.finish("stop");
    }
  } catch (error) {
    debug("runOneShotQuery:error", { message: errorMessage(error) });
    turn.streamState()?.fail(errorMessage(error), abortController.signal.aborted || Boolean(options?.signal?.aborted));
  } finally {
    try {
      sdkQuery?.close();
    } catch {
      // Ignore close failures.
    }
    debug("runOneShotQuery:end");
    turn.abort("Claude Agent SDK one-shot request ended");
  }
}

// Pi delivers mid-turn user follow-ups (steering) appended after the tool
// results: [..., assistant(toolUse), toolResult+, user+]. Returns the steering
// user contents when the trailing segment has exactly that shape, else null.
function extractSteeringSegment(context: Context): (string | PromptBlock[])[] | null {
  const steering: (string | PromptBlock[])[] = [];
  let sawToolResult = false;

  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message.role === "assistant") break;
    if (message.role === "toolResult") {
      sawToolResult = true;
      continue;
    }
    if (message.role === "user") {
      // A user message *before* the tool results is not the steering shape.
      if (sawToolResult) return null;
      const content = piContentToSdkPromptContent(message.content);
      if (typeof content !== "string" || content.length > 0) steering.unshift(content);
      continue;
    }
    return null;
  }

  return sawToolResult && steering.length > 0 ? steering : null;
}

export function streamClaudeAgentSdk(
  session: ClaudeSession,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  const latestRole = context.messages[context.messages.length - 1]?.role;
  const activeTurn = session.currentTurn();
  const messageCount = context.messages.length;

  if (activeTurn && latestRole === "toolResult") {
    // Pi's agent loop calls the provider again with tool results even after the
    // user aborts mid-tool-execution, expecting an immediate stopReason:
    // "aborted" back. Delivering the results instead would resume the SDK
    // subprocess's own agentic loop — it keeps firing tool calls after ESC.
    if (options?.signal?.aborted) {
      debug("streamClaudeAgentSdk:route", { route: "aborted-tool-continuation", messageCount, modelId: model.id });
      session.closeLiveQuery("Operation aborted during tool execution");
      const state = new PiStreamState(model, stream);
      state.start();
      state.fail("Claude Agent SDK request aborted", true);
      return stream;
    }

    debug("streamClaudeAgentSdk:route", { route: "tool-continuation", messageCount, modelId: model.id });
    activeTurn.attachStreamState(new PiStreamState(model, stream));
    activeTurn.toolBridge.deliverToolResults(extractToolResults(context));
    void finishToolContinuation(session, activeTurn, options?.signal);
    return stream;
  }

  if (activeTurn && latestRole === "user") {
    const steering = extractSteeringSegment(context);
    if (steering) {
      if (options?.signal?.aborted) {
        debug("streamClaudeAgentSdk:route", { route: "aborted-steering-continuation", messageCount, modelId: model.id });
        session.closeLiveQuery("Operation aborted during tool execution");
        const state = new PiStreamState(model, stream);
        state.start();
        state.fail("Claude Agent SDK request aborted", true);
        return stream;
      }

      // Killing the live query here (the old "Turn replaced" path) strands the
      // subprocess's pending MCP tool calls — they reject with stream-closed
      // errors and the chain breaks. Instead deliver the tool results and push
      // the follow-up through the input queue, the SDK's native steering path.
      debug("streamClaudeAgentSdk:route", { route: "steering-continuation", steeringCount: steering.length, messageCount, modelId: model.id });
      activeTurn.attachStreamState(new PiStreamState(model, stream));
      activeTurn.toolBridge.deliverToolResults(extractToolResults(context));
      for (const content of steering) {
        if (!session.pushUserMessage(toSdkUserMessage(content))) {
          session.closeLiveQuery("Claude SDK input stream closed while delivering steering");
          return stream;
        }
      }
      void finishToolContinuation(session, activeTurn, options?.signal);
      return stream;
    }
  }

  if (activeTurn) {
    debug("streamClaudeAgentSdk:route", { route: "replace-active-turn", latestRole, messageCount, modelId: model.id });
    session.closeLiveQuery("Turn replaced");
  }

  if (latestRole === "toolResult") {
    debug("streamClaudeAgentSdk:route", { route: "stale-tool-result", messageCount, modelId: model.id });
    const state = new PiStreamState(model, stream);
    state.start();
    queueMicrotask(() => state.finish("stop"));
    return stream;
  }

  debug("streamClaudeAgentSdk:route", { route: "fresh-turn", latestRole, messageCount, modelId: model.id });
  void runSessionQuery(session, model, stream, context, options);

  return stream;
}

async function finishToolContinuation(session: ClaudeSession, turn: ClaudeTurn, signal?: AbortSignal) {
  debug("finishToolContinuation:start");
  const abortPending = () => {
    debug("finishToolContinuation:signal-abort");
    session.closeLiveQuery("Operation aborted");
  };
  signal?.addEventListener("abort", abortPending, { once: true });

  try {
    await turn.done();
    const stopReason = turn.streamOutputStopReason();
    debug("finishToolContinuation:done", { stopReason });
    if (stopReason !== "toolUse") {
      session.finishActiveTurn(turn);
      if (shouldCloseLiveQueryAfterTurn()) {
        session.closeLiveQuery("Print-mode turn finished");
      } else if (!session.hasPersistentSession()) {
        session.closeLiveQuery("Transient session turn finished");
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortPending);
  }
}

async function runSessionQuery(
  session: ClaudeSession,
  model: Model<Api>,
  stream: AssistantMessageEventStream,
  context: Context,
  options?: SimpleStreamOptions,
) {
  debug("runSessionQuery:start", {
    messageCount: context.messages.length,
    latestRole: context.messages[context.messages.length - 1]?.role,
    hasContinuity: Boolean(session.continuityState().sdkSessionId),
    signalAborted: Boolean(options?.signal?.aborted),
  });

  if (options?.signal?.aborted) {
    debug("runSessionQuery:already-aborted");
    const state = new PiStreamState(model, stream);
    state.start();
    state.fail("Claude Agent SDK request aborted", true);
    return;
  }

  let turn: ClaudeTurn | undefined;
  let closeAfterTurn = false;
  let softResetAfterTurn = false;
  let softResetUsageTotalTokens = 0;

  try {
    const plan = session.prepareForTurn();
    const handoff = plan.skipHandoff
      ? undefined
      : plan.handoff ?? buildContextMessagesHandoff(context.messages);
    turn = session.beginTurn(new PiStreamState(model, stream));
    const activeTurn = turn;
    const mcpServer = buildPiMcpServer(context.tools, (toolName) => {
      const currentTurn = session.currentTurn();
      if (!currentTurn) {
        const message = `Pi turn ended before Claude Agent SDK tool ${toolName} could be routed.`;
        session.closeLiveQuery(message);
        return Promise.resolve(createMcpTextResult(message, true));
      }
      return currentTurn.toolBridge.handleMcpToolCall(toolName);
    });

    // Register before any await: listeners added to an already-aborted signal
    // never fire, so an ESC landing during connection setup would be lost.
    const abortPending = () => {
      debug("runSessionQuery:signal-abort");
      session.closeLiveQuery("Operation aborted");
    };
    options?.signal?.addEventListener("abort", abortPending, { once: true });

    let noOutputTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await ensureLiveQuery(session, model, context, options, mcpServer);
      await session.setModel(model.id);
      await session.setMcpServers(
        mcpServer ? { [MCP_SERVER_NAME]: mcpServer } : {},
        fingerprintTools(context.tools),
      );
      // An abort during setup may have raced connection creation: the listener
      // closed whatever was live at the time, but ensureLiveQuery could have
      // spawned a fresh connection afterwards. Never push a prompt post-abort.
      if (options?.signal?.aborted) {
        throw new Error("Claude Agent SDK request aborted");
      }

      const inputMessages: SDKUserMessage[] = [];
      if (handoff) {
        // shouldQuery: false appends the handoff to the SDK transcript without
        // triggering a turn; the SDK merges it into the next querying message
        // when inference fires.
        inputMessages.push(toSdkUserMessage(handoff, { shouldQuery: false }));
      }
      inputMessages.push(toSdkUserMessage(extractLatestUserPrompt(context)));
      debug("runSessionQuery:push-input", {
        count: inputMessages.length,
        replay: false,
        handoff: Boolean(handoff),
        handoffBytes: handoff?.length ?? 0,
        handoffPreview: handoff?.slice(0, 400) ?? null,
        messages: inputMessages.map((m) => ({
          shouldQuery: m.shouldQuery,
          contentBytes: (() => {
            try { return JSON.stringify(m.message?.content ?? "").length; } catch { return -1; }
          })(),
        })),
      });

      const pushStart = performance.now();
      for (const [index, message] of inputMessages.entries()) {
        if (!session.pushUserMessage(message)) {
          throw new Error("Claude SDK input stream is closed");
        }
        debug("runSessionQuery:pushed", {
          index,
          shouldQuery: message.shouldQuery,
          msSincePushStart: Math.round(performance.now() - pushStart),
        });
      }

      noOutputTimer = setTimeout(() => {
        const state = activeTurn.streamState();
        if (session.currentTurn() !== activeTurn || !state || state.finished || state.output.content.length > 0) return;
        debug("runSessionQuery:no-output-timeout");
        session.resetContinuity("Claude Agent SDK produced no assistant output before timeout");
      }, 90_000);
      noOutputTimer.unref?.();

      await activeTurn.done();
      closeAfterTurn = activeTurn.streamOutputStopReason() !== "toolUse";
      softResetUsageTotalTokens = activeTurn.streamOutputUsageTotalTokens();
      softResetAfterTurn = closeAfterTurn && shouldSoftResetAfterTurn(softResetUsageTotalTokens, model.contextWindow);
    } finally {
      if (noOutputTimer) clearTimeout(noOutputTimer);
      options?.signal?.removeEventListener("abort", abortPending);
    }
  } catch (error) {
    debug("runSessionQuery:error", { message: errorMessage(error), signalAborted: Boolean(options?.signal?.aborted) });
    const currentState = turn?.streamState();
    currentState?.fail(errorMessage(error), Boolean(options?.signal?.aborted));
    if (currentState) {
      turn?.detachStreamState(currentState);
    }
    session.closeLiveQuery(errorMessage(error));
  } finally {
    if (turn && closeAfterTurn) {
      session.finishActiveTurn(turn);
    }
    if (softResetAfterTurn) {
      session.resetContinuity(
        `Context usage ${softResetUsageTotalTokens}/${model.contextWindow} crossed soft reset threshold`,
      );
    }
    if (closeAfterTurn && shouldCloseLiveQueryAfterTurn()) {
      session.closeLiveQuery("Print-mode turn finished");
    } else if (closeAfterTurn && !session.hasPersistentSession()) {
      session.closeLiveQuery("Transient session turn finished");
    }
  }
}

function toSdkUserMessage(
  prompt: ReturnType<typeof extractLatestUserPrompt> | string,
  opts: { shouldQuery?: boolean } = {},
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
    shouldQuery: opts.shouldQuery ?? true,
  };
}

async function ensureLiveQuery(
  session: ClaudeSession,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  mcpServer: ReturnType<typeof buildPiMcpServer>,
) {
  if (session.liveQuery()) {
    debug("ensureLiveQuery", { reused: true, modelId: model.id });
    return;
  }

  const resumeSessionId = session.continuityState().sdkSessionId ?? undefined;
  debug("ensureLiveQuery", {
    reused: false,
    modelId: model.id,
    resume: resumeSessionId ?? null,
    hasMcpServer: Boolean(mcpServer),
    debugFile: process.env.PI_CLAUDE_AGENT_SDK_DEBUG ? "/tmp/pi-claude-code-debug.log" : null,
    executable: resolveClaudeExecutable() ?? "sdk-default",
  });

  const abortController = new AbortController();
  const inputQueue = new SdkInputQueue();
  const sdkQuery = query({
    prompt: inputQueue,
    options: {
      ...baseQueryOptions(model, abortController),
      resume: resumeSessionId,
      allowedTools: [`${MCP_TOOL_PREFIX}*`],
      permissionMode: "bypassPermissions",
      maxTurns: 999,
      systemPrompt: { type: "preset", preset: "claude_code" },
      ...(mcpServer ? { mcpServers: { [MCP_SERVER_NAME]: mcpServer } } : { mcpServers: {} }),
    },
  });

  void consumeLiveQuery(session, sdkQuery);
  session.startLiveQuery(
    { query: sdkQuery, inputQueue, abort: abortController },
    { resumeSessionId, modelId: model.id },
  );
}

async function consumeLiveQuery(session: ClaudeSession, sdkQuery: ReturnType<typeof query>) {
  try {
    for await (const message of sdkQuery) {
      debug("consumeLiveQuery:message", () => ({
        type: message.type,
        ...(message.type === "assistant" ? {
          stopReason: message.message.stop_reason,
          inputTokens: message.message.usage?.input_tokens,
          outputTokens: message.message.usage?.output_tokens,
          cacheRead: message.message.usage?.cache_read_input_tokens,
          cacheCreate: message.message.usage?.cache_creation_input_tokens,
        } : {}),
        ...(message.type === "result" ? {
          stopReason: message.stop_reason,
          subtype: message.subtype,
          numTurns: message.num_turns,
          isError: message.is_error,
          inputTokens: message.usage?.input_tokens,
          outputTokens: message.usage?.output_tokens,
          cacheRead: message.usage?.cache_read_input_tokens,
          cacheCreate: message.usage?.cache_creation_input_tokens,
        } : {}),
        ...(message.type === "user" ? {
          shouldQuery: (message as { shouldQuery?: boolean }).shouldQuery,
          isReplay: (message as { isReplay?: boolean }).isReplay,
          contentBytes: (() => {
            try { return JSON.stringify((message as { message?: { content?: unknown } }).message?.content ?? "").length; } catch { return -1; }
          })(),
        } : {}),
      }));
      const sdkSessionId = extractSessionId(message);
      const modelId = session.currentModelId();
      if (sdkSessionId && modelId) {
        session.captureSdkSessionId(sdkSessionId, modelId);
      }

      if (message.type === "system" && message.subtype === "compact_boundary") {
        session.markSdkCompactBoundary(message.compact_metadata.trigger, message.compact_metadata.pre_tokens);
        continue;
      }

      const activeTurn = session.currentTurn();
      const currentState = activeTurn?.streamState();
      if (!activeTurn || !currentState) continue;

      const update = parseClaudeMessage(message);
      if (update && applyTurnUpdate(update, currentState, activeTurn.toolBridge)) {
        activeTurn.detachStreamState(currentState);
      }
    }
  } catch (error) {
    debug("consumeLiveQuery:error", { message: errorMessage(error) });
    if (session.liveQuery() === sdkQuery) {
      session.abortActiveTurn(errorMessage(error));
    }
  } finally {
    const activeTurn = session.currentTurn();
    const currentState = activeTurn?.streamState();
    if (currentState && !currentState.finished) {
      debug("consumeLiveQuery:finishDangling", { hasText: currentState.output.content.some(b => b.type === 'text' && b.text.trim().length > 0), hasToolCall: currentState.hasToolCall() });
      currentState.finish("stop");
      activeTurn?.detachStreamState(currentState);
      if (activeTurn) session.finishActiveTurn(activeTurn);
    }
    debug("consumeLiveQuery:end", { isLive: session.liveQuery() === sdkQuery });
    if (session.liveQuery() === sdkQuery) {
      session.closeLiveQuery("Claude SDK query ended");
    }
  }
}
