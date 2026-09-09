import { createHash } from "node:crypto";

export type ManagedSandboxProviderKey = "cube" | "e2b" | "tencent-ags";

export interface SandboxProviderPolicy {
  readonly templateId: string;
  readonly sessionTtlSeconds: number;
  readonly operationTimeoutMs: number;
  readonly lifecycleTimeoutMs: number;
  readonly pausedRetentionSeconds: number;
  readonly idleAction: "pause" | "kill";
}

export interface SandboxProviderProfile {
  readonly providerKey: ManagedSandboxProviderKey;
  readonly displayName: string;
  readonly endpoint: string;
  readonly credentialConfigured: boolean;
  readonly policy: SandboxProviderPolicy;
}

export interface SandboxProviderProfileRevision {
  readonly revision: number;
  readonly configuration: SandboxProviderProfile;
  readonly createdAt: string;
}

export interface SandboxRoutingTarget {
  readonly providerKey: ManagedSandboxProviderKey;
  readonly profileRevision: number;
  readonly weight: number;
}

export interface SandboxRoutingConfiguration {
  readonly mode: "single" | "weighted";
  readonly targets: readonly SandboxRoutingTarget[];
}

export interface SandboxControlConfiguration {
  readonly generation: number;
  readonly routing: SandboxRoutingConfiguration | undefined;
  readonly profiles: readonly SandboxProviderProfileRevision[];
}

export function normalizeSandboxProviderProfile(
  input: SandboxProviderProfile,
): SandboxProviderProfile {
  const providerKey = normalizeSandboxProviderKey(input.providerKey);
  const displayName = text(input.displayName, 120);
  const endpoint = text(input.endpoint, 2048);
  // 连接地址属于供应商身份；凭据只能通过独立写入字段传递，不能藏在 URL 中。
  if (providerKey === "cube") {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new TypeError("沙箱服务地址无效");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new TypeError("沙箱服务地址不能包含凭据、查询或片段");
    }
  } else if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(endpoint)) {
    throw new TypeError("E2B 兼容沙箱域名不能包含协议、路径或凭据");
  }
  if (typeof input.credentialConfigured !== "boolean") throw new TypeError("沙箱凭据状态无效");
  const policy = input.policy;
  if (!policy || !["pause", "kill"].includes(policy.idleAction))
    throw new TypeError("沙箱空闲策略无效");
  return Object.freeze({
    providerKey,
    displayName,
    endpoint,
    credentialConfigured: input.credentialConfigured,
    policy: Object.freeze({
      templateId: text(policy.templateId, 255),
      sessionTtlSeconds: integer(policy.sessionTtlSeconds, 1, 86400),
      operationTimeoutMs: integer(policy.operationTimeoutMs, 1000, 600000),
      lifecycleTimeoutMs: integer(policy.lifecycleTimeoutMs, 1000, 600000),
      pausedRetentionSeconds: integer(policy.pausedRetentionSeconds, 0, 2592000),
      idleAction: policy.idleAction,
    }),
  });
}

export function normalizeSandboxRoutingConfiguration(
  input: SandboxRoutingConfiguration,
): SandboxRoutingConfiguration {
  if (!input || !["single", "weighted"].includes(input.mode) || !Array.isArray(input.targets)) {
    throw new TypeError("沙箱分配策略无效");
  }
  if (
    input.targets.length < 1 ||
    input.targets.length > 3 ||
    (input.mode === "single" && input.targets.length !== 1)
  ) {
    throw new TypeError("单供应商模式必须选择一个目标，多供应商模式最多选择三个目标");
  }
  const seen = new Set<ManagedSandboxProviderKey>();
  const targets = input.targets.map((target) => {
    const providerKey = normalizeSandboxProviderKey(target.providerKey);
    if (seen.has(providerKey)) throw new TypeError("沙箱分配目标不能重复");
    seen.add(providerKey);
    return Object.freeze({
      providerKey,
      profileRevision: integer(target.profileRevision, 1, Number.MAX_SAFE_INTEGER),
      weight: integer(target.weight, 1, 1000),
    });
  });
  return Object.freeze({ mode: input.mode, targets: Object.freeze(targets) });
}

/** 只分配新实例。稳定分配键使同次创建重试不换供应商；已有实例必须使用持久绑定。 */
export function selectSandboxRoutingTarget(
  configuration: SandboxRoutingConfiguration,
  allocationKey: string,
): SandboxRoutingTarget {
  const normalized = normalizeSandboxRoutingConfiguration(configuration);
  if (!allocationKey) throw new TypeError("沙箱分配键不能为空");
  const total = normalized.targets.reduce((sum, target) => sum + target.weight, 0);
  let bucket =
    (createHash("sha256").update(allocationKey).digest().readUInt32BE(0) / 0x100000000) * total;
  for (const target of normalized.targets) {
    bucket -= target.weight;
    if (bucket < 0) return target;
  }
  throw new Error("沙箱分配目标缺失");
}

export function normalizeSandboxProviderKey(value: string): ManagedSandboxProviderKey {
  if (value !== "cube" && value !== "e2b" && value !== "tencent-ags")
    throw new TypeError("沙箱供应商无效");
  return value;
}

function text(value: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !value ||
    value.length > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new TypeError("沙箱配置文本无效");
  }
  return value;
}

function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError("沙箱配置数值超出范围");
  return value;
}
