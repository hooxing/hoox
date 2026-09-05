import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createOpenAiCompatiblePiProvider } from "./openai-compatible-provider.js";

const model = {
  id: "custom-chat",
  name: "自定义模型",
  enabled: true,
  reasoning: false,
  input: ["text"] as const,
  contextWindow: 64_000,
  maxTokens: 4_096,
};

describe("已发布 OpenAI-compatible 模型装配", () => {
  it.each(["custom-chat", "deepseek-v4-flash"])(
    "%s 保留 Chat Completions 请求、认证与思考协议",
    async (modelId) => {
      const requests: {
        path: string;
        headers: Record<string, unknown>;
        body: Record<string, unknown>;
      }[] = [];
      const server = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          requests.push({
            path: request.url ?? "",
            headers: request.headers,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          });
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const chunk of [
            {
              choices: [
                { index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: null },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
          ]) {
            response.write(
              `data: ${JSON.stringify({ id: "test-completion", object: "chat.completion.chunk", created: 1, model: modelId, ...chunk })}\n\n`,
            );
          }
          response.end("data: [DONE]\n\n");
        })().catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("测试服务未监听");
        const runtime = await createOpenAiCompatiblePiProvider({
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "test-only-wire-key",
          defaultModelId: modelId,
          models: [{ ...model, id: modelId, reasoning: true }],
        });
        expect(runtime.model).toMatchObject({
          provider: "runtime-openai-compatible",
          api: "openai-completions",
          id: modelId,
          reasoning: true,
          contextWindow: 64_000,
          maxTokens: 4_096,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });
        const result = await runtime.modelRuntime.complete(
          { ...runtime.model, headers: { "x-model-boundary": "model", "x-precedence": "model" } },
          {
            systemPrompt: "稳定系统指令",
            messages: [{ role: "user", content: "开始", timestamp: 1 }],
          },
          {
            maxTokens: 512,
            maxRetries: 0,
            reasoningEffort: "high",
            headers: { "x-request-boundary": "request", "x-precedence": "request" },
            transformHeaders: (headers) => ({ ...headers, "x-final-boundary": "transformed" }),
          },
        );
        expect(result.stopReason).toBe("stop");
        expect(result.usage).toMatchObject({ input: 7, output: 3, totalTokens: 10 });
        expect(requests).toHaveLength(1);
        const request = requests[0];
        expect(request?.path).toBe("/v1/chat/completions");
        expect(request?.headers.authorization === "Bearer test-only-wire-key").toBe(true);
        expect(request?.headers).toMatchObject({
          "x-model-boundary": "model",
          "x-request-boundary": "request",
          "x-precedence": "request",
          "x-final-boundary": "transformed",
        });
        expect(request?.body).toMatchObject({
          model: modelId,
          stream: true,
          stream_options: { include_usage: true },
        });
        if (modelId === "deepseek-v4-flash") {
          expect(request?.body).toMatchObject({
            max_tokens: 512,
            thinking: { type: "enabled" },
            messages: [
              { role: "system", content: "稳定系统指令" },
              { role: "user", content: "开始" },
            ],
          });
          expect(request?.body).not.toHaveProperty("reasoning_effort");
          expect(request?.body).not.toHaveProperty("store");
        } else {
          expect(request?.body).toMatchObject({
            max_completion_tokens: 512,
            reasoning_effort: "high",
            store: false,
            messages: [
              { role: "developer", content: "稳定系统指令" },
              { role: "user", content: "开始" },
            ],
          });
        }
        expect(JSON.stringify(request?.body).includes("test-only-wire-key")).toBe(false);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it("相同 Provider 标识的独立配置不会共享凭据或模型目录", async () => {
    const [first, second] = await Promise.all(
      ["first", "second"].map((label) =>
        createOpenAiCompatiblePiProvider({
          baseUrl: `https://${label}.example.com/v1`,
          apiKey: `${label}-test-only-key`,
          defaultModelId: label,
          models: [{ ...model, id: label }],
        }),
      ),
    );
    if (!first || !second) throw new Error("测试未完成模型装配");
    for (const [runtime, label] of [
      [first, "first"],
      [second, "second"],
    ] as const) {
      expect(runtime.modelRuntime.getProviders().map((provider) => provider.id)).toEqual([
        "runtime-openai-compatible",
      ]);
      expect(runtime.modelRuntime.getModels().map((candidate) => candidate.id)).toEqual([label]);
      const auth = await runtime.modelRuntime.getAuth(runtime.model);
      expect(auth?.auth.apiKey === `${label}-test-only-key`).toBe(true);
      expect(JSON.stringify(runtime.model).includes("test-only-key")).toBe(false);
    }
    await first.modelRuntime.logout(first.model.provider);
    expect(await first.modelRuntime.getAuth(first.model)).toBeUndefined();
    expect(
      (await second.modelRuntime.getAuth(second.model))?.auth.apiKey === "second-test-only-key",
    ).toBe(true);
  });

  it("默认模型未启用时拒绝装配，不回退到内置目录", async () => {
    await expect(
      createOpenAiCompatiblePiProvider({
        baseUrl: "https://model.example.com/v1",
        apiKey: "test-only-key",
        defaultModelId: model.id,
        models: [{ ...model, enabled: false }],
      }),
    ).rejects.toThrow("模型 Provider 默认模型无效");
  });
});
