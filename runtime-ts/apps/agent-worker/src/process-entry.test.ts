import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleModelWireTraceIfEnabled,
  createDevelopmentOpenAiCompatibleModel,
  createOpenAiCompatibleModelContextCapability,
  createOpenAiCompatibleProvider,
  parseWorkerProcessEnvironment,
  probeOpenAiCompatibleModel,
  selectWorkerProcessEnvironment,
  startWorkerLoopAfterDependencyProbes,
  startWorkerProcess,
} from "./process-entry.js";
import { resolveRuntimeModelProbeConfiguration } from "./runtime-configured-providers.js";

function productionEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "production",
    DATABASE_URL: "postgresql://runtime:credential@database:5432/runtime?sslmode=verify-full",
    DATABASE_RUNTIME_ROLE: "runtime",
    DATABASE_WORKER_COORDINATOR_URL:
      "postgresql://worker_coordinator:credential@database:5432/runtime?sslmode=verify-full",
    DATABASE_WORKER_COORDINATOR_ROLE: "worker_coordinator",
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
    MODEL_CREDENTIAL_ENCRYPTION_KEY: "production-model-credential-root-at-least-32-bytes",
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
  it("没有部署回退模型时允许启动装配，并保留稳定加密根", () => {
    const env = productionEnvironment();
    for (const key of [
      "MODEL_BASE_URL",
      "MODEL_API_KEY",
      "MODEL_ID",
      "MODEL_CONTEXT_WINDOW",
      "MODEL_MAX_OUTPUT_TOKENS",
      "MODEL_SUPPORTS_IMAGES",
    ])
      delete env[key];
    const configuration = parseWorkerProcessEnvironment(env);
    expect(configuration.model.apiKey).toBe("");
    expect(configuration.model.credentialEncryptionKey).toBe(env.MODEL_CREDENTIAL_ENCRYPTION_KEY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("腾讯云 AGS 与 E2B 使用独立配置，缺少 AGS 凭据时失败关闭", () => {
    const env = {
      ...productionEnvironment(),
      SANDBOX_DEFAULT_PROVIDER: "tencent-ags",
      SANDBOX_ENABLED_PROVIDERS: "e2b,tencent-ags",
      E2B_API_KEY: "test-e2b",
      E2B_TEMPLATE_ID: "base",
      TENCENT_AGS_API_KEY: "test-ags",
      TENCENT_AGS_DOMAIN: "ags.example.invalid",
      TENCENT_AGS_TEMPLATE_ID: "hoox",
    };
    expect(parseWorkerProcessEnvironment(env).sandbox).toMatchObject({
      defaultProviderKey: "tencent-ags",
      enabledProviderKeys: ["e2b", "tencent-ags"],
      tencentAgs: { apiKey: "test-ags", domain: "ags.example.invalid" },
      e2b: { apiKey: "test-e2b" },
    });
    const { TENCENT_AGS_API_KEY: _key, ...missingKey } = env;
    expect(() => parseWorkerProcessEnvironment(missingKey)).toThrow("TENCENT_AGS_API_KEY");
    const { TENCENT_AGS_DOMAIN: _domain, ...missingDomain } = env;
    expect(() => parseWorkerProcessEnvironment(missingDomain)).toThrow("TENCENT_AGS_DOMAIN");
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
      DATABASE_WORKER_COORDINATOR_URL:
        "postgresql://worker_coordinator:credential@database:5432/runtime?sslmode=verify-full",
      DATABASE_WORKER_COORDINATOR_ROLE: "worker_coordinator",
      MODEL_WIRE_TRACE_ENABLED: "false",
      MODEL_WIRE_TRACE_RETENTION_DAYS: "7",
      MODEL_WIRE_TRACE_MAX_BYTES: "1048576",
    });
    expect(projected.API_JWT_SIGNING_KEYS).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain("api-only-secret-canary");
  });

  it("显式启用 E2B 时校验默认 Provider、API Key 与模板", () => {
    const configuration = parseWorkerProcessEnvironment({
      ...productionEnvironment(),
      SANDBOX_DEFAULT_PROVIDER: "e2b",
      SANDBOX_ENABLED_PROVIDERS: "cube,e2b",
      E2B_API_KEY: "opaque-e2b-test-key",
      E2B_TEMPLATE_ID: "base",
    });
    expect(configuration.sandbox).toMatchObject({
      defaultProviderKey: "e2b",
      enabledProviderKeys: ["cube", "e2b"],
      e2b: {
        apiKey: "opaque-e2b-test-key",
        templateId: "base",
        sessionTtlSeconds: 3_600,
      },
    });
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        SANDBOX_DEFAULT_PROVIDER: "e2b",
        SANDBOX_ENABLED_PROVIDERS: "cube,e2b",
        E2B_TEMPLATE_ID: "base",
      }),
    ).toThrow("E2B_API_KEY");
    expect(
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        SANDBOX_DEFAULT_PROVIDER: "e2b",
        SANDBOX_ENABLED_PROVIDERS: "e2b",
        E2B_API_KEY: "opaque-e2b-test-key",
        E2B_TEMPLATE_ID: "base",
        E2B_SESSION_TTL_SECONDS: "1800",
      }).sandbox.e2b,
    ).toMatchObject({ sessionTtlSeconds: 1_800 });
  });

  it("并发上限从部署配置解析并提供稳定默认值", () => {
    expect(parseWorkerProcessEnvironment(productionEnvironment()).worker).toMatchObject({
      maxConcurrentRuns: 20,
      userMaxConcurrentRunsPerTenant: 2,
    });
    const source = {
      ...productionEnvironment(),
      AGENT_WORKER_MAX_CONCURRENT_RUNS: "12",
      AGENT_WORKER_USER_MAX_CONCURRENT_RUNS_PER_TENANT: "3",
    };
    expect(
      parseWorkerProcessEnvironment(selectWorkerProcessEnvironment(source)).worker,
    ).toMatchObject({
      maxConcurrentRuns: 12,
      userMaxConcurrentRunsPerTenant: 3,
    });
  });

  it.each(["0", "101", "1.5", "NaN"])("拒绝非法部署并发上限 %s", (value) => {
    for (const key of [
      "AGENT_WORKER_MAX_CONCURRENT_RUNS",
      "AGENT_WORKER_USER_MAX_CONCURRENT_RUNS_PER_TENANT",
    ]) {
      expect(() =>
        parseWorkerProcessEnvironment({ ...productionEnvironment(), [key]: value }),
      ).toThrow(key);
    }
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

  it("Mem0 默认关闭，只允许 development 使用完整独立配置", () => {
    expect(parseWorkerProcessEnvironment(productionEnvironment()).memory).toEqual({
      enabled: false,
    });
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        MEM0_MEMORY_ENABLED: "true",
        MEM0_API_BASE_URL: "https://api.mem0.ai/",
        MEM0_API_KEY: "test-api-key",
        MEM0_SCOPE_HMAC_KEY: "memory-scope-key-at-least-32-bytes",
        MEM0_REQUEST_TIMEOUT_MS: "5000",
      }),
    ).toThrow("只允许 development 启用");
    expect(
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        RUNTIME_ENV: "development",
        DEV_AUTH_ENABLED: "true",
        DEV_AUTH_USER_A_TENANT_ID: "tenant-test-worker",
        MEM0_MEMORY_ENABLED: "true",
        MEM0_API_BASE_URL: "https://api.mem0.ai/",
        MEM0_API_KEY: "test-api-key",
        MEM0_SCOPE_HMAC_KEY: "memory-scope-key-at-least-32-bytes",
        MEM0_REQUEST_TIMEOUT_MS: "5000",
      }).memory,
    ).toEqual({
      enabled: true,
      baseUrl: "https://api.mem0.ai/",
      apiKey: "test-api-key",
      scopeHmacKey: "memory-scope-key-at-least-32-bytes",
      timeoutMs: 5000,
    });
  });

  it("production 的 PG 角色证明失败时不触达 S3、Cube、模型或消费循环", async () => {
    const databaseFailure = new Error("POSTGRES_RUNTIME_ROLE_UNSAFE");
    const probes = {
      postgres: vi.fn(async () => Promise.reject(databaseFailure)),
      workerCoordinatorPostgres: vi.fn(async () => undefined),
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

  it("Worker Coordinator 必须使用独立角色和独立连接配置", () => {
    const parsed = parseWorkerProcessEnvironment(productionEnvironment());
    expect(parsed.databaseWorkerCoordinatorRole).toBe("worker_coordinator");
    expect(parsed.databaseWorkerCoordinatorUrl).toContain("worker_coordinator");
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        DATABASE_WORKER_COORDINATOR_ROLE: "runtime",
      }),
    ).toThrow("必须与 DATABASE_RUNTIME_ROLE 不同");
    expect(() =>
      parseWorkerProcessEnvironment({
        ...productionEnvironment(),
        DATABASE_WORKER_COORDINATOR_ROLE: "Worker-Coordinator",
      }),
    ).toThrow("DATABASE_WORKER_COORDINATOR_ROLE 格式无效");
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

  it("Pi Provider 只注册启用模型并选择显式默认模型", async () => {
    const { modelRuntime, model } = await createOpenAiCompatibleProvider({
      displayName: "主模型供应商",
      baseUrl: "https://model.example.com/v1",
      apiKey: "deployment-secret",
      defaultModelId: "model-b",
      models: [
        {
          id: "model-a",
          name: "Model A",
          enabled: true,
          reasoning: false,
          input: ["text"],
          contextWindow: 64_000,
          maxTokens: 4_096,
        },
        {
          id: "model-b",
          name: "Model B",
          enabled: true,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
        {
          id: "model-disabled",
          name: "Disabled",
          enabled: false,
          reasoning: false,
          input: ["text"],
          contextWindow: 32_000,
          maxTokens: 2_048,
        },
      ],
    });

    expect(model.id).toBe("model-b");
    expect(model.reasoning).toBe(true);
    expect(modelRuntime.getProvider("runtime-openai-compatible")?.name).toBe("主模型供应商");
    expect(modelRuntime.getProviders().map((provider) => provider.id)).toEqual([
      "runtime-openai-compatible",
    ]);
    expect(modelRuntime.getModels().map((candidate) => candidate.id)).toEqual([
      "model-a",
      "model-b",
    ]);
    expect((await modelRuntime.getAuth(model))?.auth.apiKey === "deployment-secret").toBe(true);
    expect(JSON.stringify(model).includes("deployment-secret")).toBe(false);
    expect(
      modelRuntime.getModels("runtime-openai-compatible").map((candidate) => candidate.id),
    ).toEqual(["model-a", "model-b"]);
  });

  it("未知模型自动绑定 new-api 估算器，不阻断 Worker 模型上下文装配", async () => {
    const { modelRuntime, model } = await createOpenAiCompatibleProvider({
      displayName: "自定义模型供应商",
      baseUrl: "https://model.example.com/v1",
      apiKey: "deployment-secret",
      defaultModelId: "vendor-custom-chat",
      models: [
        {
          id: "vendor-custom-chat",
          name: "Vendor Custom Chat",
          enabled: true,
          reasoning: false,
          input: ["text"],
          contextWindow: 64_000,
          maxTokens: 4_096,
        },
      ],
    });

    await expect(
      createOpenAiCompatibleModelContextCapability(modelRuntime, model),
    ).resolves.toMatchObject({
      descriptor: { modelId: "vendor-custom-chat" },
      tokenizer: {
        strategy: "estimated",
        modelFamily: "openai",
        identity: "new-api-token-estimator:openai-v1",
      },
    });
  });

  it("DeepSeek V4 当前目录值可组装，并只为 exact Flash 注入 Pi 兼容配置", async () => {
    const { modelRuntime, model } = await createOpenAiCompatibleProvider({
      displayName: "DeepSeek",
      baseUrl: "https://model.example.com/v1",
      apiKey: "deployment-secret",
      defaultModelId: "deepseek-v4-flash-vision-exp",
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          enabled: true,
          reasoning: true,
          input: ["text"],
          contextWindow: 1_000_000,
          maxTokens: 384_000,
        },
        {
          id: "deepseek-v4-flash-vision-exp",
          name: "DeepSeek V4 Flash Vision Exp",
          enabled: true,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_000_000,
          maxTokens: 384_000,
        },
      ],
    });

    expect(model.id).toBe("deepseek-v4-flash-vision-exp");
    expect(modelRuntime.getModel("runtime-openai-compatible", "deepseek-v4-flash")).toMatchObject({
      id: "deepseek-v4-flash",
      reasoning: true,
      input: ["text"],
      contextWindow: 1_000_000,
      maxTokens: 384_000,
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

  it.each([200, 401])("启动只探测 active 模型，HTTP %i 时不使用过期 fallback", async (status) => {
    const deployment = parseWorkerProcessEnvironment(productionEnvironment()).model;
    const activeBaseUrl = "https://active.example.invalid/v1";
    const fetchSpy = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const startLoop = vi.fn();
    const modelProbe = async () =>
      probeOpenAiCompatibleModel(
        await resolveRuntimeModelProbeConfiguration(deployment, {
          resolveActiveModelConfiguration: async () => ({
            apiKey: "active-test-key",
            configuration: {
              providerKey: "active",
              displayName: "当前模型",
              protocol: "openai-compatible",
              baseUrl: activeBaseUrl,
              credentialConfigured: true,
              defaultModelId: "active-model",
              models: [
                {
                  id: "active-model",
                  name: "当前模型",
                  enabled: true,
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 128_000,
                  maxTokens: 8192,
                },
              ],
            },
          }),
        }),
        "development",
      );
    const startup = startWorkerLoopAfterDependencyProbes(
      "development",
      {
        postgres: async () => undefined,
        workerCoordinatorPostgres: async () => undefined,
        objectStorage: async () => undefined,
        sandbox: async () => undefined,
        model: modelProbe,
      },
      startLoop,
    );
    if (status === 200) {
      await expect(startup).resolves.toBeUndefined();
      expect(startLoop).toHaveBeenCalledOnce();
    } else {
      await expect(startup).rejects.toThrow("模型 provider readiness 失败");
      expect(startLoop).not.toHaveBeenCalled();
    }
    expect(fetchSpy).toHaveBeenCalledOnce();
    const requestUrl = fetchSpy.mock.calls[0]?.[0];
    expect(String(requestUrl)).toBe(`${activeBaseUrl}/chat/completions`);
  });

  it("开发预检使用实际模型生成接口", async () => {
    const model = parseWorkerProcessEnvironment({
      ...productionEnvironment(),
      RUNTIME_ENV: "development",
      AGENT_WORKER_TENANT_ID: "tenant-dev-user-a",
      DEV_AUTH_ENABLED: "true",
      DEV_AUTH_USER_A_TENANT_ID: "tenant-dev-user-a",
    }).model;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] })),
        ),
    );
    await expect(probeOpenAiCompatibleModel(model, "development")).resolves.toBeUndefined();
  });

  it("生产预检不要求供应商提供非标准模型元数据", async () => {
    const model = parseWorkerProcessEnvironment(productionEnvironment()).model;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] })),
        ),
    );
    await expect(probeOpenAiCompatibleModel(model, "production")).resolves.toBeUndefined();
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
