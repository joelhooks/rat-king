import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export declare function makePromptStream(): {
  stream: AsyncGenerator<SDKUserMessage>;
  push: (message: SDKUserMessage) => Promise<void>;
  end: () => void;
  fail: (error: Error) => void;
};
export declare function userMessage(
  content: SDKUserMessage["message"]["content"],
  priority?: SDKUserMessage["priority"]
): SDKUserMessage;
