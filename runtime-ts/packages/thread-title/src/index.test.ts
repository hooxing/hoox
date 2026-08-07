import { describe, expect, it, vi } from "vitest";
import {
  normalizeGeneratedThreadTitle,
  OpenAiCompatibleThreadTitleGenerator,
  parseGeneratedThreadTitle,
  ThreadTitleGenerationConsumer,
  ThreadTitleGenerationError,
  type ThreadTitleGenerationClaim,
  type ThreadTitleGenerationStore,
} from "./index.js";

const claim = Object.freeze({
  tenantId: "tenant-a",
  threadId: "thread-a",
  sourceReceiptId: "receipt-a",
  requestDigest: "a".repeat(64),
  expectedTitleGenerationVersion: 0,
  claimToken: "claim-a",
  claimGeneration: 1,
  attemptCount: 1,
  sourceText: "请审查这份采购合同并找出付款风险",
  attachments: Object.freeze([
    Object.freeze({ name: "供应商采购合同.docx", mediaType: "application/vnd.openxmlformats" }),
  ]),
}) satisfies ThreadTitleGenerationClaim;

describe("低成本 Thread 标题模型", () => {
  it("严格解析单字段 JSON，并清理文件系统危险字符", () => {
    expect(parseGeneratedThreadTitle('{"title":"采购合同/付款风险"}')).toBe("采购合同-付款风险");
    expect(() => parseGeneratedThreadTitle('```json\n{"title":"合同审查"}\n```')).toThrow(
      "INVALID_RESPONSE",
    );
    expect(() => parseGeneratedThreadTitle('{"title":"合同审查","reason":"x"}')).toThrow(
      "INVALID_RESPONSE",
    );
    expect(() => normalizeGeneratedThreadTitle("2026-08-07 合同审查")).toThrow("INVALID_TITLE");
  });

  it("只提交受限原文与附件元数据，不启用工具或流式输出", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"采购合同付款风险"}' } }],
          usage: { prompt_tokens: 42, completion_tokens: 8 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    let now = 1_000;
    const generator = new OpenAiCompatibleThreadTitleGenerator({
      baseUrl: "https://model.example.invalid/v1",
      apiKey: "secret-token",
      modelId: "cheap-title-model",
      inputMaximumBytes: 256,
      fetcher,
      now: () => {
        now += 25;
        return now;
      },
    });

    const result = await generator.generate({
      ...claim,
      sourceText: `${claim.sourceText}${"长".repeat(300)}`,
    });
    expect(result).toMatchObject({
      title: "采购合同付款风险",
      durationMs: 25,
      promptTokens: 42,
      completionTokens: 8,
    });
    expect(result.modelKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://model.example.invalid/v1/chat/completions");
    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "cheap-title-model", stream: false, temperature: 0 });
    expect(body).not.toHaveProperty("tools");
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    const dynamic = JSON.parse(String(messages[1]?.content)) as Record<string, unknown>;
    expect(Buffer.byteLength(String(dynamic.input), "utf8")).toBeLessThanOrEqual(256);
    expect(dynamic.attachments).toEqual([
      { name: "供应商采购合同.docx", mediaType: "application/vnd.openxmlformats" },
    ]);
  });

  it("不回显 Provider 错误正文，并将超时收敛为稳定错误码", async () => {
    const unavailable = new OpenAiCompatibleThreadTitleGenerator({
      baseUrl: "https://model.example.invalid/v1",
      apiKey: "secret-token",
      modelId: "cheap-title-model",
      fetcher: async () => new Response("provider leaked secret", { status: 503 }),
    });
    await expect(unavailable.generate(claim)).rejects.toEqual(
      expect.objectContaining({ code: "PROVIDER_UNAVAILABLE" }),
    );

    const timeout = new OpenAiCompatibleThreadTitleGenerator({
      baseUrl: "https://model.example.invalid/v1",
      apiKey: "secret-token",
      modelId: "cheap-title-model",
      timeoutMs: 1_000,
      fetcher: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    await expect(timeout.generate(claim)).rejects.toEqual(
      expect.objectContaining({ code: "MODEL_TIMEOUT" }),
    );
  });

  it("对没有 Content-Length 的分块响应也执行字节上限", async () => {
    const oversized = new OpenAiCompatibleThreadTitleGenerator({
      baseUrl: "https://model.example.invalid/v1",
      apiKey: "secret-token",
      modelId: "cheap-title-model",
      fetcher: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(40_000));
              controller.enqueue(new Uint8Array(40_000));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    });

    await expect(oversized.generate(claim)).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_RESPONSE" }),
    );
  });
});

class FakeStore implements ThreadTitleGenerationStore {
  readonly complete = vi.fn(async () => true);
  readonly fail = vi.fn(async () => true);
  private delivered = false;

  async claimNext(): Promise<ThreadTitleGenerationClaim | undefined> {
    if (this.delivered) return undefined;
    this.delivered = true;
    return claim;
  }
}

describe("标题 Outbox 消费器", () => {
  it("成功时只提交 claim-fenced 完成", async () => {
    const store = new FakeStore();
    const consumer = new ThreadTitleGenerationConsumer(
      store,
      {
        generate: vi.fn(async () => ({
          title: "采购合同付款风险",
          modelKey: "b".repeat(64),
          durationMs: 120,
        })),
      },
      "scheduler-a",
      30_000,
      3,
      1_000,
    );
    await expect(consumer.drainTenant("tenant-a")).resolves.toBe(1);
    expect(store.complete).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ title: "采购合同付款风险" }),
    );
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("模型错误只写稳定类别并由 Store 决定重试或 fallback", async () => {
    const store = new FakeStore();
    const consumer = new ThreadTitleGenerationConsumer(
      store,
      {
        generate: vi.fn(async () => {
          throw new ThreadTitleGenerationError("INVALID_TITLE");
        }),
      },
      "scheduler-a",
      30_000,
      3,
      1_000,
    );
    await expect(consumer.drainTenant("tenant-a")).resolves.toBe(1);
    expect(store.fail).toHaveBeenCalledWith(claim, {
      errorCode: "INVALID_TITLE",
      maximumAttempts: 3,
      retryBaseMs: 1_000,
    });
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("数据库完成写回失败不会被误记成模型失败", async () => {
    const store = new FakeStore();
    store.complete.mockRejectedValue(new Error("database unavailable"));
    const consumer = new ThreadTitleGenerationConsumer(
      store,
      {
        generate: vi.fn(async () => ({
          title: "采购合同付款风险",
          modelKey: "b".repeat(64),
          durationMs: 120,
        })),
      },
      "scheduler-a",
      30_000,
      3,
      1_000,
    );
    await expect(consumer.drainTenant("tenant-a")).rejects.toThrow("database unavailable");
    expect(store.fail).not.toHaveBeenCalled();
  });
});
