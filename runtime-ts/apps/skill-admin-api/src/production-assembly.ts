import { timingSafeEqual } from "node:crypto";
import {
  type AuthContextResolver,
  createProductionJwtAuthResolver,
  loadProductionTlsCredentials,
  productionTrustProxy,
} from "@hoox/api";
import { userId } from "@hoox/domain";
import {
  createPostgresPool,
  PgSkillPublicationAuthorization,
  PgSkillPublicationRepository,
  probePostgres,
  probeS3StableSkillPublisher,
  S3StableSkillPublisher,
} from "@hoox/persistence";
import {
  type ProcessSignalSource,
  type ServiceAssemblyFactory,
  startServiceProcess,
} from "@hoox/process-runtime";
import { SkillPublicationService } from "@hoox/skill";
import {
  createSkillAdminApiApp,
  type SkillAdminApiAppOptions,
  type SkillAdminApiDependencies,
} from "./app.js";
import type { SkillAdminApiProcessConfiguration } from "./process-entry.js";

interface ProcessOptions {
  readonly signalSource?: ProcessSignalSource;
  readonly onShutdownFailure?: (error: Error) => void;
}

/** 生产组合根固定创建专用 publisher PG pool、稳定 S3 publisher、JWT 与 TLS listener。 */
const productionSkillAdminApiAssembler: ServiceAssemblyFactory<SkillAdminApiProcessConfiguration> =
  {
    async assemble(configuration) {
      if (
        configuration.runtimeEnvironment !== "production" ||
        configuration.production === undefined ||
        configuration.developmentAuth !== undefined ||
        configuration.databaseSkillPublisherRole === undefined ||
        configuration.databaseSsl === undefined
      ) {
        throw new Error("PRODUCTION_SKILL_ADMIN_API_ASSEMBLY_FORBIDDEN");
      }
      const tls = await loadProductionTlsCredentials(configuration.production.transport);
      return assembleRealService(configuration, {
        auth: createProductionJwtAuthResolver(configuration.production.jwt),
        appOptions: {
          logger: true,
          trustProxy: productionTrustProxy(configuration.production.transport),
          ...(tls === undefined ? {} : { https: tls }),
        },
        expectedPublisherRole: configuration.databaseSkillPublisherRole,
        applicationName: "hoox-skill-admin-api-production",
      });
    },
  };

const developmentSkillAdminApiAssembler: ServiceAssemblyFactory<SkillAdminApiProcessConfiguration> =
  {
    async assemble(configuration) {
      if (
        configuration.runtimeEnvironment === "production" ||
        configuration.production !== undefined ||
        configuration.developmentAuth === undefined ||
        configuration.databaseSsl !== undefined
      ) {
        throw new Error("DEVELOPMENT_SKILL_ADMIN_API_ASSEMBLY_FORBIDDEN");
      }
      return assembleRealService(configuration, {
        auth: createDevelopmentAuthResolver(configuration),
        appOptions: { logger: false, trustProxy: false },
        ...(configuration.databaseSkillPublisherRole === undefined
          ? {}
          : { expectedPublisherRole: configuration.databaseSkillPublisherRole }),
        applicationName: "hoox-skill-admin-api-development",
      });
    },
  };

async function assembleRealService(
  configuration: SkillAdminApiProcessConfiguration,
  input: Readonly<{
    readonly auth: AuthContextResolver;
    readonly appOptions: SkillAdminApiAppOptions;
    readonly expectedPublisherRole?: string;
    readonly applicationName: string;
  }>,
) {
  const pool = createPostgresPool({
    connectionString: configuration.databaseUrl,
    ...(configuration.databaseSsl === undefined ? {} : { ssl: configuration.databaseSsl }),
    schema: configuration.databaseSchema,
    ...(input.expectedPublisherRole === undefined
      ? {}
      : { expectedRuntimeRole: input.expectedPublisherRole }),
    applicationName: input.applicationName,
  });
  let publisher: S3StableSkillPublisher | undefined;
  let app: ReturnType<typeof createSkillAdminApiApp> | undefined;
  try {
    publisher = new S3StableSkillPublisher({
      endpoint: configuration.objectStorage.endpoint,
      bucket: configuration.objectStorage.bucket,
      region: configuration.objectStorage.region,
      accessKeyId: configuration.objectStorage.accessKeyId,
      secretAccessKey: configuration.objectStorage.secretAccessKey,
      forcePathStyle: configuration.objectStorage.forcePathStyle,
    });
    const activePublisher = publisher;
    const postgresProbe = () => probePostgres(pool, input.expectedPublisherRole);
    const objectStorageProbe = () => probeS3StableSkillPublisher(activePublisher);
    const dependencies: SkillAdminApiDependencies = {
      auth: input.auth,
      publications: new SkillPublicationService(
        new PgSkillPublicationAuthorization(pool),
        new PgSkillPublicationRepository(pool, activePublisher),
      ),
      readiness: Object.freeze({
        probe: async () => {
          // 角色或数据库安全边界失效时，不再使用发布凭据探测对象存储。
          await postgresProbe();
          await objectStorageProbe();
        },
      }),
    };
    app = createSkillAdminApiApp(dependencies, input.appOptions);

    // 专用发布角色必须先经 PG 权限探针；失败时不得再携带 S3 凭据访问远端。
    await postgresProbe();
    await objectStorageProbe();
    await app.listen({ host: configuration.listenHost, port: configuration.listenPort });
    const listeningApp = app;
    return Object.freeze({
      stopAccepting: () => listeningApp.close(),
      resources: Object.freeze([
        Object.freeze({ name: "object-storage", close: async () => activePublisher.close() }),
        Object.freeze({ name: "postgres", close: async () => pool.end() }),
      ]),
      readiness: Object.freeze([
        Object.freeze({ name: "postgres", probe: postgresProbe }),
        Object.freeze({ name: "object-storage", probe: objectStorageProbe }),
      ]),
    });
  } catch (error) {
    if (app !== undefined) await app.close().catch(() => undefined);
    if (publisher !== undefined) {
      try {
        publisher.close();
      } catch {
        // 启动失败路径继续释放 PG；S3 客户端关闭异常不能掩盖原始失败。
      }
    }
    await pool.end().catch(() => undefined);
    throw error;
  }
}

function createDevelopmentAuthResolver(
  configuration: SkillAdminApiProcessConfiguration,
): AuthContextResolver {
  if (
    configuration.runtimeEnvironment === "production" ||
    configuration.developmentAuth === undefined
  ) {
    throw new Error("DEVELOPMENT_SKILL_ADMIN_AUTH_FORBIDDEN");
  }
  const acceptedAuthorization = Buffer.from(
    `Bearer ${configuration.developmentAuth.token}`,
    "utf8",
  );
  const principal = Object.freeze({ userId: userId(configuration.developmentAuth.userId) });
  return Object.freeze({
    resolve: async (request: { readonly authorization: string | undefined }) => {
      if (request.authorization === undefined) return undefined;
      const presented = Buffer.from(request.authorization, "utf8");
      if (
        presented.byteLength !== acceptedAuthorization.byteLength ||
        !timingSafeEqual(presented, acceptedAuthorization)
      ) {
        return undefined;
      }
      return principal;
    },
  });
}

export function startProductionSkillAdminApiProcess(
  configuration: SkillAdminApiProcessConfiguration,
  options: ProcessOptions = {},
) {
  return startServiceProcess({
    serviceName: "skill-admin-api",
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    assembler: productionSkillAdminApiAssembler,
    ...(options.signalSource === undefined ? {} : { signalSource: options.signalSource }),
    ...(options.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: options.onShutdownFailure }),
  });
}

export function startDevelopmentSkillAdminApiProcess(
  configuration: SkillAdminApiProcessConfiguration,
  options: ProcessOptions = {},
) {
  return startServiceProcess({
    serviceName: "skill-admin-api",
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    assembler: developmentSkillAdminApiAssembler,
    ...(options.signalSource === undefined ? {} : { signalSource: options.signalSource }),
    ...(options.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: options.onShutdownFailure }),
  });
}
