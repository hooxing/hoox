import type { EnqueueOutboxPort, ThreadCreationPort } from "@cube-runtime/persistence";

const createCapabilityBrand: unique symbol = Symbol("ApiCreateCapability");
const issuedCapabilities = new WeakSet<object>();

export interface ApiCreateCapability {
  readonly threadCreation: ThreadCreationPort;
  readonly enqueueOutbox: EnqueueOutboxPort;
  readonly [createCapabilityBrand]: true;
}

/**
 * 只有调用方明确提供两项同事务能力时才开放创建路由；
 * 普通 Repository 不能被 API 静默拼装成非原子写入。
 */
export function createApiCreateCapability(input: {
  readonly threadCreation: ThreadCreationPort;
  readonly enqueueOutbox: EnqueueOutboxPort;
}): ApiCreateCapability {
  const capability = Object.freeze({ ...input, [createCapabilityBrand]: true as const });
  issuedCapabilities.add(capability);
  return capability;
}

/** 运行时签发校验可阻止配置文件或 `as` 断言伪造创建能力。 */
export function isApiCreateCapability(value: unknown): value is ApiCreateCapability {
  return typeof value === "object" && value !== null && issuedCapabilities.has(value);
}
