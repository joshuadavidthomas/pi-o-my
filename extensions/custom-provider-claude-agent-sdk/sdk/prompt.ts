import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "@earendil-works/pi-ai";

export interface PromptTextBlock {
  type: "text";
  text: string;
}

export type PromptImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface PromptImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: PromptImageMediaType;
    data: string;
  };
}

export type PromptBlock = PromptTextBlock | PromptImageBlock;

export function isSupportedImageMediaType(value: string): value is PromptImageMediaType {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(value);
}

export function extractLatestUserPrompt(context: Context): string | PromptBlock[] {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message.role !== "user") continue;

    if (typeof message.content === "string") {
      return message.content;
    }

    const blocks = message.content.flatMap<PromptBlock>((item) => {
      if (item.type === "text") {
        return [{ type: "text", text: item.text }];
      }

      if (item.type === "image") {
        const mediaType = item.mimeType;
        if (isSupportedImageMediaType(mediaType)) {
          return [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: item.data,
              },
            },
          ];
        }
      }

      return [];
    });

    if (blocks.length === 0) continue;

    if (blocks.every((block): block is PromptTextBlock => block.type === "text")) {
      return blocks.map((block) => block.text).join("\n");
    }

    return blocks;
  }

  throw new Error("No user prompt found in context");
}

export function toSdkPrompt(prompt: string | PromptBlock[]): string | AsyncIterable<SDKUserMessage> {
  if (typeof prompt === "string") return prompt;

  return (async function* () {
    yield {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
      shouldQuery: true,
    } satisfies SDKUserMessage;
  })();
}

export function piContentToSdkPromptContent(content: unknown): string | PromptBlock[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const blocks = content.flatMap<PromptBlock>((item) => {
    if (!item || typeof item !== "object") return [];
    const block = item as Record<string, unknown>;

    if (block.type === "text" && typeof block.text === "string") {
      return [{ type: "text", text: block.text }];
    }

    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      const mediaType = block.mimeType;
      if (isSupportedImageMediaType(mediaType)) {
        return [{ type: "image", source: { type: "base64", media_type: mediaType, data: block.data } }];
      }
    }

    return [];
  });

  if (blocks.length === 0) return "";
  if (blocks.every((block): block is PromptTextBlock => block.type === "text")) {
    return blocks.map((block) => block.text).join("\n");
  }
  return blocks;
}


