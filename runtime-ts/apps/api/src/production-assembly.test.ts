import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiAppOptions, ApiDependencies } from "./app.js";

const mocks = vi.hoisted(() => {
  const app = {
    listen: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const persistence = {
    blobLifecycle: {},
    repositories: {},
    threadCreation: { createThread: vi.fn() },
    runDispatchCreation: {
      replayQueuedRun: vi.fn(),
      createQueuedRun: vi.fn(),
    },
    threadInputs: { submit: vi.fn(), get: vi.fn() },
    threadContext: vi.fn(() => ({})),
    threadContinuity: {},
    modelWireTraces: {},
    archiveThread: {},
    experience: {},
    probe: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return {
    app,
    persistence,
    createApiApp: vi.fn(() => app),
    createApiPersistenceRuntime: vi.fn(() => persistence),
    createS3BlobStore: vi.fn(() => ({})),
    probeS3BlobStore: vi.fn(async () => undefined),
  };
});

vi.mock("@hoox/persistence", () => ({
  BlobSkillContentStore: class {},
  createApiPersistenceRuntime: mocks.createApiPersistenceRuntime,
  createS3BlobStore: mocks.createS3BlobStore,
  DurableResourceBlobWriter: class {},
  DurableResourceUploadBlobAdapter: class {},
  probeS3BlobStore: mocks.probeS3BlobStore,
  RUNTIME_BLOB_OBJECT_PREFIX: "agent-worker",
}));

vi.mock("./app.js", () => ({ createApiApp: mocks.createApiApp }));

import { startApiProcess } from "./process-entry.js";

function productionEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "production",
    DATABASE_URL: "postgresql://runtime:credential@database:5432/runtime?sslmode=verify-full",
    DATABASE_TEAM_COORDINATOR_URL:
      "postgresql://team_coordinator:credential@database:5432/runtime?sslmode=verify-full",
    DATABASE_SCHEMA: "runtime",
    DATABASE_RUNTIME_ROLE: "runtime",
    DATABASE_TEAM_COORDINATOR_ROLE: "team_coordinator",
    THREAD_CURSOR_ACTIVE_KID: "current",
    THREAD_CURSOR_SIGNING_KEYS: "current:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    THREAD_SERIAL_QUEUE_V2_ENABLED: "true",
    API_JWT_ISSUER: "https://issuer.example.invalid/runtime",
    API_JWT_AUDIENCE: "hoox-api",
    API_JWT_SIGNING_KEYS: "current-key:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    API_JWT_CLOCK_SKEW_SECONDS: "60",
    API_JWT_MAX_LIFETIME_SECONDS: "3600",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
    API_LISTEN_HOST: "127.0.0.1",
    API_LISTEN_PORT: "3001",
    API_PUBLIC_ORIGIN: "https://app.example.invalid",
    BETTER_AUTH_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    BETTER_AUTH_TRUSTED_ORIGINS: "https://app.example.invalid",
    API_TLS_MODE: "proxy",
    API_TRUSTED_PROXY_CIDRS: "127.0.0.1",
    S3_ENDPOINT: "https://object-storage.example.invalid:9000",
    S3_PUBLIC_ENDPOINT: "https://objects.example.invalid",
    S3_BUCKET: "runtime-artifacts",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "local-access-key",
    S3_SECRET_ACCESS_KEY: "opaque-test-value",
    S3_FORCE_PATH_STYLE: "true",
    RESOURCE_FILESYSTEM_SIGNING_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
}

describe("生产 API 默认装配", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("只装配真实 PG/S3/JWT/proxy 依赖，且不把开发固定凭据带入 production", async () => {
    const running = await startApiProcess({ environment: productionEnvironment() });
    try {
      expect(mocks.createApiPersistenceRuntime).toHaveBeenCalledWith({
        connectionString: "postgresql://runtime:credential@database:5432/runtime",
        ssl: { rejectUnauthorized: true },
        schema: "runtime",
        expectedRuntimeRole: "runtime",
        applicationName: "hoox-api-production",
        teamCoordinator: {
          connectionString: "postgresql://team_coordinator:credential@database:5432/runtime",
          ssl: { rejectUnauthorized: true },
          schema: "runtime",
          expectedRuntimeRole: "team_coordinator",
          applicationName: "hoox-api-team-coordinator-production",
        },
        serialQueueV2Enabled: true,
        historyDirectoryTimeZone: "Asia/Shanghai",
        historyFilesystemEnabled: false,
        historyTitleGenerationEnabled: false,
        blobLifecycle: { objectPrefix: "agent-worker" },
      });
      expect(mocks.createS3BlobStore).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          maxBlobSizeBytes: 16 * 1_024 * 1_024,
          endpoint: "https://object-storage.example.invalid:9000",
          publicEndpoint: "https://objects.example.invalid",
          prefix: "agent-worker",
        }),
        mocks.persistence.blobLifecycle,
      );
      expect(mocks.createS3BlobStore).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          maxBlobSizeBytes: 32 * 1_024 * 1_024,
          endpoint: "https://object-storage.example.invalid:9000",
          publicEndpoint: "https://objects.example.invalid",
          prefix: "agent-worker",
        }),
        mocks.persistence.blobLifecycle,
      );
      expect(mocks.app.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 3001 });
      const calls = mocks.createApiApp.mock.calls as unknown as Array<
        [ApiDependencies, ApiAppOptions]
      >;
      const firstCall = calls[0];
      if (firstCall === undefined) throw new Error("未创建 API 应用");
      const [dependencies, options] = firstCall;
      expect(
        await dependencies.auth.resolve({ authorization: "Bearer dev-user-a", requestId: "r" }),
      ).toBeUndefined();
      if (typeof options.trustProxy !== "function") throw new Error("未配置受限代理信任");
      expect(options.trustProxy("127.0.0.1", 0)).toBe(true);
      expect(options.trustProxy("198.51.100.7", 0)).toBe(false);
      await expect(running.readiness()).resolves.toEqual({ status: "ready" });
    } finally {
      await running.close();
    }
    expect(mocks.app.close).toHaveBeenCalledTimes(1);
    expect(mocks.persistence.close).toHaveBeenCalledTimes(1);
  });

  it("PG 角色证明失败时不携 S3 凭据访问远端，也不监听端口", async () => {
    const databaseFailure = new Error("POSTGRES_RUNTIME_ROLE_UNSAFE");
    mocks.persistence.probe.mockRejectedValueOnce(databaseFailure);
    await expect(startApiProcess({ environment: productionEnvironment() })).rejects.toThrow(
      "ASSEMBLY_FAILED:api",
    );
    expect(mocks.probeS3BlobStore).not.toHaveBeenCalled();
    expect(mocks.app.listen).not.toHaveBeenCalled();
    expect(mocks.persistence.close).toHaveBeenCalledTimes(1);
  });
});
