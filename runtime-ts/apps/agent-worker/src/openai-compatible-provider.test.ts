import { createServer, type Server } from "node:http";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createDevelopmentOpenAiCompatibleModel } from "./process-entry.js";

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("测试 Provider 未监听 TCP");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

describe("开发 OpenAI-compatible Provider", () => {
  it("只请求 Chat Completions，并把 SSE 工具分片还原为 toolUse", async () => {
    const requests: Array<{
      path: string;
      authorization: string | undefined;
      body: Record<string, unknown>;
    }> = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        requests.push({
          path: request.url ?? "",
          authorization: request.headers.authorization,
          body,
        });
        if (request.url !== "/v1/chat/completions") {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "unsupported test route" } }));
          return;
        }

        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const base = {
          id: "chatcmpl-tool-stream",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-chat-model",
        } as const;
        const events = [
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-sandbox-command",
                      type: "function",
                      function: { name: "sandbox_command", arguments: '{"command":' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: '"pwd"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          },
          {
            ...base,
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          },
        ];
        for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end("data: [DONE]\n\n");
      })().catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    const port = await listenOnLoopback(server);
    const apiKey = "test-only-chat-key";

    try {
      const { modelRuntime, model } = await createDevelopmentOpenAiCompatibleModel({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey,
        modelId: "test-chat-model",
        contextWindow: 8_192,
        maxOutputTokens: 2_048,
      });
      const stream = modelRuntime.stream(
        model,
        {
          messages: [{ role: "user", content: "读取 Sandbox 当前目录", timestamp: 1 }],
          tools: [
            {
              name: "sandbox_command",
              description: "在受控 Sandbox 中执行命令",
              parameters: Type.Object({ command: Type.String() }),
            },
          ],
        },
        { maxTokens: 2_048, maxRetries: 0 },
      );
      const eventTypes: string[] = [];
      for await (const event of stream) eventTypes.push(event.type);
      const result = await stream.result();

      expect(eventTypes).toEqual([
        "start",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_delta",
        "toolcall_end",
        "done",
      ]);
      expect(result).toMatchObject({
        api: "openai-completions",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call-sandbox-command",
            name: "sandbox_command",
            arguments: { command: "pwd" },
          },
        ],
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        path: "/v1/chat/completions",
        authorization: `Bearer ${apiKey}`,
        body: {
          model: "test-chat-model",
          stream: true,
          tools: [{ type: "function", function: { name: "sandbox_command" } }],
        },
      });
      expect(requests[0]?.body.max_tokens ?? requests[0]?.body.max_completion_tokens).toBe(2_048);
      expect(JSON.stringify(requests[0]?.body)).not.toContain(apiKey);
      expect(requests.some((request) => request.path.endsWith("/responses"))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });
});
