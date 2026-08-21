import { timingSafeEqual } from "node:crypto";
import {
  AdminControlService,
  type DeploymentSettingDescriptor,
  type MemoryProviderConfiguration,
  type ModelProviderConfiguration,
  type ProviderProbePort,
} from "@hoox/admin-control";
import {
  type AuthContextResolver,
  createProductionJwtAuthResolver,
  loadProductionTlsCredentials,
  productionTrustProxy,
} from "@hoox/api";
import { userId } from "@hoox/domain";
import { createPostgresPool, PgAdminControlRepository, probePostgres } from "@hoox/persistence";
import {
  type ProcessSignalSource,
  type ServiceAssemblyFactory,
  startServiceProcess,
} from "@hoox/process-runtime";
import { createAdminControlApiApp, type AdminControlApiAppOptions } from "./app.js";
import { createPiModelCatalog } from "./pi-model-catalog.js";
import type { AdminControlApiProcessConfiguration } from "./process-entry.js";

interface ProcessOptions {
  readonly signalSource?: ProcessSignalSource;
  readonly onShutdownFailure?: (error: Error) => void;
}

const productionAssembler: ServiceAssemblyFactory<AdminControlApiProcessConfiguration> = {
  async assemble(configuration) {
    if (
      configuration.runtimeEnvironment !== "production" ||
      configuration.production === undefined ||
      configuration.developmentAuth !== undefined ||
      configuration.databaseAdminControlRole === undefined ||
      configuration.databaseSsl === undefined
    ) {
      throw new Error("PRODUCTION_ADMIN_CONTROL_ASSEMBLY_FORBIDDEN");
    }
    const tls = await loadProductionTlsCredentials(configuration.production.transport);
    return assembleRealService(configuration, {
      auth: createProductionJwtAuthResolver(configuration.production.jwt),
      appOptions: {
        logger: true,
        trustProxy: productionTrustProxy(configuration.production.transport),
        ...(tls === undefined ? {} : { https: tls }),
      },
      expectedRole: configuration.databaseAdminControlRole,
      applicationName: "hoox-admin-control-api-production",
    });
  },
};

const developmentAssembler: ServiceAssemblyFactory<AdminControlApiProcessConfiguration> = {
  async assemble(configuration) {
    if (
      configuration.runtimeEnvironment === "production" ||
      configuration.production !== undefined ||
      configuration.developmentAuth === undefined ||
      configuration.databaseSsl !== undefined
    ) {
      throw new Error("DEVELOPMENT_ADMIN_CONTROL_ASSEMBLY_FORBIDDEN");
    }
    return assembleRealService(configuration, {
      auth: developmentAuth(configuration),
      appOptions: { logger: false, trustProxy: false },
      ...(configuration.databaseAdminControlRole === undefined
        ? {}
        : { expectedRole: configuration.databaseAdminControlRole }),
      applicationName: "hoox-admin-control-api-development",
    });
  },
};

async function assembleRealService(
  configuration: AdminControlApiProcessConfiguration,
  input: {
    readonly auth: AuthContextResolver;
    readonly appOptions: AdminControlApiAppOptions;
    readonly expectedRole?: string;
    readonly applicationName: string;
  },
) {
  const pool = createPostgresPool({
    connectionString: configuration.databaseUrl,
    ...(configuration.databaseSsl === undefined ? {} : { ssl: configuration.databaseSsl }),
    schema: configuration.databaseSchema,
    ...(input.expectedRole === undefined ? {} : { expectedRuntimeRole: input.expectedRole }),
    applicationName: input.applicationName,
  });
  let app: ReturnType<typeof createAdminControlApiApp> | undefined;
  try {
    const repository = new PgAdminControlRepository(pool);
    const dependencies = {
      auth: input.auth,
      control: new AdminControlService(
        repository,
        repository,
        createProviderProbes(configuration),
        deploymentSettings(configuration),
      ),
      modelCatalog: createPiModelCatalog(),
      readiness: { probe: () => probePostgres(pool, input.expectedRole) },
    };
    app = createAdminControlApiApp(dependencies, input.appOptions);
    await dependencies.readiness.probe();
    await app.listen({ host: configuration.listenHost, port: configuration.listenPort });
    const listeningApp = app;
    return Object.freeze({
      stopAccepting: () => listeningApp.close(),
      resources: Object.freeze([{ name: "postgres", close: () => pool.end() }]),
      readiness: Object.freeze([{ name: "postgres", probe: dependencies.readiness.probe }]),
    });
  } catch (error) {
    if (app !== undefined) await app.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
}

export function createProviderProbes(
  configuration: AdminControlApiProcessConfiguration,
): ProviderProbePort {
  const assertAllowed = (value: string) => {
    const url = new URL(value);
    if (!configuration.providerHostAllowlist.has(url.hostname.toLowerCase())) {
      throw new Error("PROVIDER_HOST_NOT_ALLOWED");
    }
    return url;
  };
  return Object.freeze({
    probeModel: async (model: ModelProviderConfiguration) => {
      const base = assertAllowed(model.baseUrl);
      const endpoint = new URL("models", base.href.endsWith("/") ? base : `${base.href}/`);
      const response = await fetch(endpoint, {
        headers: { authorization: `Bearer ${configuration.providerSecrets.modelApiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error("MODEL_PROVIDER_UNAVAILABLE");
      const payload = JSON.parse(await readBoundedText(response, 64 * 1024)) as unknown;
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("data" in payload) ||
        !Array.isArray(payload.data)
      ) {
        throw new Error("MODEL_METADATA_MISMATCH");
      }
      const available = new Set(
        payload.data.flatMap((entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "id" in entry &&
          typeof entry.id === "string"
            ? [entry.id]
            : [],
        ),
      );
      if (
        !model.models.filter((candidate) => candidate.enabled).every(({ id }) => available.has(id))
      ) {
        throw new Error("MODEL_METADATA_MISMATCH");
      }
    },
    probeMemory: async (memory: MemoryProviderConfiguration) => {
      const apiKey = configuration.providerSecrets.memoryApiKey;
      if (apiKey === undefined) throw new Error("MEMORY_SECRET_UNAVAILABLE");
      const response = await fetch(assertAllowed(memory.baseUrl), {
        method: "HEAD",
        headers: { authorization: `Token ${apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(memory.requestTimeoutMs),
      });
      if (!response.ok) {
        throw new Error("MEMORY_PROVIDER_UNAVAILABLE");
      }
      await response.body?.cancel();
    },
  });
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
    }
    chunks.push(item.value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(merged);
}

function deploymentSettings(
  configuration: AdminControlApiProcessConfiguration,
): readonly DeploymentSettingDescriptor[] {
  return Object.freeze([
    descriptor(
      "ADMIN_CONTROL_DATABASE_URL",
      "bootstrap",
      true,
      "后台控制面数据库连接，仅部署时修改",
    ),
    descriptor(
      "DATABASE_ADMIN_CONTROL_ROLE",
      "bootstrap",
      configuration.databaseAdminControlRole !== undefined,
      "后台控制面最小权限数据库角色",
    ),
    descriptor(
      "ADMIN_CONTROL_JWT_SIGNING_KEYS",
      "secret",
      configuration.production !== undefined,
      "管理身份签名密钥，只能轮换部署",
    ),
    descriptor("MODEL_API_KEY", "secret", true, "模型 Provider 部署秘密，页面只保存引用"),
    descriptor(
      "MEM0_API_KEY",
      "secret",
      configuration.providerSecrets.memoryApiKey !== undefined,
      "记忆 Provider 部署秘密，页面只保存引用",
    ),
    descriptor(
      "MEM0_SCOPE_HMAC_KEY",
      "secret",
      configuration.runtimeDeploymentSettings.memoryScopeKeyConfigured,
      "Mem0 租户与用户作用域匿名化密钥，必须与 API Key 独立生成",
    ),
    descriptor(
      "ADMIN_CONTROL_PROVIDER_HOST_ALLOWLIST",
      "restart_required",
      configuration.providerHostAllowlist.size > 0,
      "允许执行连接探针的 Provider 主机白名单",
    ),
    descriptor(
      "THREAD_CONTEXT_COMPACTION_ENABLED",
      "restart_required",
      configuration.runtimeDeploymentSettings.compactionEnabledConfigured,
      "Runtime compaction 总开关；百分比和预算可版本化，该开关需要重新部署",
    ),
    descriptor(
      "THREAD_CONTEXT_COMPACTION_PATH",
      "restart_required",
      configuration.runtimeDeploymentSettings.compactionPathConfigured,
      "Runtime compaction 执行路径，需要重新部署",
    ),
    descriptor(
      "HISTORY_DIRECTORY_TIME_ZONE",
      "restart_required",
      configuration.runtimeDeploymentSettings.historyTimeZoneConfigured,
      "历史目录和定时任务时区，需要重新部署",
    ),
  ]);
}

function descriptor(
  key: string,
  category: DeploymentSettingDescriptor["category"],
  configured: boolean,
  description: string,
): DeploymentSettingDescriptor {
  return Object.freeze({
    key,
    category,
    source: "environment",
    configured,
    mutable: false,
    description,
  });
}

function developmentAuth(configuration: AdminControlApiProcessConfiguration): AuthContextResolver {
  if (
    configuration.runtimeEnvironment === "production" ||
    configuration.developmentAuth === undefined
  ) {
    throw new Error("DEVELOPMENT_ADMIN_CONTROL_AUTH_FORBIDDEN");
  }
  const accepted = Buffer.from(`Bearer ${configuration.developmentAuth.token}`, "utf8");
  const principal = Object.freeze({ userId: userId(configuration.developmentAuth.userId) });
  return Object.freeze({
    resolve: async (request: { readonly authorization: string | undefined }) => {
      if (request.authorization === undefined) return undefined;
      const presented = Buffer.from(request.authorization, "utf8");
      return presented.byteLength === accepted.byteLength && timingSafeEqual(presented, accepted)
        ? principal
        : undefined;
    },
  });
}

export function startProductionAdminControlApiProcess(
  configuration: AdminControlApiProcessConfiguration,
  options: ProcessOptions = {},
) {
  return startServiceProcess({
    serviceName: "admin-control-api",
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    assembler: productionAssembler,
    ...(options.signalSource === undefined ? {} : { signalSource: options.signalSource }),
    ...(options.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: options.onShutdownFailure }),
  });
}

export function startDevelopmentAdminControlApiProcess(
  configuration: AdminControlApiProcessConfiguration,
  options: ProcessOptions = {},
) {
  return startServiceProcess({
    serviceName: "admin-control-api",
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    assembler: developmentAssembler,
    ...(options.signalSource === undefined ? {} : { signalSource: options.signalSource }),
    ...(options.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: options.onShutdownFailure }),
  });
}
