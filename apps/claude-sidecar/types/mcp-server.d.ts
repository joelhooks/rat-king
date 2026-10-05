import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

import type { ChatRequest } from "../src/port.ts";

interface Tool {
  name: string;
  description: string;
  inputSchema: NonNullable<
    ChatRequest["tools"]
  >[number]["function"]["parameters"];
  handler: (id: string) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }>;
}

export declare function createToolServer(
  name: string,
  tools: Tool[]
): McpSdkServerConfigWithInstance & { listed: Promise<void> };
