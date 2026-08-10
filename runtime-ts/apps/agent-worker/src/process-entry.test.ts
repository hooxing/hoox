import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assembleModelWireTraceIfEnabled,
  createDevelopmentOpenAiCompatibleModel,
  parseWorkerProcessEnvironment,
  probeOpenAiCompatibleModel,
  selectWorkerProcessEnvironment,
  startWorkerLoopAfterDependencyProbes,
  startWorkerProcess,
} from "./process-entry.js";

function productionEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "production",
    DATABASE_URL: "postgresql://runtime:credential@database:5432/runtime?sslmode=verify-full",
    DATABASE_RUNTIME_ROLE: "runtime",
    DATABASE_SCHEMA: "runtime",
    S3_ENDPOINT: "https://object-storage.example.invalid:9000",
    S3_BUCKET: "runtime-artifacts",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "local-access-key",
    S3_SECRET_ACCESS_KEY: "opaque-test-value",
    S3_FORCE_PATH_STYLE: "true",
    CUBESANDBOX_API_URL: "https://sandbox.example.invalid:3000",
    CUBESANDBOX_PROXY_SCHEME: "https",
    CUBESANDBOX_TEMPLATE_ID: "tpl-test",
    CUBESANDBOX_RESOURCE_VOLUME_DRIVER: "runtime-resourcefs",
    MODEL_BASE_URL: "https://model.invalid/v1",
    MODEL_API_KEY: "opaque-model-value",
    MODEL_ID: "test-model",
    MODEL_SUPPORTS_IMAGES: "false",
    MODEL_CONTEXT_WINDOW: "128000",
    MODEL_MAX_OUTPUT_TOKENS: "16384",
    MODEL_WIRE_TRACE_ENABLED: "false",
    MODEL_WIRE_TRACE_RETENTION_DAYS: "7",
    MODEL_WIRE_TRACE_MAX_BYTES: "1048576",
    AGENT_WORKER_TENANT_ID: "tenant-test-worker",
    AGENT_WORKER_ID: "worker-test",
    AGENT_WORKER_POLL_INTERVAL_MS: "100",
    AGENT_WORKER_DISPATCH_LEASE_MS: "30000",
    AGENT_WORKER_RUN_LEASE_MS: "30000",
    AGENT_WORKER_RUN_TIMEOUT_MS: "43200000",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
  };
}

describe("Agent Worker 进程入口", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("production 在解析最早边界拒绝继承的 Node TLS/代理覆盖", () => {
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      }),
    ).toThrow("PRODUCTION_INHERITED_ENVIRONMENT_FORBIDDEN");
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        CUBE_API_KEY: "ambient-attacker-key",
      }),
    ).toThrow("PRODUCTION_INHERITED_ENVIRONMENT_FORBIDDEN");
  });

  it("Worker 投影模型报文配置但不继承其他服务秘密", () => {
    const projected = selectWorkerProcessEnvironment({
      ...productionEnvironment(),
      API_JWT_SIGNING_KEYS: "api-only-secret-canary",
    });
    expect(projected).toMatchObject({
      MODEL_WIRE_TRACE_ENABLED: "false",
      MODEL_WIRE_TRACE_RETENTION_DAYS: "7",
      MODEL_WIRE_TRACE_MAX_BYTES: "1048576",
    });
    expect(projected.API_JWT_SIGNING_KEYS).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain("api-only-secret-canary");
  });

  it("Thread Context flags 强制 read→shadow→write→serial，默认开启且阈值可配置", () => {
    expect(parseWorkerProcessEnvironment(productionEnvironment()).threadContext).toEqual({
      serialQueueV2Enabled: true,
      writeEnabled: true,
      shadowReadEnabled: true,
      readEnabled: true,
      inputRoutingEnabled: true,
      inlineBodyMaxBytes: 16 * 1024,
      compaction: {
        enabled: true,
        path: "local",
        softLimitPercent: 80,
        targetPercent: 55,
        recentUserTokens: 4096,
        maxOutputTokens: 16384,
        timeoutMs: 60000,
      },
    });
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        THREAD_CONTEXT_V2_READ_ENABLED: "true",
        THREAD_CONTEXT_V2_SHADOW_READ_ENABLED: "false",
      }),
    ).toThrow("依赖 shadow read");
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        THREAD_CONTEXT_V2_WRITE_ENABLED: "true",
        THREAD_SERIAL_QUEUE_V2_ENABLED: "false",
      }),
    ).toThrow("依赖 Thread 串行队列");
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        THREAD_INPUT_ROUTING_V2_ENABLED: "true",
        THREAD_CONTEXT_V2_READ_ENABLED: "false",
      }),
    ).toThrow("依赖串行队列与 V2 Context read");
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        THREAD_CONTEXT_COMPACTION_ENABLED: "true",
        THREAD_CONTEXT_V2_WRITE_ENABLED: "false",
        THREAD_CONTEXT_V2_SHADOW_READ_ENABLED: "false",
        THREAD_CONTEXT_V2_READ_ENABLED: "false",
        THREAD_INPUT_ROUTING_V2_ENABLED: "false",
      }),
    ).toThrow("依赖串行队列与 V2 Context write/read");
    expect(
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        THREAD_SERIAL_QUEUE_V2_ENABLED: "true",
        THREAD_CONTEXT_V2_WRITE_ENABLED: "true",
        THREAD_CONTEXT_V2_SHADOW_READ_ENABLED: "true",
        THREAD_CONTEXT_V2_READ_ENABLED: "true",
        THREAD_INPUT_ROUTING_V2_ENABLED: "true",
        THREAD_CONTEXT_INLINE_BODY_MAX_BYTES: "32768",
        THREAD_CONTEXT_COMPACTION_ENABLED: "true",
        THREAD_CONTEXT_COMPACTION_SOFT_LIMIT_PERCENT: "75",
        THREAD_CONTEXT_COMPACTION_TARGET_PERCENT: "50",
      }).threadContext,
    ).toMatchObject({
      writeEnabled: true,
      shadowReadEnabled: true,
      readEnabled: true,
      inputRoutingEnabled: true,
      inlineBodyMaxBytes: 32768,
      compaction: expect.objectContaining({
        enabled: true,
        path: "local",
        softLimitPercent: 75,
        targetPercent: 50,
      }),
    });
  });

  it("Thread Sandbox reuse 默认开启，显式配置仍校验依赖并保持策略参数可配置", () => {
    expect(parseWorkerProcessEnvironment(productionEnvironment()).threadSandbox).toEqual({
      reuseEnabled: true,
      sessionTtlSeconds: 43_800,
      pausedRetentionSeconds: 86_400,
      lifecycleTimeoutMs: 90_000,
    });
    expect(parseWorkerProcessEnvironment(productionEnvironment()).worker.runTimeoutMs).toBe(
      43_200_000,
    );
    expect(parseWorkerProcessEnvironment(productionEnvironment()).subagents).toEqual({
      enabled: true,
    });
    expect(
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        SUBAGENTS_ENABLED: "false",
      }).subagents,
    ).toEqual({ enabled: false });
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        CUBESANDBOX_SESSION_TTL_SECONDS: "120",
      }),
    ).toThrow("必须覆盖 AGENT_WORKER_RUN_TIMEOUT_MS 与 Sandbox 收敛窗口");
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        THREAD_SANDBOX_SESSION_REUSE_ENABLED: "true",
        THREAD_CONTEXT_V2_READ_ENABLED: "false",
        THREAD_INPUT_ROUTING_V2_ENABLED: "false",
        THREAD_CONTEXT_COMPACTION_ENABLED: "false",
      }),
    ).toThrow("依赖串行队列与 V2 Context write/read");
    expect(
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        THREAD_SERIAL_QUEUE_V2_ENABLED: "true",
        THREAD_CONTEXT_V2_WRITE_ENABLED: "true",
        THREAD_CONTEXT_V2_SHADOW_READ_ENABLED: "true",
        THREAD_CONTEXT_V2_READ_ENABLED: "true",
        THREAD_SANDBOX_SESSION_REUSE_ENABLED: "true",
        CUBESANDBOX_SESSION_TTL_SECONDS: "86400",
        THREAD_SANDBOX_PAUSED_RETENTION_SECONDS: "1800",
        THREAD_SANDBOX_LIFECYCLE_TIMEOUT_MS: "120000",
      }).threadSandbox,
    ).toEqual({
      reuseEnabled: true,
      sessionTtlSeconds: 86_400,
      pausedRetentionSeconds: 1_800,
      lifecycleTimeoutMs: 120_000,
    });
  });

  it("production 的 PG 角色证明失败时不触达 S3、Cube、模型或消费循环", async () => {
    const databaseFailure = new Error("POSTGRES_RUNTIME_ROLE_UNSAFE");
    const probes = {
      postgres: vi.fn(async () => Promise.reject(databaseFailure)),
      objectStorage: vi.fn(async () => undefined),
      sandbox: vi.fn(async () => undefined),
      model: vi.fn(async () => undefined),
    };
    const startLoop = vi.fn();
    await expect(
      startWorkerLoopAfterDependencyProbes("production", probes, startLoop),
    ).rejects.toBe(databaseFailure);
    expect(probes.objectStorage).not.toHaveBeenCalled();
    expect(probes.sandbox).not.toHaveBeenCalled();
    expect(probes.model).not.toHaveBeenCalled();
    expect(startLoop).not.toHaveBeenCalled();
  });

  it("生产入口固定使用内建真实装配器，拒绝调用方注入 Fake", async () => {
    const configuration = parseWorkerProcessEnvironment(productionEnvironment());
    expect(configuration.sandbox.templateId).toBe("tpl-test");
    expect(configuration.sandbox).toMatchObject({
      apiUrl: "https://sandbox.example.invalid:3000",
      proxyNodeIp: "sandbox.example.invalid",
      proxyScheme: "https",
    });
    await expect(
      startWorkerProcess({
        environment: productionEnvironment(),
        assembler: {
          assemble: async () => ({
            stopAccepting: async () => undefined,
            resources: [],
            readiness: [],
          }),
        },
      }),
    ).rejects.toThrow("PRODUCTION_ASSEMBLY_UNAVAILABLE:agent-worker");
  });

  it("production 启用模型报文诊断时在 Pool、fetch 与 assembler 副作用前失败关闭", async () => {
    const fetchSpy = vi.fn();
    const assembleSpy = vi.fn(async () => ({
      stopAccepting: async () => undefined,
      resources: [],
      readiness: [],
    }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      startWorkerProcess({
        environment: {
          ...productionEnvironment(),
          MODEL_WIRE_TRACE_ENABLED: "true",
        },
        // 整个 assembler 都未进入，因而其内部 Pool 及所有远端依赖也不可能创建。
        assembler: { assemble: assembleSpy },
      }),
    ).rejects.toThrow("MODEL_WIRE_TRACE_ENABLED 在 production 需要已部署保留清理消费者");

    expect(assembleSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("development 严格解析并按开关原子装配模型报文诊断", () => {
    const enabled = parseWorkerProcessEnvironment({
      ...productionEnvironment(),
      RUNTIME_ENV: "development",
      AGENT_WORKER_TENANT_ID: "tenant-dev-user-a",
      DEV_AUTH_ENABLED: "true",
      DEV_AUTH_USER_A_TENANT_ID: "tenant-dev-user-a",
      MODEL_SUPPORTS_IMAGES: "true",
      MODEL_WIRE_TRACE_ENABLED: "true",
      MODEL_WIRE_TRACE_RETENTION_DAYS: "13",
      MODEL_WIRE_TRACE_MAX_BYTES: "4096",
    });
    expect(enabled.model).toMatchObject({
      wireTraceEnabled: true,
      wireTraceRetentionDays: 13,
      wireTraceMaxBytes: 4096,
    });

    const enabledCalls: string[] = [];
    const session = Object.freeze({ kind: "model-wire-session" });
    expect(
      assembleModelWireTraceIfEnabled(enabled.model.wireTraceEnabled, {
        installFetchInstrumentation: () => enabledCalls.push("install"),
        createSession: () => {
          enabledCalls.push("create");
          return session;
        },
      }),
    ).toBe(session);
    expect(enabledCalls).toEqual(["install", "create"]);

    const disabled = parseWorkerProcessEnvironment({
      ...productionEnvironment(),
      RUNTIME_ENV: "development",
      AGENT_WORKER_TENANT_ID: "tenant-dev-user-a",
      DEV_AUTH_ENABLED: "true",
      DEV_AUTH_USER_A_TENANT_ID: "tenant-dev-user-a",
      MODEL_WIRE_TRACE_ENABLED: "false",
    });
    const installDisabled = vi.fn();
    const createDisabled = vi.fn();
    expect(
      assembleModelWireTraceIfEnabled(disabled.model.wireTraceEnabled, {
        installFetchInstrumentation: installDisabled,
        createSession: createDisabled,
      }),
    ).toBeUndefined();
    expect(installDisabled).not.toHaveBeenCalled();
    expect(createDisabled).not.toHaveBeenCalled();
  });

  it("Worker 数据面默认与 CubeAPI 同机，显式 Proxy 配置仍优先", () => {
    expect(
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        CUBESANDBOX_PROXY_NODE_IP: "10.0.0.8",
        CUBESANDBOX_PROXY_PORT: "8443",
        CUBESANDBOX_PROXY_SCHEME: "https",
      }).sandbox,
    ).toMatchObject({
      proxyNodeIp: "10.0.0.8",
      proxyPort: 8443,
      proxyScheme: "https",
    });
  });

  it("Worker 只显式配置 Proxy 端口时保留节点推导并按 443 选择 https", () => {
    expect(
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        CUBESANDBOX_PROXY_PORT: "443",
      }).sandbox,
    ).toMatchObject({
      proxyNodeIp: "sandbox.example.invalid",
      proxyPort: 443,
      proxyScheme: "https",
    });
  });

  it("production 拒绝任何 development 身份变量，即使值为 false 或并未被 Worker 使用", () => {
    expect(() =>
      parseWorkerProcessEnvironment({ ...productionEnvironment(), DEV_AUTH_ENABLED: "false" }),
    ).toThrow("FORBIDDEN_IN_PRODUCTION:DEV_AUTH_ENABLED");
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        DEV_AUTH_USER_B_ID: "copied-development-fixture",
      }),
    ).toThrow("FORBIDDEN_IN_PRODUCTION:DEV_AUTH_USER_B_ID");
  });

  it("production 在连接外部凭据端点前拒绝明文传输", () => {
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        MODEL_BASE_URL: "http://model.internal/v1",
      }),
    ).toThrow("MODEL_BASE_URL 在 production 必须为无凭据的 HTTPS URL");
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        S3_ENDPOINT: "http://object-storage.internal:9000",
      }),
    ).toThrow("S3_ENDPOINT 在 production 必须为无凭据的 HTTPS URL");
    const keylessPlaintextCube: Record<string, string> = {
      ...productionEnvironment(),
      CUBESANDBOX_API_URL: "http://sandbox.internal",
    };
    expect(() => parseWorkerProcessEnvironment(keylessPlaintextCube)).toThrow(
      "CUBESANDBOX_API_URL 在 production 必须为无凭据的 HTTPS URL",
    );
    const missingProxyTls = productionEnvironment();
    delete missingProxyTls.CUBESANDBOX_PROXY_SCHEME;
    expect(() => parseWorkerProcessEnvironment(missingProxyTls)).toThrow(
      "CUBESANDBOX_PROXY_SCHEME 在 production 必须为 https",
    );
  });

  it("部署 Worker tenant 与数据库运行角色在解析期均受严格格式限制", () => {
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        AGENT_WORKER_TENANT_ID: "not a tenant",
      }),
    ).toThrow("ID 格式无效");
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        DATABASE_RUNTIME_ROLE: "Runtime-Owner",
      }),
    ).toThrow("DATABASE_RUNTIME_ROLE 格式无效");
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        DATABASE_URL: "postgresql://runtime:credential@database/runtime?sslmode=disable",
      }),
    ).toThrow("PRODUCTION_DATABASE_TRANSPORT_INVALID");
  });

  it("缺少模型依赖时在装配前失败且不泄漏其他秘密", () => {
    const source = productionEnvironment();
    const secret = source.S3_SECRET_ACCESS_KEY;
    delete source.MODEL_API_KEY;
    try {
      parseWorkerProcessEnvironment(source);
      expect.fail("应当拒绝缺失的模型密钥");
    } catch (error) {
      expect(String(error)).toContain("MISSING:MODEL_API_KEY");
      expect(String(error)).not.toContain(secret);
    }
  });

  it("模型预算元数据是严格必填配置", () => {
    const source = productionEnvironment();
    delete source.MODEL_CONTEXT_WINDOW;
    expect(() => parseWorkerProcessEnvironment(source)).toThrow("MISSING:MODEL_CONTEXT_WINDOW");
  });

  it("模型最大输出预算不能超过上下文窗口", () => {
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        MODEL_CONTEXT_WINDOW: "4096",
        MODEL_MAX_OUTPUT_TOKENS: "4097",
      }),
    ).toThrow("MODEL_MAX_OUTPUT_TOKENS 不能大于 MODEL_CONTEXT_WINDOW");
    expect(
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        MODEL_CONTEXT_WINDOW: "4096",
        MODEL_MAX_OUTPUT_TOKENS: "4096",
      }).model,
    ).toMatchObject({ contextWindow: 4096, maxOutputTokens: 4096 });
  });

  it("开发 Worker 强制消费 dev-user-a 的同一租户", () => {
    const source = {
      ...productionEnvironment(),
      RUNTIME_ENV: "development",
      AGENT_WORKER_TENANT_ID: "tenant-dev-user-a",
      DEV_AUTH_ENABLED: "true",
      DEV_AUTH_USER_A_TENANT_ID: "tenant-dev-user-a",
    };
    expect(parseWorkerProcessEnvironment(source).development?.userATenantId).toBe(
      "tenant-dev-user-a",
    );
    expect(() =>
      parseWorkerProcessEnvironment({ ...source, AGENT_WORKER_TENANT_ID: "other-tenant" }),
    ).toThrow("AGENT_WORKER_TENANT_ID 必须与 DEV_AUTH_USER_A_TENANT_ID 一致");
  });

  it("开发模型装配固定使用 Chat Completions 且保留显式预算", async () => {
    const configuration = parseWorkerProcessEnvironment({
      ...productionEnvironment(),
      RUNTIME_ENV: "development",
      AGENT_WORKER_TENANT_ID: "tenant-dev-user-a",
      DEV_AUTH_ENABLED: "true",
      DEV_AUTH_USER_A_TENANT_ID: "tenant-dev-user-a",
      MODEL_SUPPORTS_IMAGES: "true",
    });

    const { model } = await createDevelopmentOpenAiCompatibleModel(configuration.model);

    expect(model).toMatchObject({
      api: "openai-completions",
      id: configuration.model.modelId,
      contextWindow: configuration.model.contextWindow,
      maxTokens: configuration.model.maxOutputTokens,
      input: ["text", "image"],
    });
    expect(JSON.stringify(model)).not.toContain(configuration.model.apiKey);
  });

  it("DeepSeek V4 Flash 使用官方 0731 模型能力和 Pi 兼容配置", async () => {
    const configuration = parseWorkerProcessEnvironment({
      ...productionEnvironment(),
      MODEL_ID: "deepseek-v4-flash",
      MODEL_SUPPORTS_IMAGES: "false",
      MODEL_CONTEXT_WINDOW: "1048576",
      MODEL_MAX_OUTPUT_TOKENS: "65536",
    });

    const { model } = await createDevelopmentOpenAiCompatibleModel(configuration.model);

    expect(model).toMatchObject({
      id: "deepseek-v4-flash",
      reasoning: true,
      input: ["text"],
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      },
    });
  });

  it("开发 readiness 只要求 /models 返回已配置 model id", async () => {
    const model = parseWorkerProcessEnvironment({
      ...productionEnvironment(),
      RUNTIME_ENV: "development",
      AGENT_WORKER_TENANT_ID: "tenant-dev-user-a",
      DEV_AUTH_ENABLED: "true",
      DEV_AUTH_USER_A_TENANT_ID: "tenant-dev-user-a",
    }).model;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: model.modelId }] }))),
    );
    await expect(probeOpenAiCompatibleModel(model, "development")).resolves.toBeUndefined();
  });

  it("生产 readiness 不因 development 的 id-only Provider 放宽模型预算元数据", async () => {
    const model = parseWorkerProcessEnvironment(productionEnvironment()).model;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: model.modelId }] }))),
    );
    await expect(probeOpenAiCompatibleModel(model, "production")).rejects.toThrow(
      "模型 provider 元数据与配置不一致",
    );
  });
});
describe("个人历史目录配置", () => {
  it("默认关闭挂载并使用上海时区，显式配置会进入 Worker", () => {
    expect(parseWorkerProcessEnvironment(productionEnvironment())).toMatchObject({
      historyFilesystemEnabled: false,
      historyDirectoryTimeZone: "Asia/Shanghai",
    });
    expect(
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        HISTORY_FILESYSTEM_ENABLED: "true",
        HISTORY_DIRECTORY_TIME_ZONE: "America/Los_Angeles",
      }),
    ).toMatchObject({
      historyFilesystemEnabled: true,
      historyDirectoryTimeZone: "America/Los_Angeles",
    });
  });

  it("拒绝无效历史目录时区", () => {
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        HISTORY_DIRECTORY_TIME_ZONE: "Mars/Base",
      }),
    ).toThrow("HISTORY_DIRECTORY_TIME_ZONE 无效");
  });
});
