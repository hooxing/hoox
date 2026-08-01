import { beforeEach, describe, expect, it, vi } from "vitest";

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
  };
});

vi.mock("@cube-runtime/persistence", () => ({
  createApiPersistenceRuntime: mocks.createApiPersistenceRuntime,
  createS3BlobStore: mocks.createS3BlobStore,
  DurableResourceBlobWriter: class {},
  DurableResourceUploadBlobAdapter: class {},
  RUNTIME_BLOB_OBJECT_PREFIX: "agent-worker",
}));

vi.mock("./app.js", () => ({ createApiApp: mocks.createApiApp }));

import { startApiProcess } from "./process-entry.js";

function developmentEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "development",
    DATABASE_URL: "postgresql://runtime:credential@database/runtime",
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

  it("沿用 16 MiB 小对象边界并完成进程启动", async () => {
    const running = await startApiProcess({ environment: developmentEnvironment() });

    try {
      expect(mocks.createS3BlobStore).toHaveBeenCalledWith(
        expect.objectContaining({
          prefix: "agent-worker",
          maxBlobSizeBytes: 16 * 1_024 * 1_024,
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
});
