/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff check other places that need this fix
 *
 * The generated prompt appears as a draft in the editor for review/editing.
 */

import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT = `You are creating a handoff message to continue work in a new session.

## Philosophy

When an AI assistant starts a fresh session, it spends significant time exploring the codebase—grepping, reading files, searching—before it can begin actual work. This "file archaeology" is wasteful when the previous session already discovered what matters.

A good handoff frontloads everything the next session needs so it can start implementing immediately.

## Instructions

Analyze the conversation and extract what matters for continuing the work.

1. **List relevant files**

   Include files that will be edited, dependencies being touched, relevant tests, configs, and key reference docs.

   Be generous—the cost of an extra file is low; missing a critical one means another archaeology dig. Target 8-15 files, up to 20 for complex work.

   IMPORTANT: Use the exact absolute paths as they appear in the conversation. The current working directory will be provided for reference.

2. **Draft the context**

   Describe what we're working on and provide whatever context helps continue the work. Structure it based on what fits the conversation—could be bullet points, a narrative paragraph, detailed steps, or a mix.

   Preserve: decisions made and rationale, constraints discovered, user preferences, technical patterns established.

   Exclude: conversation back-and-forth, dead ends, meta-commentary.

   The user controls what context matters—if they mentioned something to preserve, include it. Be thorough. Multiple paragraphs are expected for complex work.

3. **State the task** based on the user's goal

## Output Format

Respond with markdown using these exact section headers in this order:

## Files

- /absolute/path/to/file1.ts
- /absolute/path/to/file2.ts
- /absolute/path/to/file3.ts

## Context

[Your thorough context description here. Be detailed—this is the primary value of the handoff.]

## Task

[Clear description of what to do next based on the user's goal]`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("handoff requires interactive mode", "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify("Usage: /handoff <goal for new session>", "error");
        return;
      }

      // Gather conversation context from current branch
      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
        .map((entry) => entry.message);

      if (messages.length === 0) {
        ctx.ui.notify("No conversation to hand off", "error");
        return;
      }

      // Convert to LLM format and serialize
      const llmMessages = convertToLlm(messages);
      const conversationText = serializeConversation(llmMessages);
      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const cwd = process.cwd();

      // Generate the handoff with loader UI
      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Generating handoff...");
        loader.onAbort = () => done(null);

        const doGenerate = async () => {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
          if (!auth.ok || !auth.apiKey) {
            throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
          }

          const userMessage: Message = {
            role: "user",
            content: [
              {
                type: "text",
                text: `## Current Working Directory\n\n${cwd}\n\n## Conversation History\n\n${conversationText}\n\n## User's Goal for New Session\n\n${goal}`,
              },
            ],
            timestamp: Date.now(),
          };

          const response = await complete(
            ctx.model!,
            { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
            { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
          );

          if (response.stopReason === "aborted") {
            return null;
          }

          return response.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        };

        doGenerate()
          .then(done)
          .catch((err) => {
            console.error("Handoff generation failed:", err);
            done(null);
          });

        return loader;
      });

      if (result === null) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      // Let user edit the generated prompt
      const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);

      if (editedPrompt === undefined) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      // Create new session with parent tracking
      const newSessionResult = await ctx.newSession({
        parentSession: currentSessionFile,
        withSession: async (ctx) => {
          ctx.ui.setEditorText(editedPrompt);
          ctx.ui.notify("Handoff ready. Submit when ready.", "info");
        },
      });

      if (newSessionResult.cancelled) {
        ctx.ui.notify("New session cancelled", "info");
      }
    },
  });
}
