import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminControlApiDependencies } from "./app.js";
import type { AdminControlApiProcessConfiguration } from "./process-entry.js";

const mocks = vi.hoisted(() => {
  const app = {
    listen: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const controlPool = { name: "control", end: vi.fn(async () => undefined) };
  const skillPool = { name: "skill", end: vi.fn(async () => undefined) };
  return {
    app,
    controlPool,
    skillPool,
    createApp: vi.fn(() => app),
    createPool: vi.fn().mockReturnValueOnce(controlPool).mockReturnValueOnce(skillPool),
    probePostgres: vi.fn(async () => undefined),
    probePublisher: vi.fn(async () => undefined),
    publisherConstructed: vi.fn(),
    publisherClose: vi.fn(),
    adminRepositoryConstructed: vi.fn(),
    identityRepositoryConstructed: vi.fn(),
    authorizationConstructed: vi.fn(),
    publicationRepositoryConstructed: vi.fn(),
    runExplorerRepositoryConstructed: vi.fn(),
    agentRepositoryConstructed: vi.fn(),
    externalRepositoryConstructed: vi.fn(),
    probeMcpEndpoint: vi.fn(async () => []),
  };
});

vi.mock("@hoox/tool-router", () => ({ probeMcpEndpoint: mocks.probeMcpEndpoint }));

vi.mock("@hoox/persistence/admin", () => ({
  PgIntegrationAdminRepository: class {},
  probeS3StableSkillPublisher: mocks.probePublisher,
  ModelProviderCredentialCipher: class {},
  ExternalToolCredentialCipher: class {},
  ExternalToolDraftCredentialCipher: class {},
  PgExternalToolAdminRepository: class {
    constructor(pool: unknown) {
      mocks.externalRepositoryConstructed(pool);
    }
    async loadDraftForProbe() {
      return {
        draft: {
          draftId: "draft_1",
          generation: 1,
          endpoint: "https://example.invalid/mcp",
          serverName: "srv",
          timeoutMs: 500,
          maxResponseBytes: 1024,
        },
      };
    }
    async recordProbeAudit() {}
  },
  PgSandboxControlRepository: class {
    overview() {
      return Promise.resolve({ generation: 0, profiles: [] });
    }
    saveProfile() {
      return Promise.resolve();
    }
    publishRouting() {
      return Promise.resolve();
    }
    probeProfile() {
      return Promise.resolve({ healthy: true, durationMs: 1 });
    }
  },
  PgAdminControlRepository: class {
    constructor(pool: unknown) {
      mocks.adminRepositoryConstructed(pool);
    }

    resolveRole() {
      return Promise.resolve("admin");
    }

    generation() {
      return Promise.resolve(0);
    }
    listModelProviders() {
      return Promise.resolve([]);
    }
    listMemoryProviders() {
      return Promise.resolve([]);
    }
    getActiveRuntimeSettings() {
      return Promise.resolve(undefined);
    }
    read() {
      return Promise.resolve({});
    }
  },
  PgAgentDefinitionRepository: class {
    constructor(pool: unknown) {
      mocks.agentRepositoryConstructed(pool);
    }
  },
  PgAdminRunExplorerRepository: class {
    constructor(pool: unknown) {
      mocks.runExplorerRepositoryConstructed(pool);
    }
  },
  PgIdentityConfigurationRepository: class {
    constructor(pool: unknown) {
      mocks.identityRepositoryConstructed(pool);
    }

    read() {
      return Promise.resolve(undefined);
    }

    save() {
      return Promise.resolve("saved");
    }
  },
  PgSkillPublicationAuthorization: class {
    constructor(pool: unknown) {
      mocks.authorizationConstructed(pool);
    }
  },
  PgSkillPublicationRepository: class {
    constructor(pool: unknown, publisher: unknown) {
      mocks.publicationRepositoryConstructed(pool, publisher);
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
vi.mock("@hoox/persistence/postgres", () => ({
  createPostgresPool: mocks.createPool,
  probePostgres: mocks.probePostgres,
}));

vi.mock("./app.js", () => ({ createAdminControlApiApp: mocks.createApp }));

import {
  startDevelopmentAdminControlApiProcess,
  startProductionAdminControlApiProcess,
} from "./production-assembly.js";

function configuration(): AdminControlApiProcessConfiguration {
  return {
    runtimeEnvironment: "development",
    externalToolsAllowPrivateAddresses: false,
    databaseUrl: "postgresql://control:credential@127.0.0.1:5432/runtime",
    skillPublisherDatabaseUrl: "postgresql://publisher:credential@127.0.0.1:5432/runtime",
    databaseSchema: "runtime",
    betterAuthSecret: "test-better-auth-secret-at-least-thirty-two-bytes",
    databaseAdminControlRole: "admin_control",
    databaseSkillPublisherRole: "skill_publisher",
    listenHost: "127.0.0.1",
    listenPort: 3_003,
    shutdownTimeoutMilliseconds: 15_000,
    objectStorage: {
      endpoint: "http://127.0.0.1:19000",
      bucket: "runtime-skill-publications",
      region: "us-east-1",
      accessKeyId: "publisher",
      secretAccessKey: "publisher-secret",
      forcePathStyle: true,
    },
    trajectoryObjectStorage: {
      endpoint: "http://127.0.0.1:19000",
      bucket: "runtime-trajectories",
      region: "us-east-1",
      accessKeyId: "trajectory",
      secretAccessKey: "trajectory-secret",
      forcePathStyle: true,
    },
    providerSecrets: {
      modelApiKey: "model-secret",
      modelCredentialEncryptionKey: "model-credential-encryption-key-at-least-32-bytes",
    },
    runtimeDeploymentSettings: {
      compactionEnabledConfigured: true,
      compactionPathConfigured: true,
      historyTimeZoneConfigured: true,
      memoryScopeKeyConfigured: true,
    },
    developmentAuth: { userId: "user_admin", token: "unified-admin-token" },
  };
}

function productionConfiguration(): AdminControlApiProcessConfiguration {
  const { developmentAuth, ...base } = configuration();
  void developmentAuth;
  return {
    ...base,
    runtimeEnvironment: "production",
    externalToolsAllowPrivateAddresses: true,
    databaseSsl: { rejectUnauthorized: true },
    skillPublisherDatabaseSsl: { rejectUnauthorized: true },
    production: {
      jwt: {
        issuer: "https://identity.example.invalid",
        audience: "hoox-admin-control-api",
        keys: [{ kid: "admin-current", secret: Buffer.alloc(32, 17) }],
        clockSkewSeconds: 60,
        maxTokenLifetimeSeconds: 1_800,
      },
      transport: { mode: "proxy", trustedProxies: [] },
    },
  };
}

describe("统一后台 API 固定装配", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPool.mockReturnValueOnce(mocks.controlPool).mockReturnValueOnce(mocks.skillPool);
    mocks.probePostgres.mockResolvedValue(undefined);
    mocks.probePublisher.mockResolvedValue(undefined);
  });

  it("单 listener 同时装配控制面与 Skill 发布资源，并保持两个 PG 角色", async () => {
    const running = await startDevelopmentAdminControlApiProcess(configuration());
    try {
      expect(mocks.createPool).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          expectedRuntimeRole: "admin_control",
          applicationName: "hoox-admin-control-api-development",
        }),
      );
      expect(mocks.createPool).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          expectedRuntimeRole: "skill_publisher",
          applicationName: "hoox-admin-control-api-development-skill-publisher",
        }),
      );
      expect(mocks.adminRepositoryConstructed).toHaveBeenCalledWith(mocks.controlPool);
      expect(mocks.agentRepositoryConstructed).toHaveBeenCalledWith(mocks.controlPool);
      // Run 浏览器只使用 Admin Control 连接，不借用 Skill Publisher 角色。
      expect(mocks.runExplorerRepositoryConstructed).toHaveBeenCalledWith(mocks.controlPool);
      expect(mocks.authorizationConstructed).toHaveBeenCalledWith(mocks.skillPool);
      expect(mocks.publicationRepositoryConstructed).toHaveBeenCalledWith(
        mocks.skillPool,
        expect.anything(),
      );

      const firstCall = mocks.createApp.mock.calls[0] as
        | [AdminControlApiDependencies, unknown]
        | undefined;
      if (firstCall === undefined) throw new Error("未创建统一后台应用");
      const [dependencies] = firstCall;
      await expect(dependencies.control.overview("user_admin")).resolves.toMatchObject({
        runtimeEnvironment: "development",
      });
      expect(dependencies.skills.publications).toBeDefined();
      expect(dependencies.agents).toBeDefined();
      await dependencies.externalTools?.probe({
        actorUserId: "user_admin",
        draftId: "draft_1",
        expectedGeneration: 1,
      });
      expect(mocks.probeMcpEndpoint).toHaveBeenCalledWith(
        expect.objectContaining({ serverName: "srv" }),
        false,
      );
      expect(mocks.externalRepositoryConstructed).toHaveBeenCalledWith(mocks.controlPool);
      await expect(
        dependencies.auth.resolve({
          authorization: "Bearer unified-admin-token",
          requestId: "request-1",
        }),
      ).resolves.toEqual({ userId: "user_admin" });
      expect(mocks.app.listen).toHaveBeenCalledTimes(1);
      expect(mocks.app.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 3_003 });
      expect(mocks.probePostgres).toHaveBeenCalledWith(mocks.controlPool, "admin_control");
      expect(mocks.probePostgres).toHaveBeenCalledWith(mocks.skillPool, "skill_publisher");
      expect(mocks.probePublisher.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.app.listen.mock.invocationCallOrder[0] ?? 0,
      );
    } finally {
      await running.close();
    }
    expect(mocks.app.close).toHaveBeenCalledTimes(1);
    expect(mocks.publisherClose).toHaveBeenCalledTimes(1);
    expect(mocks.controlPool.end).toHaveBeenCalledTimes(1);
    expect(mocks.skillPool.end).toHaveBeenCalledTimes(1);
  });

  it("生产用同一套管理 JWT/TLS listener 装配两组带 SSL 的数据库连接", async () => {
    const running = await startProductionAdminControlApiProcess(productionConfiguration());
    try {
      expect(mocks.createPool).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ ssl: { rejectUnauthorized: true } }),
      );
      expect(mocks.createPool).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ ssl: { rejectUnauthorized: true } }),
      );
      const firstCall = mocks.createApp.mock.calls[0] as
        | [AdminControlApiDependencies, { readonly logger?: boolean }]
        | undefined;
      if (firstCall === undefined) throw new Error("未创建生产统一后台应用");
      await expect(firstCall[0].control.overview("user_admin")).resolves.toMatchObject({
        runtimeEnvironment: "production",
      });
      await firstCall[0].externalTools?.probe({
        actorUserId: "user_admin",
        draftId: "draft_1",
        expectedGeneration: 1,
      });
      expect(mocks.probeMcpEndpoint).toHaveBeenCalledWith(
        expect.objectContaining({ serverName: "srv" }),
        true,
      );
      expect(mocks.externalRepositoryConstructed).toHaveBeenCalledWith(mocks.controlPool);
      expect(firstCall[1]).toEqual(expect.objectContaining({ logger: true }));
      expect(mocks.app.listen).toHaveBeenCalledTimes(1);
    } finally {
      await running.close();
    }
  });

  it("Skill PG 角色探针失败时不携带 S3 凭据探测对象存储，也不监听", async () => {
    mocks.probePostgres.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("unsafe"));

    await expect(startDevelopmentAdminControlApiProcess(configuration())).rejects.toThrow(
      "ASSEMBLY_FAILED:admin-control-api",
    );
    expect(mocks.probePublisher).not.toHaveBeenCalled();
    expect(mocks.app.listen).not.toHaveBeenCalled();
    expect(mocks.publisherClose).toHaveBeenCalledTimes(1);
    expect(mocks.controlPool.end).toHaveBeenCalledTimes(1);
    expect(mocks.skillPool.end).toHaveBeenCalledTimes(1);
  });
});
