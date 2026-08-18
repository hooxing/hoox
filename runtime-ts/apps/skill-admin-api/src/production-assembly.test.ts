import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillAdminApiAppOptions, SkillAdminApiDependencies } from "./app.js";
import type { SkillAdminApiProcessConfiguration } from "./process-entry.js";

const mocks = vi.hoisted(() => {
  const app = {
    listen: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const pool = { end: vi.fn(async () => undefined) };
  return {
    app,
    pool,
    createApp: vi.fn(() => app),
    createPool: vi.fn(() => pool),
    probePostgres: vi.fn(async () => undefined),
    probePublisher: vi.fn(async () => undefined),
    publisherConstructed: vi.fn(),
    publisherClose: vi.fn(),
    authorizationConstructed: vi.fn(),
    repositoryConstructed: vi.fn(),
    createProductionAuth: vi.fn(() => ({
      resolve: async () => undefined,
    })),
    loadTls: vi.fn(async () => undefined),
    trustProxy: vi.fn(() => (address: string) => address === "127.0.0.1"),
  };
});

vi.mock("@hoox/api", () => ({
  createProductionJwtAuthResolver: mocks.createProductionAuth,
  loadProductionTlsCredentials: mocks.loadTls,
  productionTrustProxy: mocks.trustProxy,
}));

vi.mock("@hoox/persistence", () => ({
  createPostgresPool: mocks.createPool,
  probePostgres: mocks.probePostgres,
  probeS3StableSkillPublisher: mocks.probePublisher,
  PgSkillPublicationAuthorization: class {
    constructor(pool: unknown) {
      mocks.authorizationConstructed(pool);
    }
  },
  PgSkillPublicationRepository: class {
    constructor(pool: unknown, publisher: unknown) {
      mocks.repositoryConstructed(pool, publisher);
    }
  },
  S3StableSkillPublisher: class {
    constructor(configuration: unknown) {
      mocks.publisherConstructed(configuration, this);
    }

    close() {
      mocks.publisherClose();
    }
  },
}));

vi.mock("./app.js", () => ({ createSkillAdminApiApp: mocks.createApp }));

import {
  startDevelopmentSkillAdminApiProcess,
  startProductionSkillAdminApiProcess,
} from "./production-assembly.js";

function productionConfiguration(): SkillAdminApiProcessConfiguration {
  return {
    runtimeEnvironment: "production",
    databaseUrl: "postgresql://skill_publisher:credential@database:5432/runtime",
    databaseSsl: { rejectUnauthorized: true },
    databaseSchema: "runtime",
    databaseSkillPublisherRole: "skill_publisher",
    shutdownTimeoutMilliseconds: 15_000,
    listenHost: "127.0.0.1",
    listenPort: 3_002,
    objectStorage: {
      endpoint: "https://skill-objects.example.invalid:9000",
      bucket: "runtime-skill-publications",
      region: "us-east-1",
      accessKeyId: "skill-publisher-access-key",
      secretAccessKey: "opaque-skill-publisher-secret",
      forcePathStyle: true,
    },
    production: {
      jwt: {
        issuer: "https://issuer.example.invalid/runtime",
        audience: "hoox-skill-admin-api",
        keys: [{ kid: "skill-admin-current", secret: Buffer.alloc(32, 17) }],
        clockSkewSeconds: 60,
        maxTokenLifetimeSeconds: 1_800,
      },
      transport: {
        mode: "proxy",
        trustedProxies: [],
      },
    },
  };
}

function developmentConfiguration(): SkillAdminApiProcessConfiguration {
  return {
    runtimeEnvironment: "development",
    databaseUrl: "postgresql://skill_publisher:credential@127.0.0.1:5432/runtime",
    databaseSchema: "runtime",
    shutdownTimeoutMilliseconds: 15_000,
    listenHost: "127.0.0.1",
    listenPort: 3_002,
    objectStorage: {
      endpoint: "http://127.0.0.1:19000",
      bucket: "runtime-skill-publications",
      region: "us-east-1",
      accessKeyId: "local-skill-publisher",
      secretAccessKey: "local-skill-publisher-secret",
      forcePathStyle: true,
    },
    developmentAuth: {
      userId: "user_skill_admin_local",
      token: "local-skill-admin-token",
    },
  };
}

describe("Skill 管理 API 固定装配", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.probePostgres.mockResolvedValue(undefined);
    mocks.probePublisher.mockResolvedValue(undefined);
    mocks.loadTls.mockResolvedValue(undefined);
  });

  it("生产只装配专用 publisher PG/S3/JWT/proxy，并在双探针后监听", async () => {
    const configuration = productionConfiguration();
    const running = await startProductionSkillAdminApiProcess(configuration);
    try {
      expect(mocks.createPool).toHaveBeenCalledWith({
        connectionString: configuration.databaseUrl,
        ssl: { rejectUnauthorized: true },
        schema: "runtime",
        expectedRuntimeRole: "skill_publisher",
        applicationName: "hoox-skill-admin-api-production",
      });
      expect(mocks.publisherConstructed).toHaveBeenCalledWith(
        {
          endpoint: "https://skill-objects.example.invalid:9000",
          bucket: "runtime-skill-publications",
          region: "us-east-1",
          accessKeyId: "skill-publisher-access-key",
          secretAccessKey: "opaque-skill-publisher-secret",
          forcePathStyle: true,
        },
        expect.anything(),
      );
      expect(mocks.authorizationConstructed).toHaveBeenCalledWith(mocks.pool);
      expect(mocks.repositoryConstructed).toHaveBeenCalledWith(mocks.pool, expect.anything());
      expect(mocks.createProductionAuth).toHaveBeenCalledWith(configuration.production?.jwt);

      const calls = mocks.createApp.mock.calls as unknown as Array<
        [SkillAdminApiDependencies, SkillAdminApiAppOptions]
      >;
      const firstCall = calls[0];
      if (firstCall === undefined) throw new Error("未创建 Skill 管理 API 应用");
      const [dependencies, appOptions] = firstCall;
      await expect(
        dependencies.auth.resolve({
          authorization: "Bearer local-skill-admin-token",
          requestId: "r",
        }),
      ).resolves.toBeUndefined();
      if (typeof appOptions.trustProxy !== "function") throw new Error("未配置受限代理信任");
      expect(appOptions.logger).toBe(true);
      expect(appOptions.trustProxy("127.0.0.1", 0)).toBe(true);
      expect(appOptions.trustProxy("198.51.100.7", 0)).toBe(false);
      expect(mocks.app.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 3_002 });
      expect(mocks.probePostgres.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.probePublisher.mock.invocationCallOrder[0] ?? 0,
      );
      expect(mocks.probePublisher.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.app.listen.mock.invocationCallOrder[0] ?? 0,
      );
      await expect(running.readiness()).resolves.toEqual({ status: "ready" });
    } finally {
      await running.close();
    }
    expect(mocks.app.close).toHaveBeenCalledTimes(1);
    expect(mocks.publisherClose).toHaveBeenCalledTimes(1);
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
  });

  it("publisher PG 角色探针失败时不携 S3 凭据探测远端，也不监听", async () => {
    mocks.probePostgres.mockRejectedValueOnce(new Error("POSTGRES_RUNTIME_ROLE_UNSAFE"));

    await expect(startProductionSkillAdminApiProcess(productionConfiguration())).rejects.toThrow(
      "ASSEMBLY_FAILED:skill-admin-api",
    );
    expect(mocks.probePublisher).not.toHaveBeenCalled();
    expect(mocks.app.listen).not.toHaveBeenCalled();
    expect(mocks.publisherClose).toHaveBeenCalledTimes(1);
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
  });

  it("S3 publisher 构造失败时仍释放已经创建的专用 PG pool", async () => {
    mocks.publisherConstructed.mockImplementationOnce(() => {
      throw new Error("S3_CONFIGURATION_INVALID");
    });

    await expect(startProductionSkillAdminApiProcess(productionConfiguration())).rejects.toThrow(
      "ASSEMBLY_FAILED:skill-admin-api",
    );
    expect(mocks.probePostgres).not.toHaveBeenCalled();
    expect(mocks.app.listen).not.toHaveBeenCalled();
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
  });

  it("专用 S3 探针失败时不监听并释放 publisher 与 PG pool", async () => {
    mocks.probePublisher.mockRejectedValueOnce(new Error("S3_HEAD_BUCKET_FAILED"));

    await expect(startProductionSkillAdminApiProcess(productionConfiguration())).rejects.toThrow(
      "ASSEMBLY_FAILED:skill-admin-api",
    );
    expect(mocks.probePostgres).toHaveBeenCalledTimes(1);
    expect(mocks.app.listen).not.toHaveBeenCalled();
    expect(mocks.publisherClose).toHaveBeenCalledTimes(1);
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
  });

  it("开发默认装配只接受固定 Token，且不启用 TLS 或代理信任", async () => {
    const running = await startDevelopmentSkillAdminApiProcess(developmentConfiguration());
    try {
      const calls = mocks.createApp.mock.calls as unknown as Array<
        [SkillAdminApiDependencies, SkillAdminApiAppOptions]
      >;
      const firstCall = calls[0];
      if (firstCall === undefined) throw new Error("未创建 Skill 管理 API 应用");
      const [dependencies, options] = firstCall;
      await expect(
        dependencies.auth.resolve({
          authorization: "Bearer local-skill-admin-token",
          requestId: "r",
        }),
      ).resolves.toEqual({ userId: "user_skill_admin_local" });
      await expect(
        dependencies.auth.resolve({ authorization: "Bearer wrong-token", requestId: "r" }),
      ).resolves.toBeUndefined();
      expect(options).toEqual({ logger: false, trustProxy: false });
    } finally {
      await running.close();
    }
  });
});
