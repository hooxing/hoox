import type {
  RuntimeControlConfigurationPort,
  RuntimeControlConfigurationSnapshot,
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

/** Run 首次解析会落不可变快照；同一 Run 的重试不能因 active 切换而更换 Provider。 */
export class RuntimeConfiguredSessionFactory implements AgentSessionFactoryPort {
  readonly toolRejectionReceiptBarrier = "durable" as const;
  private readonly factories = new Map<string, Promise<AgentSessionFactoryPort>>();

  constructor(
    private readonly fallback: AgentSessionFactoryPort,
    private readonly configurations: RuntimeControlConfigurationPort,
    private readonly build: (
      snapshot: RuntimeControlConfigurationSnapshot,
    ) => Promise<AgentSessionFactoryPort>,
  ) {}

  async create(input: SessionCreateInput): Promise<WorkerAgentSessionPort> {
    const snapshot = await this.configurations.resolveForRun({
      tenantId: input.scope.tenantId,
      runId: input.scope.runId,
    });
    if (snapshot === undefined) return await this.fallback.create(input);
    const key = [
      snapshot.model.configuration.providerKey,
      snapshot.model.revision,
      snapshot.runtimeSettings?.revision ?? 0,
    ].join(":");
    let factory = this.factories.get(key);
    if (factory === undefined) {
      factory = this.build(snapshot);
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
