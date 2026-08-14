import { SandboxRuntimeError } from "./errors.js";
import type { OperationControl, SandboxGateway, SandboxProviderKey } from "./types.js";
import type {
  SandboxWorkspaceAdapterOptions,
  SandboxWorkspacePort,
  TrustedSandboxSessionCapability,
} from "./workspace-adapter.js";

export interface RuntimeSandboxGateway extends SandboxGateway {
  probe(): Promise<void>;
  connectWorkspace(
    capability: TrustedSandboxSessionCapability,
    options: SandboxWorkspaceAdapterOptions,
    control?: OperationControl,
  ): Promise<SandboxWorkspacePort>;
}

/** 部署级 Provider 注册表；不接受 Run/用户动态选择，也不做跨 Provider 自动故障转移。 */
export class SandboxProviderRegistry {
  private readonly gateways: ReadonlyMap<SandboxProviderKey, RuntimeSandboxGateway>;

  constructor(
    readonly defaultProviderKey: SandboxProviderKey,
    gateways: readonly RuntimeSandboxGateway[],
  ) {
    const indexed = new Map<SandboxProviderKey, RuntimeSandboxGateway>();
    for (const gateway of gateways) {
      if (indexed.has(gateway.providerKey)) {
        throw new SandboxRuntimeError("INVALID_ARGUMENT", "Sandbox Provider 重复注册");
      }
      indexed.set(gateway.providerKey, gateway);
    }
    if (!indexed.has(defaultProviderKey)) {
      throw new SandboxRuntimeError("INVALID_ARGUMENT", "默认 Sandbox Provider 未启用");
    }
    this.gateways = indexed;
  }

  default(): RuntimeSandboxGateway {
    return this.require(this.defaultProviderKey);
  }

  require(providerKey: SandboxProviderKey): RuntimeSandboxGateway {
    const gateway = this.gateways.get(providerKey);
    if (gateway === undefined) {
      throw new SandboxRuntimeError("INVALID_ARGUMENT", "Sandbox Provider 未启用");
    }
    return gateway;
  }

  async probe(): Promise<void> {
    await Promise.all([...this.gateways.values()].map((gateway) => gateway.probe()));
  }

  keys(): readonly SandboxProviderKey[] {
    return Object.freeze([...this.gateways.keys()]);
  }
}
