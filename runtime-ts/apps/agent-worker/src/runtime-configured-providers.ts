import {
  normalizeRuntimeToolSelection,
  RUNTIME_TOOL_NAMES,
  type RuntimeToolName,
} from "@hoox/protocol";
import {
  defaultModelConfiguration,
  type ModelProviderConfiguration,
  type RunCompactionSettings,
  type RunCompactionSettingsPort,
  type RuntimeControlConfigurationPort,
  type RuntimeControlConfigurationSnapshot,
  type RuntimeSettingsConfiguration,
} from "@hoox/admin-control";
import {
  Mem0PlatformMemoryProvider,
  type MemoryIngestionSource,
  type MemoryProvider,
  type MemoryProviderResolver,
  type MemoryRetrievalSource,
  type MemoryRetriever,
  type RetrievedMemory,
} from "@hoox/memory";
import type {
  AgentSessionFactoryPort,
  RunAgentSnapshot,
  WorkerAgentSessionPort,
} from "@hoox/run-contracts";

export interface RuntimeModelProbeConfiguration {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly supportsImages: boolean;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

/** 探测当前可供新 Run 使用的模型；已发布配置读取或解密失败时不得回退到部署凭据。 */
export async function resolveRuntimeModelProbeConfiguration(
  deployment: RuntimeModelProbeConfiguration,
  configurations: {
    resolveActiveModelConfiguration(): Promise<
      { readonly configuration: ModelProviderConfiguration; readonly apiKey: string } | undefined
    >;
  },
): Promise<RuntimeModelProbeConfiguration> {
  const active = await configurations.resolveActiveModelConfiguration();
  if (active === undefined) return deployment;
  const model = defaultModelConfiguration(active.configuration);
  return {
    baseUrl: active.configuration.baseUrl,
    apiKey: active.apiKey,
    modelId: model.id,
    supportsImages: model.input.includes("image"),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
  };
}

type SessionCreateInput = Parameters<AgentSessionFactoryPort["create"]>[0];

interface RunToolPolicy {
  readonly toolCallingMode: "native" | "ptc";
  readonly enabledTools?: readonly RuntimeToolName[];
}

function resolveRunToolPolicy(
  tools: RunAgentSnapshot["content"]["tools"],
  platform?: RuntimeSettingsConfiguration,
): RunToolPolicy {
  const enabledTools = normalizeRuntimeToolSelection(platform?.enabledTools);
  if (tools.mode === "platform_default") {
    return {
      toolCallingMode: platform?.toolCallingMode ?? "native",
      ...(enabledTools === undefined ? {} : { enabledTools }),
    };
  }
  return {
    toolCallingMode: tools.toolCallingMode,
    enabledTools: (enabledTools ?? RUNTIME_TOOL_NAMES).filter((name) =>
      tools.builtinTools.includes(name),
    ),
  };
}

/** 已托管模型的 Run 按不可变快照恢复；部署回退模型仍由启动配置决定。 */
export class RuntimeConfiguredSessionFactory implements AgentSessionFactoryPort {
  readonly toolRejectionReceiptBarrier = "durable" as const;
  private readonly factories = new Map<string, Promise<AgentSessionFactoryPort>>();

  constructor(
    private readonly configurations: RuntimeControlConfigurationPort,
    private readonly compactionSettings: RunCompactionSettingsPort,
    private readonly deploymentCompactionSettings: RunCompactionSettings,
    private readonly deploymentModelMaxOutputTokens: number,
    private readonly build: (
      snapshot: RuntimeControlConfigurationSnapshot | undefined,
      compactionSettings: RunCompactionSettings,
      tools: RunToolPolicy,
    ) => Promise<AgentSessionFactoryPort>,
  ) {}

  async create(input: SessionCreateInput): Promise<WorkerAgentSessionPort> {
    const snapshot = await this.configurations.resolveForRun({
      tenantId: input.scope.tenantId,
      runId: input.scope.runId,
    });
    const modelMaxOutputTokens =
      snapshot?.model === undefined
        ? this.deploymentModelMaxOutputTokens
        : defaultModelConfiguration(snapshot.model.configuration).maxTokens;
    const savedCompactionSettings = await this.compactionSettings.resolveForRun({
      tenantId: input.scope.tenantId,
      runId: input.scope.runId,
      // 新快照记录本 Run 固定模型可接受的实际预算；仓储仍优先恢复历史快照。
      deploymentSettings: {
        ...this.deploymentCompactionSettings,
        maxOutputTokens: Math.min(
          this.deploymentCompactionSettings.maxOutputTokens,
          modelMaxOutputTokens,
        ),
      },
    });
    // 旧部署回退 Run 尚无模型快照，重启后的模型可能变小；保留持久值，仅约束执行预算。
    const compactionSettings = {
      ...savedCompactionSettings,
      maxOutputTokens: Math.min(savedCompactionSettings.maxOutputTokens, modelMaxOutputTokens),
    };
    const tools = resolveRunToolPolicy(
      input.agentSnapshot.content.tools,
      snapshot?.runtimeSettings?.configuration,
    );
    const key = [
      tools.toolCallingMode,
      tools.enabledTools === undefined ? "default-tools" : JSON.stringify(tools.enabledTools),
      snapshot?.model?.configuration.providerKey ?? "deployment",
      snapshot?.model?.revision ?? 0,
      compactionSettings.softLimitPercent,
      compactionSettings.targetPercent,
      compactionSettings.recentUserTokens,
      compactionSettings.maxOutputTokens,
      compactionSettings.timeoutMs,
    ].join(":");
    let factory = this.factories.get(key);
    if (factory === undefined) {
      factory = this.build(snapshot, compactionSettings, tools);
      this.factories.set(key, factory);
      factory.catch(() => this.factories.delete(key));
      if (this.factories.size > 16)
        this.factories.delete(this.factories.keys().next().value ?? key);
    }
    return await (await factory).create(input);
  }
}

export interface RuntimeMemoryDeploymentSecrets {
  readonly apiKey: string;
  readonly scopeHmacKey: string;
}

/** Retrieval 与异步 ingestion 都按 claim/run 重新解析快照，进程重启后仍能得到同一 revision。 */
export class RuntimeConfiguredMemoryProvider implements MemoryRetriever, MemoryProviderResolver {
  private readonly providers = new Map<string, Mem0PlatformMemoryProvider>();

  constructor(
    private readonly configurations: RuntimeControlConfigurationPort,
    private readonly deploymentSecrets: RuntimeMemoryDeploymentSecrets | undefined,
    private readonly fallback?: Mem0PlatformMemoryProvider,
    private readonly platformScopeHmacKey?: string,
  ) {}

  async resolve(
    source: MemoryIngestionSource | MemoryRetrievalSource,
  ): Promise<MemoryProvider | undefined> {
    const snapshot = await this.configurations.resolveForRun({
      tenantId: source.tenantId,
      runId: source.runId,
    });
    if (snapshot === undefined) return this.fallback;
    const memory = snapshot.memory;
    if (memory === undefined) return snapshot.model === undefined ? this.fallback : undefined;
    if (!memory.configuration.enabled) return undefined;
    const apiKey =
      memory.configuration.apiSecretRef === "managed:memory-api"
        ? snapshot.memoryApiKey
        : this.deploymentSecrets?.apiKey;
    // 优先保留既有隔离密钥，接管 API Key 不能改变已有用户的记忆命名空间。
    const scopeHmacKey =
      this.deploymentSecrets?.scopeHmacKey ??
      (memory.configuration.scopeSecretRef === "platform:memory-scope"
        ? this.platformScopeHmacKey
        : undefined);
    if (apiKey === undefined || scopeHmacKey === undefined)
      throw new Error("MEMORY_DEPLOYMENT_SECRETS_MISSING");
    const key = `${memory.configuration.providerKey}:${memory.revision}`;
    let provider = this.providers.get(key);
    if (provider === undefined) {
      provider = new Mem0PlatformMemoryProvider({
        baseUrl: memory.configuration.baseUrl,
        apiKey,
        scopeHmacKey,
        timeoutMs: memory.configuration.requestTimeoutMs,
      });
      this.providers.set(key, provider);
      if (this.providers.size > 16)
        this.providers.delete(this.providers.keys().next().value ?? key);
    }
    return provider;
  }

  async retrieve(source: MemoryRetrievalSource): Promise<readonly RetrievedMemory[]> {
    const provider = await this.resolve(source);
    if (provider === undefined || !("retrieve" in provider)) return Object.freeze([]);
    return await (provider as MemoryRetriever).retrieve(source);
  }
}
