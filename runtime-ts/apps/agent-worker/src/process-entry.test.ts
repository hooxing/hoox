import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDevelopmentOpenAiCompatibleModel,
  parseWorkerProcessEnvironment,
  probeOpenAiCompatibleModel,
  startWorkerProcess,
} from "./process-entry.js";

function productionEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "production",
    DATABASE_URL: "postgresql://runtime:credential@database/runtime",
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
    MODEL_BASE_URL: "https://model.invalid/v1",
    MODEL_API_KEY: "opaque-model-value",
    MODEL_ID: "test-model",
    MODEL_CONTEXT_WINDOW: "128000",
    MODEL_MAX_OUTPUT_TOKENS: "16384",
    AGENT_WORKER_TENANT_ID: "tenant-test-worker",
    AGENT_WORKER_ID: "worker-test",
    AGENT_WORKER_POLL_INTERVAL_MS: "100",
    AGENT_WORKER_DISPATCH_LEASE_MS: "30000",
    AGENT_WORKER_RUN_LEASE_MS: "30000",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
  };
}

describe("Agent Worker 进程入口", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
    });

    const { model } = await createDevelopmentOpenAiCompatibleModel(configuration.model);

    expect(model).toMatchObject({
      api: "openai-completions",
      id: configuration.model.modelId,
      contextWindow: configuration.model.contextWindow,
      maxTokens: configuration.model.maxOutputTokens,
    });
    expect(JSON.stringify(model)).not.toContain(configuration.model.apiKey);
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
