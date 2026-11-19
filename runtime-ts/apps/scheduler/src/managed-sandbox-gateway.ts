import type { PgSandboxConfigurationResolver } from "@hoox/persistence/admin";
import {
  createConfiguredSandboxGateway,
  type SandboxProviderKey,
  type SandboxProviderRegistry,
} from "@hoox/sandbox";

type ResolvedSandboxProfile = NonNullable<
  Awaited<ReturnType<PgSandboxConfigurationResolver["resolve"]>>
>;

export class ManagedSandboxGatewayResolver {
  constructor(
    private readonly configurations: PgSandboxConfigurationResolver,
    private readonly fallback: SandboxProviderRegistry,
    private readonly timeoutMs: number,
  ) {}
  private resolve(profile: ResolvedSandboxProfile | undefined, providerKey: SandboxProviderKey) {
    if (profile === undefined)
      return { gateway: this.fallback.require(providerKey), timeoutMs: this.timeoutMs };
    if (profile.configuration.providerKey !== providerKey)
      throw new Error("持久沙箱供应商绑定不一致");
    const { endpoint, policy } = profile.configuration;
    return {
      gateway: createConfiguredSandboxGateway({
        providerKey,
        endpoint,
        ...(profile.configuration.cubeProxy === undefined
          ? {}
          : { cubeProxy: profile.configuration.cubeProxy }),
        ...(profile.apiKey === undefined ? {} : { apiKey: profile.apiKey }),
        operationTimeoutMs: policy.operationTimeoutMs,
        sessionTtlSeconds: policy.sessionTtlSeconds,
      }),
      timeoutMs: policy.lifecycleTimeoutMs,
    };
  }
  async registry(input: {
    tenantId?: string;
    registryId: string;
    providerKey: SandboxProviderKey;
  }) {
    if (!input.tenantId) throw new Error("沙箱清理缺少租户身份");
    return this.resolve(
      await this.configurations.resolve({ tenantId: input.tenantId, registryId: input.registryId }),
      input.providerKey,
    );
  }
  async session(input: { tenantId: string; sessionId: string; providerKey: SandboxProviderKey }) {
    return this.resolve(await this.configurations.resolveSession(input), input.providerKey);
  }
  async isConfigured(): Promise<boolean> {
    const profiles = await this.configurations.activeProfiles();
    return profiles === undefined ? this.fallback.keys().length > 0 : profiles.length > 0;
  }
  async probe() {
    const profiles = await this.configurations.activeProfiles();
    if (profiles === undefined) return this.fallback.probe();
    if (profiles.length === 0) throw new Error("SANDBOX_CONFIGURATION_REQUIRED");
    for (const profile of profiles)
      await this.resolve(profile, profile.configuration.providerKey).gateway.probe();
  }
}
