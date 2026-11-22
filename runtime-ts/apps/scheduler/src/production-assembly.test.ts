import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pool: { end: vi.fn(async () => undefined) },
  createPostgresPool: vi.fn(),
  probePostgres: vi.fn(),
  gatewayConstructed: vi.fn(),
  gatewayProbe: vi.fn(),
  loopStarted: vi.fn(),
  retentionStarted: vi.fn(async () => 0),
}));

vi.mock("@hoox/persistence/blob", () => ({
  createS3BlobStore: () => ({}),
  createS3StableBlobGarbageCollector: () => ({}),
  PgBlobLifecycleRepository: class {},
  RUNTIME_BLOB_OBJECT_PREFIX: "agent-runtime",
}));

vi.mock("@hoox/persistence/admin", () => ({
  PgSandboxConfigurationResolver: class {
    activeProfiles() {
      return Promise.resolve(undefined);
    }
  },
}));
vi.mock("@hoox/persistence/maintenance", () => ({
  PgSandboxCleanupConsumerStore: class {},
}));
vi.mock("@hoox/persistence/postgres", () => ({
  createPostgresPool: mocks.createPostgresPool,
  probePostgres: mocks.probePostgres,
  PgWebhookOutboxStore: class {
    readonly leaseMs = 30_000;
    readonly maxAttempts = 12;
    async claim() {
      return undefined;
    }
  },
  WebhookSecretCipher: class {},
}));

vi.mock("@hoox/sandbox", () => ({
  PgThreadTitleGenerationStore: class {},
  CubeSandboxGateway: class {
    constructor() {
      mocks.gatewayConstructed();
    }

    async probe() {
      return mocks.gatewayProbe();
    }
  },
  E2BSandboxGateway: class {},
  SandboxProviderRegistry: class {
    constructor(
      readonly defaultProviderKey: string,
      private readonly gateways: readonly { probe(): Promise<void> }[],
    ) {}

    keys() {
      return this.gateways.map(() => this.defaultProviderKey);
    }

    async probe() {
      await Promise.all(this.gateways.map((gateway) => gateway.probe()));
    }
  },
  resolveCubeProxyRouting: () => ({
    proxyNodeIp: "cube-api.invalid",
    proxyPort: 443,
    proxyScheme: "https",
  }),
}));

vi.mock("./sandbox-cleanup-consumer.js", () => ({
  CubeSandboxCleanupResolver: class {},
  SandboxCleanupConsumer: class {},
  SandboxCleanupPollingLoop: class {
    start() {
      mocks.loopStarted();
    }

    async close() {}
  },
}));
vi.mock("./run-trajectory-retention.js", () => ({
  runRunTrajectoryRetentionPass: mocks.retentionStarted,
}));

import { startSchedulerProcess } from "./process-entry.js";

function environment(): Record<string, string> {
  return {
    RUNTIME_ENV: "production",
    DATABASE_URL: "postgresql://runtime:credential@database:5432/runtime?sslmode=verify-full",
    DATABASE_RUNTIME_ROLE: "runtime",
    DATABASE_WORKER_COORDINATOR_URL:
      "postgresql://worker_coordinator:credential@database:5432/runtime?sslmode=verify-full",
    DATABASE_WORKER_COORDINATOR_ROLE: "worker_coordinator",
    DATABASE_SCHEMA: "runtime",
    S3_ENDPOINT: "https://s3.invalid",
    S3_BUCKET: "runtime-test",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
    S3_FORCE_PATH_STYLE: "false",
    RUN_TRAJECTORY_RETENTION_DAYS: "30",
    CUBESANDBOX_API_URL: "https://cube-api.invalid",
    CUBESANDBOX_PROXY_SCHEME: "https",
    SCHEDULER_TENANT_ID: "tenant-production-scheduler",
    SCHEDULER_WORKER_ID: "scheduler-production",
    CLEANUP_POLL_INTERVAL_MS: "1000",
    CLEANUP_LEASE_MS: "210000",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
    DATABASE_WEBHOOK_DISPATCHER_ROLE: "webhook_dispatcher",
    WEBHOOK_DISPATCHER_DATABASE_URL:
      "postgresql://webhook_dispatcher:credential@database:5432/runtime?sslmode=verify-full",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "webhook-root-placeholder-at-least-32-bytes",
  };
}

describe("生产 Scheduler 装配顺序", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPostgresPool.mockReturnValue(mocks.pool);
    mocks.probePostgres.mockRejectedValue(new Error("POSTGRES_RUNTIME_ROLE_UNSAFE"));
    mocks.gatewayProbe.mockResolvedValue(undefined);
  });

  it("Cube probe 失败时不启动 cleanup loop，并关闭数据库池", async () => {
    mocks.probePostgres.mockResolvedValue(undefined);
    mocks.gatewayProbe.mockRejectedValue(new Error("invalid-cube-credential"));
    await expect(startSchedulerProcess({ environment: environment() })).rejects.toThrow(
      "ASSEMBLY_FAILED:scheduler",
    );
    expect(mocks.gatewayConstructed).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayProbe).toHaveBeenCalledTimes(1);
    expect(mocks.loopStarted).not.toHaveBeenCalled();
    expect(mocks.pool.end).toHaveBeenCalledTimes(3);
  });

  it("数据库角色探针失败时不构造远端 gateway，也不启动 cleanup loop", async () => {
    await expect(startSchedulerProcess({ environment: environment() })).rejects.toThrow(
      "ASSEMBLY_FAILED:scheduler",
    );
    expect(mocks.createPostgresPool).toHaveBeenCalledWith(
      expect.objectContaining({ ssl: { rejectUnauthorized: true } }),
    );
    // Dispatcher 使用独立受限角色连接，生产同样强制 TLS 校验。
    expect(mocks.createPostgresPool).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRuntimeRole: "webhook_dispatcher",
        ssl: { rejectUnauthorized: true },
      }),
    );
    expect(mocks.createPostgresPool).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRuntimeRole: "worker_coordinator",
        applicationName: "hoox-scheduler-trajectory-retention-coordinator",
        ssl: { rejectUnauthorized: true },
      }),
    );
    expect(mocks.probePostgres).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayConstructed).not.toHaveBeenCalled();
    expect(mocks.loopStarted).not.toHaveBeenCalled();
    expect(mocks.pool.end).toHaveBeenCalledTimes(3);
  });
});
