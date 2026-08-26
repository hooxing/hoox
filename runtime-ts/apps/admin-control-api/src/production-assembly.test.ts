import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminControlApiProcessConfiguration } from "./process-entry.js";
import { createProviderProbes } from "./production-assembly.js";

const configuration: AdminControlApiProcessConfiguration = Object.freeze({
  runtimeEnvironment: "test",
  databaseUrl: "postgresql://control:secret@localhost/control",
  skillPublisherDatabaseUrl: "postgresql://publisher:secret@localhost/control",
  databaseSchema: "agent_runtime",
  betterAuthSecret: "test-better-auth-secret-at-least-thirty-two-bytes",
  listenHost: "127.0.0.1",
  listenPort: 3_003,
  shutdownTimeoutMilliseconds: 5_000,
  providerHostAllowlist: new Set(["model.example.com", "memory.example.com"]),
  objectStorage: Object.freeze({
    endpoint: "http://127.0.0.1:19000",
    bucket: "runtime-skill-publications",
    region: "us-east-1",
    accessKeyId: "publisher",
    secretAccessKey: "publisher-secret",
    forcePathStyle: true,
  }),
  providerSecrets: Object.freeze({
    modelApiKey: "model-secret",
    modelCredentialEncryptionKey: "model-credential-encryption-key-at-least-32-bytes",
    memoryApiKey: "memory-secret",
  }),
  runtimeDeploymentSettings: Object.freeze({
    compactionEnabledConfigured: true,
    compactionPathConfigured: true,
    historyTimeZoneConfigured: true,
    memoryScopeKeyConfigured: true,
  }),
  developmentAuth: Object.freeze({ userId: "user_admin", token: "development-token" }),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Provider 连接探针", () => {
  it("拒绝跟随重定向，避免白名单主机把请求转发到未授权地址", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const probes = createProviderProbes(configuration);
    const apiKey = configuration.providerSecrets.modelApiKey;

    await probes.probeModel(
      {
        providerKey: "main",
        displayName: "主模型",
        protocol: "openai-compatible",
        baseUrl: "https://model.example.com/v1/",
        credentialConfigured: true,
        defaultModelId: "model-a",
        models: [
          {
            id: "model-a",
            name: "Model A",
            enabled: true,
            reasoning: false,
            input: ["text"],
            contextWindow: 128_000,
            maxTokens: 8_192,
          },
        ],
      },
      apiKey,
    );
    await probes.probeMemory({
      providerKey: "memory",
      displayName: "长期记忆",
      providerKind: "mem0",
      baseUrl: "https://memory.example.com/",
      apiSecretRef: "deployment:memory-api",
      scopeSecretRef: "deployment:memory-scope",
      requestTimeoutMs: 5_000,
      enabled: true,
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      new URL("https://model.example.com/v1/chat/completions"),
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      new URL("https://memory.example.com/"),
      expect.objectContaining({ method: "HEAD", redirect: "error" }),
    );
  });

  it("白名单外主机在发起网络请求前失败", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const probes = createProviderProbes(configuration);
    const apiKey = configuration.providerSecrets.modelApiKey;

    await expect(
      probes.probeModel(
        {
          providerKey: "blocked",
          displayName: "未授权模型",
          protocol: "openai-compatible",
          baseUrl: "https://blocked.example.com/v1/",
          credentialConfigured: true,
          defaultModelId: "model-a",
          models: [
            {
              id: "model-a",
              name: "Model A",
              enabled: true,
              reasoning: false,
              input: ["text"],
              contextWindow: 128_000,
              maxTokens: 8_192,
            },
          ],
        },
        apiKey,
      ),
    ).rejects.toThrow("PROVIDER_HOST_NOT_ALLOWED");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("向默认模型发送最小文本生成请求，不依赖 Provider 的模型目录", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
            { status: 200 },
          ),
      );
    vi.stubGlobal("fetch", fetcher);
    const probes = createProviderProbes(configuration);
    const apiKey = configuration.providerSecrets.modelApiKey;
    const provider = {
      providerKey: "main",
      displayName: "主模型",
      protocol: "openai-compatible" as const,
      baseUrl: "https://model.example.com/v1/",
      credentialConfigured: true,
      defaultModelId: "model-a",
      models: [
        {
          id: "model-a",
          name: "Model A",
          enabled: true,
          reasoning: false,
          input: ["text" as const],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
        {
          id: "model-b",
          name: "Model B",
          enabled: false,
          reasoning: true,
          input: ["text" as const],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    };

    await expect(
      probes.probeModel(
        {
          ...provider,
          models: provider.models.map((model) => ({ ...model, enabled: true })),
        },
        apiKey,
      ),
    ).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledOnce();
    const request = fetcher.mock.calls[0];
    expect(request?.[0]).toEqual(new URL("https://model.example.com/v1/chat/completions"));
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      model: "model-a",
      stream: false,
      max_tokens: 32,
      messages: [{ role: "user", content: "Reply with OK." }],
    });
  });
});
