import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pool: { end: vi.fn(async () => undefined) },
  createPostgresPool: vi.fn(),
  probePostgres: vi.fn(),
  gatewayConstructed: vi.fn(),
  gatewayProbe: vi.fn(),
  loopStarted: vi.fn(),
}));

vi.mock("@cube-runtime/persistence", () => ({
  createPostgresPool: mocks.createPostgresPool,
  probePostgres: mocks.probePostgres,
  PgSandboxCleanupConsumerStore: class {},
}));

vi.mock("@cube-runtime/sandbox", () => ({
  CubeSandboxGateway: class {
    constructor() {
      mocks.gatewayConstructed();
    }

    async probe() {
      return mocks.gatewayProbe();
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

import { startSchedulerProcess } from "./process-entry.js";

function environment(): Record<string, string> {
  return {
    RUNTIME_ENV: "production",
    DATABASE_URL: "postgresql://runtime:credential@database:5432/runtime?sslmode=verify-full",
    DATABASE_RUNTIME_ROLE: "runtime",
    DATABASE_SCHEMA: "runtime",
    CUBESANDBOX_API_URL: "https://cube-api.invalid",
    CUBESANDBOX_PROXY_SCHEME: "https",
    SCHEDULER_TENANT_ID: "tenant-production-scheduler",
    SCHEDULER_WORKER_ID: "scheduler-production",
    CLEANUP_POLL_INTERVAL_MS: "1000",
    CLEANUP_LEASE_MS: "210000",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
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
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
  });

  it("数据库角色探针失败时不构造远端 gateway，也不启动 cleanup loop", async () => {
    await expect(startSchedulerProcess({ environment: environment() })).rejects.toThrow(
      "ASSEMBLY_FAILED:scheduler",
    );
    expect(mocks.createPostgresPool).toHaveBeenCalledWith(
      expect.objectContaining({ ssl: { rejectUnauthorized: true } }),
    );
    expect(mocks.probePostgres).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayConstructed).not.toHaveBeenCalled();
    expect(mocks.loopStarted).not.toHaveBeenCalled();
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
  });
});
