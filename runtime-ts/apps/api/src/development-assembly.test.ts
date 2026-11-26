import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const app = {
    listen: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const persistence = {
    blobLifecycle: {},
    repositories: {},
    localAccounts: {},
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
    renamePersonalThread: {},
    experience: {},
    probe: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const resourceFilesystemProxy = {
    close: vi.fn(async () => undefined),
    probe: vi.fn(async () => undefined),
  };
  return {
    app,
    persistence,
    createApiApp: vi.fn((_dependencies: unknown) => app),
    createApiPersistenceRuntime: vi.fn(() => persistence),
    createS3BlobStore: vi.fn(() => ({})),
    resourceFilesystemProxy,
    startDevelopmentResourceFsProxy: vi.fn(async () => resourceFilesystemProxy),
  };
});

vi.mock("../development-resourcefs-proxy.mjs", () => ({
  startDevelopmentResourceFsProxy: mocks.startDevelopmentResourceFsProxy,
}));

vi.mock("@hoox/persistence/blob", async (importOriginal) => ({
  parseS3ConditionalWrite: (await importOriginal<typeof import("@hoox/persistence/blob")>())
    .parseS3ConditionalWrite,
  createS3BlobStore: mocks.createS3BlobStore,
  DurableResourceBlobWriter: class {},
  RUNTIME_BLOB_OBJECT_PREFIX: "agent-worker",
}));
vi.mock("@hoox/persistence/postgres", () => ({
  PgInstallationRepository: class {},
  PgPublicBrandingRepository: class {},
  createApiPersistenceRuntime: mocks.createApiPersistenceRuntime,
}));
vi.mock("@hoox/persistence/thread", () => ({
  BlobSkillContentStore: class {},
  DurableResourceUploadBlobAdapter: class {},
}));

vi.mock("./app.js", () => ({ createApiApp: mocks.createApiApp }));

import { startApiProcess } from "./process-entry.js";

function developmentEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "development",
    DATABASE_URL: "postgresql://runtime:credential@database/runtime",
    DATABASE_TEAM_COORDINATOR_URL: "postgresql://team_coordinator:credential@database/runtime",
    DATABASE_TEAM_COORDINATOR_ROLE: "team_coordinator",
    DATABASE_SCHEMA: "runtime",
    THREAD_CURSOR_ACTIVE_KID: "current",
    THREAD_CURSOR_SIGNING_KEYS: "current:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    THREAD_SERIAL_QUEUE_V2_ENABLED: "true",
    DEV_AUTH_ENABLED: "true",
    DEV_AUTH_USER_A_ID: "user-a-local",
    DEV_AUTH_USER_A_TENANT_ID: "tenant-a-local",
    DEV_AUTH_USER_B_ID: "user-b-local",
    DEV_AUTH_USER_B_TENANT_ID: "tenant-b-local",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
    API_LISTEN_HOST: "127.0.0.1",
    API_LISTEN_PORT: "3001",
    BETTER_AUTH_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    BETTER_AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:4173",
    S3_ENDPOINT: "http://object-storage:9000",
    S3_PUBLIC_ENDPOINT: "http://127.0.0.1:19000",
    S3_BUCKET: "runtime-artifacts",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "local-access-key",
    S3_SECRET_ACCESS_KEY: "opaque-test-value",
    S3_FORCE_PATH_STYLE: "true",
    RESOURCE_FILESYSTEM_SIGNING_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
}

describe("开发 API 默认装配", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("空安装关闭固定开发身份时仍装配 API", async () => {
    const running = await startApiProcess({
      environment: { ...developmentEnvironment(), DEV_AUTH_ENABLED: "false" },
    });
    expect(mocks.createApiApp).toHaveBeenCalledWith(
      expect.objectContaining({ installation: expect.any(Object) }),
      expect.anything(),
    );
    await running.close();
  });
  it("普通对象保持 16 MiB，Skill 文件使用 32 MiB 读取边界并完成进程启动", async () => {
    const running = await startApiProcess({ environment: developmentEnvironment() });

    try {
      expect(mocks.createApiPersistenceRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          teamCoordinator: {
            connectionString: "postgresql://team_coordinator:credential@database/runtime",
            schema: "runtime",
            expectedRuntimeRole: "team_coordinator",
            applicationName: "hoox-api-team-coordinator-development",
          },
          blobLifecycle: { objectPrefix: "agent-worker" },
        }),
      );
      expect(mocks.createS3BlobStore).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          prefix: "agent-worker",
          maxBlobSizeBytes: 16 * 1_024 * 1_024,
        }),
        mocks.persistence.blobLifecycle,
      );
      expect(mocks.createS3BlobStore).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          prefix: "agent-worker",
          maxBlobSizeBytes: 32 * 1_024 * 1_024,
        }),
        mocks.persistence.blobLifecycle,
      );
      expect(mocks.persistence.probe).toHaveBeenCalledTimes(1);
      expect(mocks.app.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 3001 });
      await expect(running.readiness()).resolves.toEqual({ status: "ready" });
    } finally {
      await running.close();
    }

    expect(mocks.app.close).toHaveBeenCalledTimes(1);
    expect(mocks.persistence.close).toHaveBeenCalledTimes(1);
  });

  it("由 API 进程启动、探测并在 Fastify 前关闭 ResourceFS Sidecar", async () => {
    const running = await startApiProcess({
      environment: {
        ...developmentEnvironment(),
        RESOURCEFS_PROXY_ENABLED: "true",
        RESOURCEFS_PROXY_LISTEN_HOST: "192.0.2.10",
        RESOURCEFS_PROXY_LISTEN_PORT: "13443",
        RESOURCEFS_PROXY_TLS_KEY_PATH: "C:/development/resourcefs/server.key",
        RESOURCEFS_PROXY_TLS_CERT_PATH: "C:/development/resourcefs/server.crt",
      },
    });

    expect(mocks.startDevelopmentResourceFsProxy).toHaveBeenCalledWith({
      listenHost: "192.0.2.10",
      listenPort: 13443,
      upstream: "http://127.0.0.1:3001",
      privateKeyPath: "C:/development/resourcefs/server.key",
      certificatePath: "C:/development/resourcefs/server.crt",
    });
    await expect(running.readiness()).resolves.toEqual({ status: "ready" });
    expect(mocks.resourceFilesystemProxy.probe).toHaveBeenCalledTimes(1);

    await running.close();

    expect(mocks.resourceFilesystemProxy.close).toHaveBeenCalledTimes(1);
    expect(mocks.resourceFilesystemProxy.close.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.app.close.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
  it("公开 Demo 不装配固定开发 token，只保留真实账号认证并继续绑定回环地址", async () => {
    const running = await startApiProcess({
      environment: {
        ...developmentEnvironment(),
        DEV_AUTH_ENABLED: "false",
        DEMO_PUBLIC_ACCESS_ENABLED: "true",
        DEMO_ADMIN_USER_ID: "user_demo_admin",
        DEMO_PUBLIC_ORIGIN: "https://hoox.example.invalid",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://hoox.example.invalid",
        S3_PUBLIC_ENDPOINT: "https://hoox.example.invalid",
      },
    });

    try {
      const dependencies = mocks.createApiApp.mock.calls[0]?.[0] as
        | {
            readonly auth?: unknown;
            readonly localAccountPasswordRoutes?: boolean;
            readonly demoAdminUserId?: string;
          }
        | undefined;
      expect(dependencies?.auth).toEqual(
        expect.objectContaining({ resolve: expect.any(Function) }),
      );
      expect(dependencies?.localAccountPasswordRoutes).toBe(false);
      expect(dependencies?.demoAdminUserId).toBe("user_demo_admin");
      expect(dependencies?.auth).not.toHaveProperty("principals");
      expect(mocks.app.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 3001 });
    } finally {
      await running.close();
    }
  });
});
