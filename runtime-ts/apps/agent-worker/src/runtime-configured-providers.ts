import {
  defaultModelConfiguration,
  type RunCompactionSettings,
  type RunCompactionSettingsPort,
  type RuntimeControlConfigurationPort,
  type RuntimeControlConfigurationSnapshot,
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
import type { AgentSessionFactoryPort, WorkerAgentSessionPort } from "@hoox/run-contracts";

type SessionCreateInput = Parameters<AgentSessionFactoryPort["create"]>[0];

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
    ) => Promise<AgentSessionFactoryPort>,
  ) {}

  async create(input: SessionCreateInput): Promise<WorkerAgentSessionPort> {
    const snapshot = await this.configurations.resolveForRun({
      tenantId: input.scope.tenantId,
      runId: input.scope.runId,
    });
    const modelMaxOutputTokens =
      snapshot === undefined
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
    const key = [
      snapshot?.model.configuration.providerKey ?? "deployment",
      snapshot?.model.revision ?? 0,
      compactionSettings.softLimitPercent,
      compactionSettings.targetPercent,
      compactionSettings.recentUserTokens,
      compactionSettings.maxOutputTokens,
      compactionSettings.timeoutMs,
    ].join(":");
    let factory = this.factories.get(key);
    if (factory === undefined) {
      factory = this.build(snapshot, compactionSettings);
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
    if (memory === undefined || !memory.configuration.enabled) return undefined;
    if (this.deploymentSecrets === undefined) throw new Error("MEMORY_DEPLOYMENT_SECRETS_MISSING");
    const key = `${memory.configuration.providerKey}:${memory.revision}`;
    let provider = this.providers.get(key);
    if (provider === undefined) {
      provider = new Mem0PlatformMemoryProvider({
        baseUrl: memory.configuration.baseUrl,
        apiKey: this.deploymentSecrets.apiKey,
        scopeHmacKey: this.deploymentSecrets.scopeHmacKey,
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
